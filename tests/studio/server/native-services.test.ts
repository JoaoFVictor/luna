import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineInputAdapters } from "../../../src/adapters/registry.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { createNativeStudioServices } from "../../../src/studio/server/native-services.js";

const temporaryDirectories: string[] = [];

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

describe("native Studio service composition", () => {
  it("loads the platform once and exposes live catalogs plus canonical routing", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-native-project-");
    const configRoot = await temporaryDirectory("luna-studio-native-config-");
    await Promise.all([
      mkdir(path.join(projectRoot, "workflows")),
      mkdir(path.join(projectRoot, "agents"))
    ]);
    await writeFile(
      path.join(configRoot, "routing.yaml"),
      [
        "type: router",
        'version: "2026-06"',
        "rules:",
        "  - id: github",
        "    when:",
        '      expression: $.invocation.source = "github"',
        "    target: workflow:code-review",
        ""
      ].join("\n"),
      "utf8"
    );
    const services = await createNativeStudioServices({
      projectRoot,
      configRoot,
      stateRoot: path.join(configRoot, ".test-studio-state"),
      app: {
        workspace: {
          strategy: "git_worktree",
          root: ".worktrees",
          preserve_on_success: true,
          preserve_on_failure: true
        },
        artifacts: { root: ".runs" }
      },
      platform: nativeLunaPlatformRegistrations
    });
    const principal = {
      id: "local-user",
      authentication: "local-session"
    } as const;

    const signal = new AbortController().signal;
    const [
      library,
      agents,
      workflows,
      adapters,
      routing,
      simulation,
      expression,
      schema,
      runs
    ] =
      await Promise.all([
        services.queries.capabilities(principal),
        services.queries.agents(principal),
        services.queries.workflows(principal),
        services.inputRouting.listInputAdapters(principal),
        services.inputRouting.routingDefinition(principal),
        services.inputRouting.simulateRouting(
          principal,
          {
            invocation: {
              version: "2026-06",
              source: "github",
              event: "pull_request"
            }
          },
          signal
        ),
        services.expressions?.evaluateExpression(
          principal,
          { expression: "$.value + 1", fixture: { value: 1 } },
          signal
        ),
        services.schemas?.validateSchemaInstance(
          principal,
          { schema: { type: "string" }, instance: "valid" },
          signal
        ),
        services.runs?.catalog.list()
      ]);
    await services.dispose?.();

    expect(library.registrations.length).toBeGreaterThan(0);
    expect(agents).toMatchObject({ status: "complete", agents: [] });
    expect(workflows).toMatchObject({ status: "complete", workflows: [] });
    expect(adapters.adapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "github-pr-url",
          source: "github",
          preview: {
            enabled: true,
            effects: [
              "credential_read",
              "network_read",
              "process_execution"
            ],
            timeout_ms: 60_000
          }
        })
      ])
    );
    expect(routing.rules[0]?.id).toBe("github");
    expect(simulation).toMatchObject({
      status: "matched",
      target: { type: "workflow", id: "code-review" }
    });
    expect(expression).toEqual({
      status: "evaluated",
      result: { kind: "json", value: 2 },
      diagnostics: []
    });
    expect(schema).toEqual({ status: "valid", diagnostics: [] });
    expect(runs).toMatchObject({ items: [], next_cursor: null });
  });

  it("builds the default preview port from classified registry adapters", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-preview-project-");
    const configRoot = await temporaryDirectory("luna-studio-preview-config-");
    await Promise.all([
      mkdir(path.join(projectRoot, "workflows")),
      mkdir(path.join(projectRoot, "agents"))
    ]);
    await writeFile(
      path.join(configRoot, "routing.yaml"),
      [
        "type: router",
        'version: "2026-06"',
        "rules:",
        "  - id: local-safe",
        "    when:",
        '      expression: $.invocation.source = "local-safe"',
        "    target: workflow:classified-preview",
        ""
      ].join("\n"),
      "utf8"
    );
    const load = vi.fn(async () => ({
      version: "2026-06" as const,
      source: "local-safe",
      event: "manual",
      payload: { secret: "server-private" }
    }));
    const platform = {
      ...nativeLunaPlatformRegistrations,
      inputAdapterRegistry: defineInputAdapters([{
        id: "classified-preview",
        description: "Safe classified preview fixture",
        source: "local-safe",
        loadEffects: ["project_read"] as const,
        load
      }])
    };
    const services = await createNativeStudioServices({
      projectRoot,
      configRoot,
      stateRoot: path.join(configRoot, ".test-studio-state"),
      app: {
        workspace: {
          strategy: "git_worktree",
          root: ".worktrees",
          preserve_on_success: true,
          preserve_on_failure: true
        },
        artifacts: { root: ".runs" }
      },
      platform
    });
    const principal = {
      id: "local-user",
      authentication: "local-session"
    } as const;

    try {
      expect(services.inputRouting.listInputAdapters(principal)).toMatchObject({
        adapters: [{
          id: "classified-preview",
          preview: {
            enabled: true,
            effects: ["project_read"],
            timeout_ms: 60_000
          }
        }]
      });
      const preview = await services.inputRouting.previewInputRoute(
        principal,
        {
          adapter_id: "classified-preview",
          input: { kind: "cli", value: "opaque" },
          acknowledged_effects: ["project_read"]
        },
        new AbortController().signal
      );
      expect(preview).toMatchObject({
        adapter: {
          adapter_id: "classified-preview",
          redacted_fields: ["payload"]
        },
        routing: {
          status: "matched",
          target: { type: "workflow", id: "classified-preview" }
        }
      });
      expect(JSON.stringify(preview)).not.toContain("server-private");
      expect(load).toHaveBeenCalledOnce();
    } finally {
      await services.dispose?.();
    }
  });

  it("reconciles external runs created before and while Studio is active", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-run-reconcile-project-");
    const configRoot = await temporaryDirectory("luna-studio-run-reconcile-config-");
    const artifactsRoot = path.join(projectRoot, ".runs");
    await Promise.all([
      mkdir(path.join(projectRoot, "workflows")),
      mkdir(path.join(projectRoot, "agents")),
      mkdir(artifactsRoot)
    ]);
    await writeFile(
      path.join(configRoot, "routing.yaml"),
      [
        "type: router",
        'version: "2026-06"',
        "rules: []",
        ""
      ].join("\n"),
      "utf8"
    );
    const writeExternalRun = async (runId: string) => {
      const directory = path.join(artifactsRoot, runId);
      await mkdir(directory);
      await writeFile(
        path.join(directory, "observability-summary.json"),
        JSON.stringify({
          schema_version: 2,
          run_id: runId,
          workflow_id: "external-workflow",
          trace_id: "not-projected"
        }),
        "utf8"
      );
    };
    await writeExternalRun("external-before-studio");

    const services = await createNativeStudioServices({
      projectRoot,
      configRoot,
      stateRoot: path.join(configRoot, ".test-studio-state"),
      app: {
        workspace: {
          strategy: "git_worktree",
          root: ".worktrees",
          preserve_on_success: true,
          preserve_on_failure: true
        },
        artifacts: { root: ".runs" }
      },
      platform: nativeLunaPlatformRegistrations,
      historicalRunReconciliation: { intervalMs: 10 }
    });

    try {
      expect(await services.runs?.catalog.get("external-before-studio"))
        .toMatchObject({
          record: {
            run_id: "external-before-studio",
            workflow_id: "external-workflow",
            dispatch_status: "historical_unknown",
            lifecycle_projection: "unknown",
            completeness: "legacy"
          },
          status: "historical_unknown"
        });
      const beforeStudio = await services.runs?.catalog.get(
        "external-before-studio"
      );
      expect(beforeStudio?.record.artifact_count).toBeUndefined();
      expect(beforeStudio?.record.interrupt_count).toBeUndefined();
      expect(beforeStudio?.wall_duration_ms).toBeUndefined();
      const historicalPage = await services.runs?.catalog.list({
        filters: { statuses: ["historical_unknown"] }
      });
      expect(historicalPage?.items).toHaveLength(1);
      expect(historicalPage?.items[0]).toMatchObject({
        run_id: "external-before-studio",
        status: "historical_unknown"
      });
      expect(historicalPage?.items[0]).not.toHaveProperty("artifact_count");
      expect(historicalPage?.items[0]).not.toHaveProperty("interrupt_count");
      expect(historicalPage?.items[0]).not.toHaveProperty("wall_duration_ms");

      await writeExternalRun("external-while-studio-active");
      await vi.waitFor(async () => {
        expect(await services.runs?.catalog.get("external-while-studio-active"))
          .toMatchObject({
            record: {
              run_id: "external-while-studio-active",
              completeness: "legacy"
            }
          });
      }, { timeout: 1_000, interval: 10 });
      const active = await services.runs?.catalog.get(
        "external-while-studio-active"
      );
      expect(active?.record.run_status).toBeUndefined();
      expect(active?.record.finished_at).toBeUndefined();
      expect(active?.record.artifact_count).toBeUndefined();
      expect(active?.record.interrupt_count).toBeUndefined();
      expect(active?.wall_duration_ms).toBeUndefined();
    } finally {
      const firstClose = services.dispose?.();
      const concurrentClose = services.dispose?.();
      expect(concurrentClose).toBe(firstClose);
      await firstClose;
    }
  });
});
