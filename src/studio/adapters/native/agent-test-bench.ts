import type { LoadedAgentDefinition } from "../../../capabilities/agents/agent-definition.js";
import { runAgentNode } from "../../../capabilities/agents/agent-node.js";
import {
  AgentRuntimeError,
  type AgentRuntimePort,
  type RunAgentOutput
} from "../../../core/agent-runtime/contracts.js";
import type { ModelProfile } from "../../../core/config/schemas.js";
import type { JsonObject } from "../../../core/runtime/backends/contracts.js";
import type { ResolvedToolCatalog } from "../../../core/tools/resolved-catalog.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import type { AgentRuntimeFactory } from "../../../runtime/composition/runtime-composition.js";
import { StudioAgentTestError, studioAgentTestError } from "../../application/agents/test-bench-errors.js";
import type {
  StudioAgentTestExecutionCommand,
  StudioAgentTestResolverPort,
  StudioAgentTestRunnerPort,
  StudioResolvedAgentTest
} from "../../application/agents/test-bench-ports.js";
import { createStudioCapabilityCatalog } from "../../application/catalog/capability-catalog.js";
import type {
  StudioAgentTestPlanRequest,
  StudioAgentTestResolution
} from "../../contracts/agent-test-bench.js";
import {
  resolveNativeStudioAgentTestEffectivePreview,
  type NativeStudioAgentTestPlatform
} from "./agent-test-runtime-preview.js";
import {
  loadNativeStudioAgentTestTarget,
  type NativeStudioAgentTestDraftPort
} from "./agent-test-target.js";

export const NATIVE_STUDIO_AGENT_TEST_SCOPE = Object.freeze({
  real_model_call: true as const,
  local_tools_executed: false as const,
  mcp_executed: false as const,
  subagents_executed: false as const,
  workflow_context_included: false as const,
  repository_context_included: false as const,
  agent_context_files_included: false as const,
  workflow_equivalent: false as const,
  statement:
    "This is an isolated real-model smoke test, not a workflow execution. Local tools, MCP, subagents, repository context, workflow context, agent context files, and skills are excluded."
});

const EMPTY_TOOL_CATALOG: ResolvedToolCatalog = Object.freeze({
  tools: Object.freeze([]),
  runtime_requirements: Object.freeze([])
});

const STUDIO_SMOKE_INSTRUCTIONS = [
  "# Studio Isolated Smoke Scope",
  "This call tests only this agent's core instructions against the supplied fixture and explicit JSON context.",
  "No workflow context, repository context, agent context files, skills, local tools, MCP servers, or subagents are available.",
  "Do not claim that this smoke result is equivalent to a workflow execution."
].join("\n\n");

export type NativeStudioAgentTestExecutionPayload = {
  readonly definition: LoadedAgentDefinition;
  readonly modelProfile: ModelProfile;
  readonly runtime?: AgentRuntimePort;
  readonly runtimeFactory?: AgentRuntimeFactory;
  readonly runtimeOptions: JsonObject;
  readonly projectRoot: string;
  readonly configRoot: string;
};

export type NativeStudioAgentTestResolverOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly platform: NativeStudioAgentTestPlatform;
  readonly drafts: NativeStudioAgentTestDraftPort;
  readonly temporaryRoot?: string;
};

