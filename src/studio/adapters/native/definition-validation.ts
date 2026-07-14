import path from "node:path";
import { loadAgentDefinition } from "../../../capabilities/agents/agent-loader.js";
import { agentDefinitionRevision } from "../../../capabilities/agents/agent-revision.js";
import { loadWorkflowDefinitionWithAgentDigests } from "../../../capabilities/agents/workflow-definition-loader.js";
import { ConfigError } from "../../../core/config/loader.js";
import { RuntimeError } from "../../../core/runtime/errors.js";
import { WorkflowCompilerError } from "../../../core/workflow/compiler.js";
import { WorkflowDefinitionError } from "../../../core/workflow/definition.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import { workflowExecutionPlanPolicyNode } from "../../../core/workflow/execution-plan.js";
import {
  splitDeferredFinalReportNodesByPolicy,
  WorkflowExecutionPolicyError
} from "../../../core/workflow/execution-policy.js";
import {
  assertNativeWorkflowAgentModelProfiles,
  loadNativeModelProfiles,
  requireNativeAgentModelProfile
} from "../../../platform/native/native-agent-model-profiles.js";
import {
  createNativeProviderBuiltIns,
  nativeBuiltInMetadata
} from "../../../platform/native/native-built-ins.js";
import {
  compileNativeWorkflow,
  loadWorkflowRuntimeConfig
} from "../../../platform/native/native-run-context.js";
import {
  nativeLunaPlatformRegistrations,
  type NativeLunaPlatformRegistrations
} from "../../../platform/native/native-platform-registrations.js";
import {
  StudioCanonicalDefinitionError,
  type StudioCanonicalDefinitionValidationPort,
  type StudioCanonicalValidationResult
} from "../../application/validation/definition-validation.js";
import type { StudioValidationSnapshot } from "../../application/validation/snapshot.js";
import { StudioCompiledWorkflowSchema } from "../../contracts/validation.js";
import type { StudioResourceRef } from "../../contracts/paths.js";
import { findStudioWorkflowAgentContextIssue } from "./workflow-agent-context.js";

type StudioNativeValidationPlatform = Pick<
  NativeLunaPlatformRegistrations,
  | "capabilityRegistry"
  | "capabilityManifests"
  | "workflowBuiltIns"
  | "taskProviderBuiltIns"
>;

export type NativeStudioDefinitionValidationOptions = {
  readonly platform?: StudioNativeValidationPlatform;
};

const EXPECTED_AGENT_ERROR_CODES = new Set([
  "agent_capability_duplicate",
  "agent_external_definition_reference_invalid",
  "agent_id_mismatch",
  "agent_model_profile_unknown",
  "agent_output_schema_unknown",
  "agent_path_escape",
  "agent_path_missing",
  "model_env_missing",
  "model_placeholder_invalid",
  "model_profile_env_unsupported",
  "model_spec_invalid"
]);

function publicErrorCode(cause: unknown, fallback: string): string {
  const candidate = (cause as { readonly code?: unknown }).code;
  return typeof candidate === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/.test(candidate)
    ? candidate
    : fallback;
}

function isExpectedDefinitionError(cause: unknown): boolean {
  if (
    cause instanceof StudioCanonicalDefinitionError ||
    cause instanceof ConfigError ||
    (cause instanceof RuntimeError && cause.code === "runtime_invalid_json") ||
    cause instanceof WorkflowDefinitionError ||
    cause instanceof WorkflowCompilerError ||
    cause instanceof WorkflowExecutionPolicyError
  ) {
    return true;
  }
  const code = (cause as { readonly code?: unknown }).code;
  return (
    code === "ENOENT" ||
    code === "path_security_violation" ||
    (typeof code === "string" && EXPECTED_AGENT_ERROR_CODES.has(code))
  );
}

function safeDefinitionMessage(
  cause: unknown,
  resource: StudioResourceRef
): string {
  const code = publicErrorCode(cause, `studio_${resource.kind}_invalid`);
  return `${resource.kind} ${resource.id} failed canonical validation (${code}).`;
}

function definitionFailure(
  cause: unknown,
  resource: StudioResourceRef
): StudioCanonicalDefinitionError {
  if (cause instanceof StudioCanonicalDefinitionError) {
    return cause;
  }
  if (!isExpectedDefinitionError(cause)) {
    throw cause;
  }
  const semanticLocation =
    cause instanceof WorkflowDefinitionError ||
    cause instanceof WorkflowCompilerError
      ? {
          ...(cause.path === undefined ? {} : { fieldPath: cause.path }),
          ...(cause.capability === undefined
            ? {}
            : { capability: cause.capability }),
          ...(cause.nodeId === undefined ? {} : { nodeId: cause.nodeId }),
          ...(cause.edge === undefined ? {} : { edge: cause.edge })
        }
      : cause instanceof WorkflowExecutionPolicyError
        ? {
            ...(cause.nodeId === undefined ? {} : { nodeId: cause.nodeId }),
            ...(cause.edge === undefined ? {} : { edge: cause.edge })
          }
      : cause instanceof ConfigError ||
          (cause instanceof RuntimeError && cause.code === "runtime_invalid_json")
        ? { fieldPath: "$" }
        : {};
  return new StudioCanonicalDefinitionError(
    publicErrorCode(cause, `studio_${resource.kind}_invalid`),
    safeDefinitionMessage(cause, resource),
    {
      cause,
      ...semanticLocation
    }
  );
}

