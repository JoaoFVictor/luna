import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRuntimePort,
  RunAgentInput
} from "../../../src/core/agent-runtime/contracts.js";
import { loadAgentDefinition } from "../../../src/capabilities/agents/agent-loader.js";
import { agentDefinitionRevision } from "../../../src/capabilities/agents/agent-revision.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { MemoryStudioAgentTestConfirmations } from "../../../src/studio/adapters/memory/agent-test-confirmations.js";
import {
  NativeStudioAgentTestResolver,
  NativeStudioAgentTestRunner
} from "../../../src/studio/adapters/native/agent-test-bench.js";
import type { NativeStudioAgentTestDraftPort } from "../../../src/studio/adapters/native/agent-test-target.js";
import { studioAgentTestValueDigest } from "../../../src/studio/application/agents/test-bench-digests.js";
import { StudioAgentTestBenchService } from "../../../src/studio/application/agents/test-bench-service.js";
import type { StudioDraftItem } from "../../../src/studio/contracts/draft-authoring.js";
import type {
  StudioAgentTestPlanRequest,
  StudioAgentTestTarget
} from "../../../src/studio/contracts/agent-test-bench.js";
import type { AgentRuntimeFactory } from "../../../src/runtime/composition/runtime-composition.js";

const TOKEN = "n".repeat(43);
const NOW = Date.parse("2026-07-11T15:00:00.000Z");
const temporaryRoots: string[] = [];

const OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok"] }
  },
  required: ["status"],
  additionalProperties: false
}, null, 2);

function agentYaml(options: {
  readonly mode?: "read_only" | "trusted_local_write";
  readonly runtimeRequirements?: readonly string[];
  readonly modelProfile?: string;
  readonly tool?: string;
} = {}): string {
  const runtimeRequirements = options.runtimeRequirements ?? ["json_output"];
  return [
    "id: reviewer",
    "description: Reviews a bounded fixture.",
    `model_profile: ${options.modelProfile ?? "default"}`,
    `mode: ${options.mode ?? "read_only"}`,
    "instructions_file: instructions.md",
    "output_schema: output.schema.json",
    "skills:",
    "  - SKILL.md",
    "context:",
    "  files:",
    "    - CONTEXT.md",
    "tools:",
    `  - ${options.tool ?? "repository.read-file"}`,
    "mcp_servers:",
    "  - demo-mcp",
    "subagents:",
    "  - id: helper",
    "    policy:",
    "      mode: read_only",
    "runtime_requirements:",
    ...runtimeRequirements.map((requirement) => `  - ${requirement}`),
    ""
  ].join("\n");
}

const HELPER_YAML = [
  "id: helper",
  "description: Helper that is never invoked by the smoke test.",
  "model_profile: default",
  "mode: read_only",
  "instructions_file: instructions.md",
  "output_schema: output.schema.json",
  ""
].join("\n");

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

type NativeFixture = {
  readonly root: string;
  readonly projectRoot: string;
  readonly configRoot: string;
};