export class NativeStudioAgentTestResolver
  implements StudioAgentTestResolverPort<NativeStudioAgentTestExecutionPayload>
{
  readonly #projectRoot: string;
  readonly #configRoot: string;
  readonly #platform: NativeStudioAgentTestPlatform;
  readonly #drafts: NativeStudioAgentTestDraftPort;
  readonly #temporaryRoot: string | undefined;
  readonly #catalogFingerprint: string;

  constructor(options: NativeStudioAgentTestResolverOptions) {
    this.#projectRoot = options.projectRoot;
    this.#configRoot = options.configRoot;
    this.#platform = options.platform;
    this.#drafts = options.drafts;
    this.#temporaryRoot = options.temporaryRoot;
    this.#catalogFingerprint = createStudioCapabilityCatalog(
      options.platform.capabilityRegistry
    ).technical_fingerprint;
  }

  async resolve(
    request: StudioAgentTestPlanRequest
  ): Promise<StudioResolvedAgentTest<NativeStudioAgentTestExecutionPayload>> {
    try {
      const target = await loadNativeStudioAgentTestTarget({
        projectRoot: this.#projectRoot,
        target: request.target,
        capabilityRegistry: this.#platform.capabilityRegistry,
        drafts: this.#drafts,
        ...(this.#temporaryRoot === undefined
          ? {}
          : { temporaryRoot: this.#temporaryRoot })
      });
      const effective = await resolveNativeStudioAgentTestEffectivePreview({
        definition: target.definition,
        ...(request.model_profile_id === undefined
          ? {}
          : { selectedModelProfileId: request.model_profile_id }),
        projectRoot: this.#projectRoot,
        configRoot: this.#configRoot,
        platform: this.#platform
      });
      const resolution: StudioAgentTestResolution = {
        target: target.snapshot,
        ...effective.resolution,
        catalog_fingerprint: this.#catalogFingerprint,
        output_schema_hash: sha256Digest(target.definition.outputSchema),
        instructions_hash: sha256Digest(target.definition.instructions),
        scope: NATIVE_STUDIO_AGENT_TEST_SCOPE
      };
      return {
        resolution,
        executionPayload: {
          definition: target.definition,
          modelProfile: effective.selectedModelProfile,
          ...(effective.runtime === undefined
            ? {}
            : { runtime: effective.runtime }),
          ...(effective.runtimeFactory === undefined
            ? {}
            : { runtimeFactory: effective.runtimeFactory }),
          runtimeOptions: effective.runtimeOptions,
          projectRoot: this.#projectRoot,
          configRoot: this.#configRoot
        }
      };
    } catch (cause) {
      if (cause instanceof StudioAgentTestError) {
        throw cause;
      }
      throw studioAgentTestError(
        "studio_agent_test_target_invalid",
        "The agent smoke preview could not be resolved safely",
        {},
        { cause }
      );
    }
  }
}

export class NativeStudioAgentTestRunner
  implements StudioAgentTestRunnerPort<NativeStudioAgentTestExecutionPayload>
{
  async run(
    command: StudioAgentTestExecutionCommand<NativeStudioAgentTestExecutionPayload>
  ): Promise<RunAgentOutput> {
    const payload = command.executionPayload;
    if (payload.runtime === undefined || payload.runtimeFactory === undefined) {
      throw new AgentRuntimeError(
        "runtime_unsupported_feature",
        "The configured agent runtime is unavailable"
      );
    }
    try {
      await payload.runtimeFactory.prepare?.({
        projectRoot: payload.projectRoot,
        configRoot: payload.configRoot,
        workflow: {
          id: "studio-agent-test",
          mode: "read_only",
          graph: { nodes: [] }
        },
        options: payload.runtimeOptions,
        hasAgents: true
      });
    } catch (cause) {
      throw new AgentRuntimeError(
        "runtime_unsupported_feature",
        "The configured agent runtime could not be prepared",
        { cause }
      );
    }
    const explicitContext = command.request.context.kind === "none"
      ? { kind: "none" as const }
      : {
          kind: "json" as const,
          value: command.request.context.value
        };
    return await runAgentNode({
      runtime: payload.runtime,
      run: {
        run_id: `studio-agent-test-${command.planId}`,
        workflow_id: "studio-agent-test",
        attempt: 1,
        started_at: command.requestedAt
      },
      node_id: "studio-agent-test",
      agent: {
        id: payload.definition.id,
        mode: "read_only",
        instructions: [
          payload.definition.instructions,
          STUDIO_SMOKE_INSTRUCTIONS
        ].join("\n\n"),
        tools: [],
        mcp_servers: [],
        skills: [],
        runtime_requirements:
          payload.definition.runtime_requirements ?? []
      },
      model_profile: payload.modelProfile,
      input: {
        fixture: command.request.fixture,
        explicit_context: explicitContext,
        studio_smoke_scope: NATIVE_STUDIO_AGENT_TEST_SCOPE
      },
      output_schema: payload.definition.outputSchema,
      tools: EMPTY_TOOL_CATALOG,
      skills: [],
      signal: command.signal
    });
  }
}