function projectCompiledWorkflow(
  compiled: Awaited<ReturnType<typeof compileNativeWorkflow>>["compiled"]
) {
  return StudioCompiledWorkflowSchema.parse({
    workflow_id: compiled.workflow_id,
    workflow_revision: compiled.workflow_revision,
    state_schema_version: compiled.state_schema_version,
    nodes: compiled.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      yaml_path: node.yaml_path,
      capability_id: node.capability_id,
      can_create_pending_interrupt: node.can_create_pending_interrupt,
      ...(node.kind === "loop" ? {
        loop_body: (node.loop_body ?? []).map((bodyNode) => ({
          id: bodyNode.id,
          kind: bodyNode.kind,
          yaml_path: bodyNode.yaml_path,
          capability_id: bodyNode.capability_id,
          can_create_pending_interrupt: bodyNode.can_create_pending_interrupt
        }))
      } : {})
    })),
    edges: compiled.edges.map((edge) => ({ ...edge }))
  });
}

export class NativeStudioDefinitionValidation
  implements StudioCanonicalDefinitionValidationPort
{
  private readonly platform: StudioNativeValidationPlatform;

  constructor(options: NativeStudioDefinitionValidationOptions = {}) {
    this.platform = options.platform ?? nativeLunaPlatformRegistrations;
  }

  async validate(input: {
    readonly snapshot: StudioValidationSnapshot;
    readonly resource: StudioResourceRef;
    readonly compile: boolean;
  }): Promise<StudioCanonicalValidationResult> {
    try {
      switch (input.resource.kind) {
        case "workflow":
          return await this.validateWorkflow(
            input.snapshot,
            input.resource.id,
            input.compile
          );
        case "agent":
          return await this.validateAgent(input.snapshot, input.resource.id);
        case "config":
          return await this.validateConfig(input.snapshot, input.resource.id);
      }
    } catch (cause) {
      throw definitionFailure(cause, input.resource);
    }
  }

  private async loadWorkflow(
    snapshot: StudioValidationSnapshot,
    workflowId: string
  ) {
    const agentsRoot = path.join(snapshot.projectRoot, "agents");
    return await loadWorkflowDefinitionWithAgentDigests(
      path.join(snapshot.projectRoot, "workflows"),
      workflowId,
      {
        agentsRoot,
        capabilityRegistry: this.platform.capabilityRegistry
      }
    );
  }

  private async validateWorkflow(
    snapshot: StudioValidationSnapshot,
    workflowId: string,
    shouldCompile: boolean
  ): Promise<StudioCanonicalValidationResult> {
    const workflow = await this.loadWorkflow(snapshot, workflowId);
    const agentsRoot = path.join(snapshot.projectRoot, "agents");
    await assertNativeWorkflowAgentModelProfiles({
      workflow,
      agentsRoot,
      configRoot: snapshot.configRoot,
      capabilityRegistry: this.platform.capabilityRegistry
    });
    const contextIssue = await findStudioWorkflowAgentContextIssue(
      workflow,
      async (agentId) =>
        await loadAgentDefinition(agentsRoot, agentId, {
          capabilityRegistry: this.platform.capabilityRegistry
        })
    );
    if (contextIssue !== undefined) {
      throw new StudioCanonicalDefinitionError(
        "workflow_agent_context_missing",
        `Agent ${contextIssue.agentId} requires explicit collected context at node ${contextIssue.nodeId}.`,
        {
          fieldPath: contextIssue.fieldPath,
          nodeId: contextIssue.nodeId
        }
      );
    }
    if (!shouldCompile) {
      return { revision: workflow.revision };
    }
    const native = await compileNativeWorkflow({
      workflow,
      agentsRoot,
      platform: this.platform
    });
    const providerBuiltIns = createNativeProviderBuiltIns({
      workflowBuiltIns: this.platform.workflowBuiltIns,
      taskProviderBuiltIns: this.platform.taskProviderBuiltIns,
      capabilityRegistry: this.platform.capabilityRegistry
    });
    splitDeferredFinalReportNodesByPolicy({
      nodes: native.compiled.nodes.map(workflowExecutionPlanPolicyNode),
      builtInMetadata: (node) =>
        nativeBuiltInMetadata(providerBuiltIns.builtInStepRegistry, node.compiled)
    });
    return {
      revision: workflow.revision,
      compiledWorkflow: projectCompiledWorkflow(native.compiled)
    };
  }

  private async validateAgent(
    snapshot: StudioValidationSnapshot,
    agentId: string
  ): Promise<StudioCanonicalValidationResult> {
    const agent = await loadAgentDefinition(
      path.join(snapshot.projectRoot, "agents"),
      agentId,
      { capabilityRegistry: this.platform.capabilityRegistry }
    );
    const profiles = await loadNativeModelProfiles(snapshot.configRoot);
    const profile = requireNativeAgentModelProfile(agent, profiles);
    return {
      revision: sha256Digest({
        agent_revision: agentDefinitionRevision(agent),
        model_profile_id: agent.model_profile,
        model_profile: profile
      })
    };
  }

  private async validateConfig(
    snapshot: StudioValidationSnapshot,
    workflowId: string
  ): Promise<StudioCanonicalValidationResult> {
    const workflow = await this.loadWorkflow(snapshot, workflowId);
    if (workflow.config === undefined) {
      throw new StudioCanonicalDefinitionError(
        "studio_config_not_declared",
        `Workflow ${workflowId} does not declare runtime config.`
      );
    }
    // Keep path normalization, schema validation and runtime-JSON semantics
    // identical to execution. Studio must not invent a stricter parallel
    // interpretation of a workflow-owned config path.
    const config = await loadWorkflowRuntimeConfig({
      workflow,
      configRoot: snapshot.configRoot
    });
    return {
      revision: sha256Digest({
        workflow_revision: workflow.revision,
        config
      })
    };
  }
}