async function createNativeFixture(
  reviewerYaml = agentYaml()
): Promise<NativeFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-native-agent-test-"));
  temporaryRoots.push(root);
  const projectRoot = path.join(root, "project");
  const configRoot = path.join(root, "config");
  await Promise.all([
    writeText(path.join(configRoot, "app.yaml"), [
      "workspace:",
      "  strategy: git_worktree",
      "  root: .runs/workspaces",
      "  preserve_on_success: true",
      "  preserve_on_failure: true",
      "artifacts:",
      "  root: .runs",
      "agent_runtime:",
      "  id: test-runtime",
      "  options:",
      "    marker: stable",
      ""
    ].join("\n")),
    writeText(path.join(configRoot, "models.yaml"), [
      "model_profiles:",
      "  default:",
      "    model: fixture/default-model",
      "    reasoning_effort: medium",
      "  alternate:",
      "    provider: fixture-provider",
      "    model: fixture/alternate-model",
      "    reasoning_effort: high",
      "    transport: websocket",
      ""
    ].join("\n")),
    writeText(path.join(configRoot, "mcp.yaml"), [
      "mcp_servers:",
      "  - id: demo-mcp",
      "    transport: stdio",
      "    command: demo-mcp",
      "    allowed_tools:",
      "      - read",
      "    allowed_agent_modes:",
      "      - read_only",
      "      - trusted_local_write",
      ""
    ].join("\n")),
    writeText(
      path.join(projectRoot, "agents/reviewer/agent.yaml"),
      reviewerYaml
    ),
    writeText(
      path.join(projectRoot, "agents/reviewer/instructions.md"),
      "Review only the supplied fixture."
    ),
    writeText(
      path.join(projectRoot, "agents/reviewer/output.schema.json"),
      OUTPUT_SCHEMA
    ),
    writeText(
      path.join(projectRoot, "agents/reviewer/SKILL.md"),
      "SECRET_SKILL_MARKER"
    ),
    writeText(
      path.join(projectRoot, "agents/reviewer/CONTEXT.md"),
      "SECRET_AGENT_CONTEXT_MARKER"
    ),
    writeText(
      path.join(projectRoot, "agents/helper/agent.yaml"),
      HELPER_YAML
    ),
    writeText(
      path.join(projectRoot, "agents/helper/instructions.md"),
      "SECRET_SUBAGENT_MARKER"
    ),
    writeText(
      path.join(projectRoot, "agents/helper/output.schema.json"),
      OUTPUT_SCHEMA
    )
  ]);
  return { root, projectRoot, configRoot };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })
  ));
});

async function installedTarget(
  projectRoot: string
): Promise<Extract<StudioAgentTestTarget, { readonly kind: "installed" }>> {
  const definition = await loadAgentDefinition(
    path.join(projectRoot, "agents"),
    "reviewer",
    { capabilityRegistry: nativeLunaPlatformRegistrations.capabilityRegistry }
  );
  return {
    kind: "installed",
    agent_id: "reviewer",
    revision: agentDefinitionRevision(definition)
  };
}

type RuntimeHarness = {
  readonly inputs: RunAgentInput[];
  readonly prepared: unknown[];
  readonly createdOptions: unknown[];
  output: unknown;
};

function runtimeFactory(
  harness: RuntimeHarness,
  options: {
    readonly mcp?: boolean;
    readonly requirements?: readonly string[];
  } = {}
): AgentRuntimeFactory {
  const runtime: AgentRuntimePort = {
    describe: () => ({
      id: "test-runtime",
      display_name: "Native test runtime",
      supported_tool_protocols: options.mcp
        ? ["local", "mcp"]
        : ["local"],
      supported_runtime_requirements:
        options.requirements ?? ["json_output", "tool_calling"]
    }),
    async validate() {},
    async runAgent(input) {
      harness.inputs.push(input);
      return {
        output: harness.output,
        usage: {
          input_tokens: 21,
          output_tokens: 3,
          total_tokens: 24,
          cost: { total: 0.0042, unit: "USD" }
        },
        runtime_metadata: {
          provider: "fixture-provider",
          model: input.model_profile.model
        }
      };
    }
  };
  return {
    id: "test-runtime",
    prepare(input) {
      harness.prepared.push(input);
    },
    create(factoryOptions) {
      harness.createdOptions.push(factoryOptions);
      return runtime;
    }
  };
}

function createHarness(): RuntimeHarness {
  return {
    inputs: [],
    prepared: [],
    createdOptions: [],
    output: { status: "ok" }
  };
}

function emptyDrafts(): NativeStudioAgentTestDraftPort {
  return {
    async get() {
      throw Object.assign(new Error("missing draft"), {
        code: "studio_draft_authoring_not_found"
      });
    }
  };
}

