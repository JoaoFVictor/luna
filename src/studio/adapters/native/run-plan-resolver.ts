import { matchesJsonSchema } from "../../../core/capabilities/json-schema.js";
import { executionPolicyDecisionForNode } from "../../../core/workflow/execution-policy.js";
import { workflowExecutionPlanPolicyNode } from "../../../core/workflow/execution-plan.js";
import type { JsonValue } from "../../../core/runtime/json.js";
import {
  WorkflowExecutionScopeError,
  WorkflowExecutionScopeFixtureError
} from "../../../core/workflow/execution-scope.js";
import { WorkflowCompilerError } from "../../../core/workflow/compiler.js";
import { WorkflowDefinitionError } from "../../../core/workflow/definition.js";
import {
  loadNativeRunContext,
  NativePrecompletedStepNodeError
} from "../../../platform/native/native-run-context.js";
import { assertNativeWorkflowAgentModelProfiles } from "../../../platform/native/native-agent-model-profiles.js";
import type { NativeLunaPlatformRegistrations } from "../../../platform/native/native-platform-registrations.js";
import { studioRunLaunchError } from "../../application/runs/launch-errors.js";
import type {
  StudioResolvedRunPlan,
  StudioRunPlanResolverPort
} from "../../application/runs/launch-ports.js";
import type { StudioRunPlanRequest } from "../../contracts/run-launch.js";
import type { NativeStudioRunSnapshot } from "./run-snapshot-contracts.js";
import {
  captureNativeStudioRunSnapshot,
  withMaterializedNativeStudioRunSnapshot
} from "./run-definition-snapshot.js";
import { resolveNativeStudioRunEffects } from "./run-effect-resolution.js";
import { fingerprintNativeStudioRepository } from "./run-repository-fingerprint.js";
import type { NativeStudioRunDispatchPayload } from "./run-snapshot-contracts.js";
import { createNativeStudioCapabilityCatalog } from "./capability-catalog.js";
import {
  createNativeProviderBuiltIns,
  nativeBuiltInMetadata
} from "../../../platform/native/native-built-ins.js";
import { nativePrecompletedSteps } from "./run-execution-profile.js";

type ResolverPlatform = Pick<
  NativeLunaPlatformRegistrations,
  | "capabilityRegistry"
  | "capabilityManifests"
  | "workflowBuiltIns"
  | "taskProviderBuiltIns"
>;

type NativeRunContext = Awaited<ReturnType<typeof loadNativeRunContext>>;

function isRepositoryResolutionFailure(cause: unknown): boolean {
  return typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "repository_not_configured";
}

function validateWorkflowConfig(
  workflow: NativeRunContext["workflow"],
  config: JsonValue
): void {
  const valid = workflow.config === undefined
    ? typeof config === "object" &&
      config !== null &&
      !Array.isArray(config) &&
      Object.keys(config).length === 0
    : matchesJsonSchema(workflow.config.schema_content, config);
  if (!valid) {
    throw studioRunLaunchError(
      "studio_run_plan_resolution_invalid",
      "Run config does not match the workflow config schema"
    );
  }
}


function assertManualTestNodeIsSubstitutable(
  context: NativeRunContext,
  request: StudioRunPlanRequest,
  platform: ResolverPlatform
): void {
  if (request.execution_profile.kind !== "manual_test") return;
  const providerBuiltIns = createNativeProviderBuiltIns({
    workflowBuiltIns: platform.workflowBuiltIns,
    taskProviderBuiltIns: platform.taskProviderBuiltIns,
    capabilityRegistry: platform.capabilityRegistry
  });
  const registrations = platform.capabilityRegistry.registrations();
  for (const testData of request.execution_profile.test_data) {
    const node = context.nativeWorkflow.compiled.nodes.find(
      (candidate) => candidate.id === testData.node_id
    );
    if (node === undefined) {
      // The native context already validated every selected id against the
      // scoped source definition. A missing compiled node is therefore a
      // redundant upstream cutpoint pruned by another selected cutpoint.
      continue;
    }
    const policyNode = workflowExecutionPlanPolicyNode(node);
    const policy = executionPolicyDecisionForNode(
      policyNode,
      (candidate) => nativeBuiltInMetadata(
        providerBuiltIns.builtInStepRegistry,
        candidate.compiled
      )
    );
    const source = node.source;
    const builtInPolicy = source.type === "built_in"
      ? registrations.built_ins.get(source.uses)?.side_effect_policy
      : undefined;
    const policyIds = [
      ...(builtInPolicy === undefined ? [] : [builtInPolicy]),
      ...(source.type === "built_in" ||
      source.type === "agent" ||
      source.type === "pattern" ||
      source.type === "human_gate"
        ? (source.policies ?? []).map((candidate) => candidate.uses)
        : [])
    ];
    const hasWriteEffect = policyIds.some((policyId) =>
      registrations.policies.get(policyId)?.side_effect_semantics === "write"
    );
    if (
      source.type === "human_gate" ||
      node.can_create_pending_interrupt ||
      hasWriteEffect ||
      policy.capturesWorkspace ||
      policy.artifactPaths.length > 0
    ) {
      throw studioRunLaunchError(
        "studio_run_test_data_invalid",
        "Gate, side-effecting, workspace-capturing, and artifact-publishing nodes cannot be replaced by manual test data",
        { node_id: testData.node_id }
      );
    }
  }
}

export type NativeStudioRunPlanResolverOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly platform: ResolverPlatform;
  readonly definitions?: {
    captureDefinition(
      source: StudioRunPlanRequest["definition_source"],
      workflowId: string
    ): Promise<NativeStudioRunSnapshot>;
  };
};

export class NativeStudioRunPlanResolver
  implements StudioRunPlanResolverPort<NativeStudioRunDispatchPayload>
{
  readonly #projectRoot: string;
  readonly #configRoot: string;
  readonly #platform: ResolverPlatform;
  readonly #catalogFingerprint: string;
  readonly #definitions: NativeStudioRunPlanResolverOptions["definitions"];

  constructor(options: NativeStudioRunPlanResolverOptions) {
    this.#projectRoot = options.projectRoot;
    this.#configRoot = options.configRoot;
    this.#platform = options.platform;
    this.#definitions = options.definitions;
    this.#catalogFingerprint = createNativeStudioCapabilityCatalog(
      options.platform
    ).technical_fingerprint;
  }

  async resolve(
    request: StudioRunPlanRequest,
    signal?: AbortSignal
  ): Promise<StudioResolvedRunPlan<NativeStudioRunDispatchPayload>> {
    const snapshot = this.#definitions === undefined
      ? await captureNativeStudioRunSnapshot({
          projectRoot: this.#projectRoot,
          configRoot: this.#configRoot,
          workflowId: request.workflow_id
        })
      : await this.#definitions.captureDefinition(
          request.definition_source,
          request.workflow_id
        );
    const resolution = await withMaterializedNativeStudioRunSnapshot(
      snapshot,
      async (definitionRoots) => {
        let context: NativeRunContext;
        try {
          context = await loadNativeRunContext(
            {
              projectRoot: this.#projectRoot,
              configRoot: this.#configRoot,
              definitionRoots,
              target: { type: "workflow", id: request.workflow_id },
              invocation: request.invocation,
              executionScope: request.execution_scope,
              precompleted_steps: nativePrecompletedSteps(
                request.execution_profile
              )
            },
            { platform: this.#platform }
          );
        } catch (cause) {
          if (cause instanceof NativePrecompletedStepNodeError) {
            throw studioRunLaunchError(
              "studio_run_test_data_stale",
              "Manual test data references a node outside the workflow scope",
              { node_id: cause.nodeId },
              { cause }
            );
          }
          if (cause instanceof WorkflowExecutionScopeFixtureError) {
            throw studioRunLaunchError(
              "studio_run_test_data_invalid",
              "The selected execution scope requires saved outputs for every boundary dependency",
              {
                node_id: cause.nodeId,
                missing_node_ids: cause.missingNodeIds.join(",")
              },
              { cause }
            );
          }
          if (cause instanceof WorkflowExecutionScopeError) {
            throw studioRunLaunchError(
              "studio_run_plan_resolution_invalid",
              "Execution scope references a node that does not exist in the workflow",
              { node_id: cause.nodeId },
              { cause }
            );
          }
          if (isRepositoryResolutionFailure(cause)) {
            throw studioRunLaunchError(
              "studio_run_repository_unavailable",
              "The workflow requires a repository that is missing from this invocation or local configuration",
              {},
              { cause }
            );
          }
          if (
            cause instanceof WorkflowDefinitionError ||
            cause instanceof WorkflowCompilerError
          ) {
            throw studioRunLaunchError(
              "studio_run_plan_resolution_invalid",
              "The saved workflow definition is not executable",
              {},
              { cause }
            );
          }
          throw cause;
        }
        assertManualTestNodeIsSubstitutable(context, request, this.#platform);
        try {
          await assertNativeWorkflowAgentModelProfiles({
            workflow: context.workflow,
            agentsRoot: context.agentsRoot,
            configRoot: context.definitionConfigRoot,
            capabilityRegistry: this.#platform.capabilityRegistry
          });
        } catch (cause) {
          throw studioRunLaunchError(
            "studio_run_plan_resolution_invalid",
            "Workflow agents do not resolve to executable model profiles",
            {},
            { cause }
          );
        }
        validateWorkflowConfig(context.workflow, request.config);
        const repository = context.repository;
        if (
          request.repository_id !== undefined &&
          repository?.id !== request.repository_id
        ) {
          throw studioRunLaunchError(
            "studio_run_plan_resolution_mismatch",
            "Requested repository does not match the invocation resolution"
          );
        }
        const repositoryFingerprint = repository === undefined
          ? undefined
          : await fingerprintNativeStudioRepository(repository, { signal });
        const effects = await resolveNativeStudioRunEffects({
          workflow: context.workflow,
          agentsRoot: context.agentsRoot,
          capabilityRegistry: this.#platform.capabilityRegistry
        });
        return {
          workflow_id: context.workflow.id,
          execution_scope: request.execution_scope,
          mode: context.workflow.mode,
          workflow_revision: context.workflow.revision,
          definition_bundle_hash: snapshot.bundle_hash,
          catalog_fingerprint: this.#catalogFingerprint,
          repository: {
            required: context.workflow.requires.repository,
            ...(repository === undefined
              ? {}
              : {
                  repository_id: repository.id,
                  fingerprint: repositoryFingerprint
                })
          },
          potential_effects: [...effects.potential_effects],
          resolved_effects: [...effects.resolved_effects],
          effect_uncertainties: [...effects.effect_uncertainties],
          warnings: [...effects.warnings]
        };
      }
    );
    return { resolution, dispatchPayload: { snapshot } };
  }
}
