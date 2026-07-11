import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineInputAdapters } from "../../../src/adapters/registry.js";
import { createStudioConfigurationPosture } from "../../../src/studio/application/configuration/posture.js";
import { StudioProviderHealthTracker } from "../../../src/studio/application/inputs/provider-health.js";

const temporaryDirectories: string[] = [];
const SECRET_MODEL = "secret-provider/private-model";
const SECRET_REMOTE = "https://example.invalid/private-token-path";
const SECRET_REMOTE_NAME =
  "https://git-user:remote-credential-canary@example.invalid/repository.git";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Studio configuration posture", () => {
  it("projects model, repository, provider, and runtime posture without secrets", async () => {
    const projectRoot = await temporaryDirectory("luna-config-posture-project-");
    const configRoot = await temporaryDirectory("luna-config-posture-config-");
    const repository = path.join(projectRoot, "customer-private-repository");
    await mkdir(repository);
    await Promise.all([
      writeFile(
        path.join(configRoot, "models.yaml"),
        [
          "model_profiles:",
          "  deep:",
          "    model: ${PRIVATE_MODEL:-openai/deep}",
          "    reasoning_effort: high",
          "    transport: sse",
          ""
        ].join("\n"),
        "utf8"
      ),
      writeFile(
        path.join(configRoot, "repositories.yaml"),
        [
          "repositories:",
          "  - id: customer",
          "    provider: github",
          "    owner: acme",
          "    name: private",
          `    path: ${repository}`,
          "    remote: origin",
          "    expected_remote_urls:",
          `      - ${SECRET_REMOTE}`,
          "    skills:",
          "      - internal/reviewer/SKILL.md",
          ""
        ].join("\n"),
        "utf8"
      )
    ]);
    const inputAdapters = defineInputAdapters([
      {
        id: "github-pr-url",
        source: "github",
        description: "GitHub URL",
        load: async () => ({
          version: "2026-06" as const,
          source: "github",
          event: "pull_request"
        })
      }
    ]);
    const providerHealth = new StudioProviderHealthTracker({
      now: () => new Date("2026-07-11T12:00:00.000Z")
    });
    providerHealth.markHealthy("github", "github-pr-url");
    const posture = createStudioConfigurationPosture({
      projectRoot,
      configRoot,
      app: {
        workspace: {
          strategy: "git_worktree",
          root: ".runs/workspaces",
          preserve_on_success: true,
          preserve_on_failure: true
        },
        artifacts: { root: ".runs" },
        workflow_runtime: { id: "langgraph", options: { secret: "hidden" } },
        agent_runtime: { id: "pi", options: { token: "hidden" } },
        plugins: [{ module: "private-plugin-module" }]
      },
      env: { PRIVATE_MODEL: SECRET_MODEL },
      inputAdapters,
      providerHealth,
      agents: async () => ({
        status: "complete",
        fingerprint: `sha256:${"a".repeat(64)}`,
        agents: [
          {
            id: "reviewer",
            description: "Reviewer",
            mode: "read_only",
            model_profile: "deep",
            output_schema_reference: "agents/reviewer/output.schema.json",
            output_schema: { type: "object" },
            skills: [],
            tools: [],
            mcp_servers: [],
            subagents: [],
            runtime_requirements: [],
            runtime_order: [],
            revision: `sha256:${"b".repeat(64)}`
          }
        ],
        diagnostics: []
      }),
      workflows: async () => ({
        status: "complete",
        fingerprint: `sha256:${"c".repeat(64)}`,
        workflows: [
          {
            id: "review",
            mode: "read_only",
            revision: `sha256:${"d".repeat(64)}`,
            capabilities: [],
            registrations: [],
            agents: ["reviewer"],
            input_schema: "workflows/review/input.schema.json",
            output_schema: "workflows/review/output.schema.json",
            node_counts: {
              built_in: 0,
              agent: 1,
              pattern: 0,
              human_gate: 0
            },
            requires_repository: true,
            max_concurrency: 1
          }
        ],
        diagnostics: []
      })
    });

    const [models, repositories, providers, runtime] = await Promise.all([
      posture.models(),
      posture.repositories(),
      posture.providers(),
      posture.runtime()
    ]);

    expect(models.profiles).toEqual([
      {
        id: "deep",
        source: {
          kind: "environment",
          variable: "PRIVATE_MODEL",
          present: true,
          fallback_model: "openai/deep"
        },
        reasoning_effort: "high",
        transport: "sse",
        consumers: ["reviewer"]
      }
    ]);
    expect(repositories.repositories).toEqual([
      expect.objectContaining({
        id: "customer",
        path_display: "…/customer-private-repository",
        path_kind: "absolute_redacted",
        remote: { kind: "name", name: "origin" },
        expected_remote_count: 1,
        skills: ["reviewer/SKILL.md"],
        availability: "available",
        trusted_write_readiness: "not_assessed",
        required_by: ["review"]
      })
    ]);
    expect(providers.providers).toEqual([
      {
        id: "github",
        adapter_ids: ["github-pr-url"],
        credential_status: "verified_by_preview",
        checked_at: "2026-07-11T12:00:00.000Z",
        checked_adapter_id: "github-pr-url"
      }
    ]);
    expect(runtime).toEqual({
      editing: "read_only",
      workflow_runtime_id: "langgraph",
      agent_runtime_id: "pi",
      workspace_strategy: "git_worktree",
      plugin_count: 1,
      option_values_redacted: true
    });
    const serialized = JSON.stringify({
      models,
      repositories,
      providers,
      runtime
    });
    expect(serialized).not.toContain(SECRET_MODEL);
    expect(serialized).not.toContain(SECRET_REMOTE);
    expect(serialized).not.toContain(projectRoot);
    expect(serialized).not.toContain("private-plugin-module");
  });

  it("rejects a credential-bearing remote before posture projection", async () => {
    const projectRoot = await temporaryDirectory("luna-config-remote-project-");
    const configRoot = await temporaryDirectory("luna-config-remote-config-");
    await writeFile(
      path.join(configRoot, "repositories.yaml"),
      [
        "repositories:",
        "  - id: private",
        "    provider: github",
        "    owner: acme",
        "    name: private",
        "    path: ./private",
        `    remote: ${SECRET_REMOTE_NAME}`,
        ""
      ].join("\n"),
      "utf8"
    );
    const posture = createStudioConfigurationPosture({
      projectRoot,
      configRoot,
      inputAdapters: defineInputAdapters([]),
      agents: async () => ({
        status: "complete",
        fingerprint: `sha256:${"a".repeat(64)}`,
        agents: [],
        diagnostics: []
      }),
      workflows: async () => ({
        status: "complete",
        fingerprint: `sha256:${"b".repeat(64)}`,
        workflows: [],
        diagnostics: []
      })
    });

    const repositories = await posture.repositories();

    expect(repositories.repositories).toEqual([]);
    expect(repositories.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "configuration_repositories_unavailable"
      })
    ]);
    expect(JSON.stringify(repositories)).not.toContain(SECRET_REMOTE_NAME);
    expect(JSON.stringify(repositories)).not.toContain(
      "remote-credential-canary"
    );
  });

  it("marks consumer projections as partial when source catalogs are partial", async () => {
    const projectRoot = await temporaryDirectory("luna-config-partial-project-");
    const configRoot = await temporaryDirectory("luna-config-partial-config-");
    await Promise.all([
      writeFile(
        path.join(configRoot, "models.yaml"),
        "model_profiles:\n  fast:\n    model: openai/test\n    reasoning_effort: low\n",
        "utf8"
      ),
      writeFile(
        path.join(configRoot, "repositories.yaml"),
        "repositories: []\n",
        "utf8"
      )
    ]);
    const posture = createStudioConfigurationPosture({
      projectRoot,
      configRoot,
      inputAdapters: defineInputAdapters([]),
      agents: async () => ({
        status: "partial",
        fingerprint: `sha256:${"a".repeat(64)}`,
        agents: [],
        diagnostics: []
      }),
      workflows: async () => ({
        status: "partial",
        fingerprint: `sha256:${"b".repeat(64)}`,
        workflows: [],
        diagnostics: []
      })
    });

    await expect(posture.models()).resolves.toMatchObject({
      diagnostics: [
        {
          severity: "warning",
          code: "configuration_model_consumers_partial"
        }
      ]
    });
    await expect(posture.repositories()).resolves.toMatchObject({
      diagnostics: [
        {
          severity: "warning",
          code: "configuration_repository_consumers_partial"
        }
      ]
    });
  });

  it("degrades invalid model and repository files to redacted diagnostics", async () => {
    const projectRoot = await temporaryDirectory("luna-config-invalid-project-");
    const configRoot = await temporaryDirectory("luna-config-invalid-config-");
    await Promise.all([
      writeFile(path.join(configRoot, "models.yaml"), "secret: do-not-leak\n"),
      writeFile(
        path.join(configRoot, "repositories.yaml"),
        "secret: do-not-leak\n"
      )
    ]);
    const posture = createStudioConfigurationPosture({
      projectRoot,
      configRoot,
      inputAdapters: defineInputAdapters([]),
      agents: async () => {
        throw new Error("agent-secret-do-not-leak");
      },
      workflows: async () => {
        throw new Error("workflow-secret-do-not-leak");
      }
    });

    const models = await posture.models();
    const repositories = await posture.repositories();
    expect(models.profiles).toEqual([]);
    expect(repositories.repositories).toEqual([]);
    expect(JSON.stringify({ models, repositories })).not.toContain(
      "do-not-leak"
    );
  });
});