function createBench(
  fixture: NativeFixture,
  harness: RuntimeHarness,
  options: {
    readonly drafts?: NativeStudioAgentTestDraftPort;
    readonly runtimeRequirements?: readonly string[];
    readonly mcp?: boolean;
  } = {}
) {
  const factory = runtimeFactory(harness, {
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
    ...(options.runtimeRequirements === undefined
      ? {}
      : { requirements: options.runtimeRequirements })
  });
  const resolver = new NativeStudioAgentTestResolver({
    projectRoot: fixture.projectRoot,
    configRoot: fixture.configRoot,
    drafts: options.drafts ?? emptyDrafts(),
    temporaryRoot: fixture.root,
    platform: {
      capabilityRegistry:
        nativeLunaPlatformRegistrations.capabilityRegistry,
      agentRuntimeFactories: { "test-runtime": factory }
    }
  });
  return new StudioAgentTestBenchService({
    resolver,
    runner: new NativeStudioAgentTestRunner(),
    confirmations: new MemoryStudioAgentTestConfirmations({
      now: () => NOW,
      createToken: () => TOKEN
    }),
    now: () => NOW,
    createPlanId: () => `atp_${"1".repeat(32)}`
  });
}

function planRequest(
  target: StudioAgentTestTarget,
  modelProfileId?: string
): StudioAgentTestPlanRequest {
  return {
    target,
    fixture: {
      task: "review",
      source: "bounded-test-fixture"
    },
    context: {
      kind: "json",
      value: { policy: "explicit-context-only" }
    },
    ...(modelProfileId === undefined
      ? {}
      : { model_profile_id: modelProfileId })
  };
}

const launchContext = {
  actor_binding: "native-agent-test-session",
  request_id: "native-agent-test-request"
};

function executeRequest(token: string) {
  return {
    confirmation_token: token,
    confirmation: {
      kind: "local_explicit" as const,
      real_model_call_confirmed: true as const,
      isolated_smoke_scope_confirmed: true as const
    }
  };
}

describe("native Studio agent test bench", () => {
  it("previews real capabilities but executes only the isolated model call", async () => {
    const fixture = await createNativeFixture();
    const harness = createHarness();
    const bench = createBench(fixture, harness);
    const request = planRequest(await installedTarget(fixture.projectRoot));

    const plan = await bench.plan(request, launchContext);

    expect(plan.resolution.available_model_profiles).toEqual([
      {
        id: "alternate",
        provider: "fixture-provider",
        model: "fixture/alternate-model",
        reasoning_effort: "high",
        transport: "websocket"
      },
      {
        id: "default",
        model: "fixture/default-model",
        reasoning_effort: "medium"
      }
    ]);
    expect(plan.resolution.tools).toEqual([
      expect.objectContaining({
        id: "repository.read-file",
        protocol: "local",
        execution: "excluded_no_isolation",
        safety: {
          local_writes: false,
          network: false,
          external_side_effects: false
        }
      })
    ]);
    expect(plan.resolution.mcp_servers).toEqual([
      expect.objectContaining({
        id: "demo-mcp",
        configured: true,
        runtime_supported: false,
        execution: "excluded_from_smoke"
      })
    ]);
    expect(plan.resolution.subagents).toEqual([
      expect.objectContaining({
        id: "helper",
        declared_mode: "read_only",
        policy_mode: "read_only",
        execution: "excluded_from_smoke"
      })
    ]);
    expect(plan.resolution.declared_skills).toEqual(["SKILL.md"]);
    expect(plan.resolution.declared_agent_context_files).toEqual([
      "CONTEXT.md"
    ]);
    expect(plan.resolution.runtime_requirements).toEqual([
      {
        id: "json_output",
        sources: ["agent"],
        runtime_supported: true,
        required_for_smoke: true
      },
      {
        id: "mcp_tools",
        sources: ["mcp"],
        runtime_supported: false,
        required_for_smoke: false
      },
      {
        id: "tool_calling",
        sources: ["local_tool", "mcp"],
        runtime_supported: true,
        required_for_smoke: false
      }
    ]);
    expect(harness.inputs).toHaveLength(0);
    expect(harness.prepared).toHaveLength(0);

    const result = await bench.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      launchContext
    );

    expect(result).toMatchObject({
      output: { status: "ok" },
      output_schema_validated: true,
      usage: {
        input_tokens: 21,
        output_tokens: 3,
        total_tokens: 24,
        cost: { total: 0.0042, unit: "USD" }
      },
      scope: {
        real_model_call: true,
        local_tools_executed: false,
        mcp_executed: false,
        subagents_executed: false,
        workflow_context_included: false,
        repository_context_included: false,
        agent_context_files_included: false,
        workflow_equivalent: false
      }
    });
    expect(harness.prepared).toHaveLength(1);
    expect(harness.inputs).toHaveLength(1);
    const runtimeInput = harness.inputs[0];
    expect(runtimeInput?.tools).toEqual({
      tools: [],
      runtime_requirements: []
    });
    expect(runtimeInput?.cwd).toBeUndefined();
    expect(runtimeInput?.context).toBeUndefined();
    expect(runtimeInput?.instructions_audit).toEqual({ skills: [] });
    expect(runtimeInput?.runtime_requirements).toEqual(["json_output"]);
    expect(runtimeInput?.input).toEqual({
      fixture: request.fixture,
      explicit_context: request.context,
      studio_smoke_scope: plan.resolution.scope
    });
    expect(runtimeInput?.instructions).toContain(
      "Review only the supplied fixture."
    );
    expect(runtimeInput?.instructions).not.toContain("SECRET_SKILL_MARKER");
    expect(runtimeInput?.instructions).not.toContain(
      "SECRET_AGENT_CONTEXT_MARKER"
    );
    expect(runtimeInput?.instructions).not.toContain("SECRET_SUBAGENT_MARKER");
  });

  it("allows only a model profile loaded from the real models config", async () => {
    const fixture = await createNativeFixture();
    const harness = createHarness();
    const bench = createBench(fixture, harness);
    const target = await installedTarget(fixture.projectRoot);

    const plan = await bench.plan(
      planRequest(target, "alternate"),
      launchContext
    );
    await bench.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      launchContext
    );
    expect(harness.inputs[0]?.model_profile).toEqual({
      provider: "fixture-provider",
      model: "fixture/alternate-model",
      reasoning_effort: "high",
      transport: "websocket"
    });

    const anotherHarness = createHarness();
    const anotherBench = createBench(fixture, anotherHarness);
    await expect(anotherBench.plan(
      planRequest(target, "invented-profile"),
      launchContext
    )).rejects.toMatchObject({
      code: "studio_agent_test_model_profile_unavailable"
    });
    expect(anotherHarness.inputs).toHaveLength(0);
  });

  it("blocks trusted write agents without proven isolation and issues no token", async () => {
    const fixture = await createNativeFixture(agentYaml({
      mode: "trusted_local_write",
      tool: "repository.write-file"
    }));
    const harness = createHarness();
    const bench = createBench(fixture, harness);

    const plan = await bench.plan(
      planRequest(await installedTarget(fixture.projectRoot)),
      launchContext
    );

    expect(plan.resolution.tools).toEqual([
      expect.objectContaining({
        id: "repository.write-file",
        execution: "excluded_no_isolation",
        safety: expect.objectContaining({ local_writes: true })
      })
    ]);
    expect(plan.execution).toEqual({
      available: false,
      blockers: [
        expect.objectContaining({
          code: "trusted_write_requires_isolation"
        })
      ]
    });
    expect(plan.execution).not.toHaveProperty("confirmation_token");
    expect(harness.inputs).toHaveLength(0);
  });

  it("blocks agent-declared runtime requirements the runtime cannot honor", async () => {
    const fixture = await createNativeFixture(agentYaml({
      runtimeRequirements: ["computer_use"]
    }));
    const harness = createHarness();
    const bench = createBench(fixture, harness, {
      runtimeRequirements: ["tool_calling"]
    });

    const plan = await bench.plan(
      planRequest(await installedTarget(fixture.projectRoot)),
      launchContext
    );

    expect(plan.execution).toEqual({
      available: false,
      blockers: [
        expect.objectContaining({
          code: "runtime_requirement_unsupported",
          message: expect.stringContaining("computer_use")
        })
      ]
    });
    expect(harness.inputs).toHaveLength(0);
  });

  it("uses canonical agent-node output schema validation", async () => {
    const fixture = await createNativeFixture();
    const harness = createHarness();
    harness.output = { status: "not-allowed" };
    const bench = createBench(fixture, harness);
    const plan = await bench.plan(
      planRequest(await installedTarget(fixture.projectRoot)),
      launchContext
    );

    await expect(bench.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      launchContext
    )).rejects.toMatchObject({ code: "studio_agent_test_output_invalid" });
    expect(harness.inputs).toHaveLength(1);
  });

  it("fails closed when an installed agent changes after planning", async () => {
    const fixture = await createNativeFixture();
    const harness = createHarness();
    const bench = createBench(fixture, harness);
    const plan = await bench.plan(
      planRequest(await installedTarget(fixture.projectRoot)),
      launchContext
    );
    await writeText(
      path.join(fixture.projectRoot, "agents/reviewer/instructions.md"),
      "Changed after confirmation planning."
    );

    await expect(bench.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      launchContext
    )).rejects.toMatchObject({ code: "studio_agent_test_target_stale" });
    expect(harness.inputs).toHaveLength(0);
  });

  it("loads an exact saved draft and fails closed when its ETag changes", async () => {
    const fixture = await createNativeFixture();
    const harness = createHarness();
    let draft = await draftItem(fixture);
    const drafts: NativeStudioAgentTestDraftPort = {
      async get() {
        return draft;
      }
    };
    const bench = createBench(fixture, harness, { drafts });
    const target: StudioAgentTestTarget = {
      kind: "draft",
      draft_id: draft.draft_id,
      etag: draft.etag
    };
    const plan = await bench.plan(planRequest(target), launchContext);
    expect(plan.resolution.target).toMatchObject({
      kind: "draft",
      agent_id: "reviewer",
      draft_id: draft.draft_id,
      etag: draft.etag,
      record_revision: 3,
      content_revision: 2
    });
    draft = {
      ...draft,
      record_revision: 4,
      etag: '"studio-draft:changed"'
    };

    await expect(bench.execute(
      plan.plan_id,
      executeRequest(TOKEN),
      launchContext
    )).rejects.toMatchObject({ code: "studio_agent_test_target_stale" });
    expect(harness.inputs).toHaveLength(0);
  });

  it("rejects a draft projection that escapes the selected agent directory", async () => {
    const fixture = await createNativeFixture();
    const harness = createHarness();
    const base = await draftItem(fixture);
    const escaped: StudioDraftItem = {
      ...base,
      files: [
        ...base.files,
        {
          file: {
            root: "project",
            path: "agents/another-agent/secret.md"
          },
          media_type: "text/markdown",
          state: "present",
          content: "must never materialize"
        }
      ]
    };
    const bench = createBench(fixture, harness, {
      drafts: { async get() { return escaped; } }
    });

    await expect(bench.plan(planRequest({
      kind: "draft",
      draft_id: escaped.draft_id,
      etag: escaped.etag
    }), launchContext)).rejects.toMatchObject({
      code: "studio_agent_test_target_invalid"
    });
    expect(harness.inputs).toHaveLength(0);
  });
});

async function draftItem(fixture: NativeFixture): Promise<StudioDraftItem> {
  const sources: readonly (readonly [
    string,
    StudioDraftItem["files"][number]["media_type"]
  ])[] = [
    ["agent.yaml", "application/yaml"],
    ["instructions.md", "text/markdown"],
    ["output.schema.json", "application/json"]
  ];
  const files = await Promise.all(sources.map(async ([name, mediaType]) => ({
    file: {
      root: "project" as const,
      path: `agents/reviewer/${name}`
    },
    media_type: mediaType,
    state: "present" as const,
    content: await readFile(
      path.join(fixture.projectRoot, "agents/reviewer", name),
      "utf8"
    )
  })));
  return {
    draft_id: "11111111-1111-4111-8111-111111111111",
    record_revision: 3,
    content_revision: 2,
    layout_revision: 0,
    primary_resource: { kind: "agent", id: "reviewer" },
    status: "valid",
    draft_hash: studioAgentTestValueDigest({ draft: "reviewer-v2" }),
    etag: '"studio-draft:reviewer:3"',
    files,
    created_at: "2026-07-11T14:00:00.000Z",
    updated_at: "2026-07-11T14:30:00.000Z"
  };
}
