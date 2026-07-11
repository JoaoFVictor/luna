import { matchesJsonSchema } from "../../../core/capabilities/json-schema.js";
import type { JsonValue } from "../../../core/runtime/json.js";
import { loadNativeRunContext } from "../../../platform/native/native-run-context.js";
import { assertNativeWorkflowAgentModelProfiles } from "../../../platform/native/native-agent-model-profiles.js";
import type { NativeLunaPlatformRegistrations } from "../../../platform/native/native-platform-registrations.js";
import { createStudioCapabilityCatalog } from "../../application/catalog/capability-catalog.js";
import { studioRunLaunchError } from "../../application/runs/launch-errors.js";
import type {
  StudioResolvedRunPlan,
  StudioRunPlanResolverPort
} from "../../application/runs/launch-ports.js";
import type { StudioRunPlanRequest } from "../../contracts/run-launch.js";
import {
  captureNativeStudioRunSnapshot,
  withMaterializedNativeStudioRunSnapshot
} from "./run-definition-snapshot.js";
import { resolveNativeStudioRunEffects } from "./run-effect-resolution.js";
import { fingerprintNativeStudioRepository } from "./run-repository-fingerprint.js";
import type { NativeStudioRunDispatchPayload } from "./run-snapshot-contracts.js";

type ResolverPlatform = Pick<
  NativeLunaPlatformRegistrations,
  "capabilityRegistry" | "capabilityManifests"
>;

type NativeRunContext = Awaited<ReturnType<typeof loadNativeRunContext>>;

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

function assertStudioRunCanFinishWithoutResume(
  context: NativeRunContext
): void {
  const interruptibleNodeCount = context.nativeWorkflow.compiled.nodes
    .filter((node) => node.can_create_pending_interrupt).length;
  if (interruptibleNodeCount === 0) {
    return;
  }
  throw studioRunLaunchError(
    "studio_run_interrupt_resume_unsupported",
    "Studio cannot launch a workflow that may wait for input until local resume is available",
    {
      workflow_id: context.workflow.id,
      mode: context.workflow.mode,
      interruptible_node_count: interruptibleNodeCount
    }
  );
}

export type NativeStudioRunPlanResolverOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly platform: ResolverPlatform;
};

export class NativeStudioRunPlanResolver
  implements StudioRunPlanResolverPort<NativeStudioRunDispatchPayload>
{
  readonly #projectRoot: string;
  readonly #configRoot: string;
  readonly #platform: ResolverPlatform;
  readonly #catalogFingerprint: string;

  constructor(options: NativeStudioRunPlanResolverOptions) {
    this.#projectRoot = options.projectRoot;
    this.#configRoot = options.configRoot;
    this.#platform = options.platform;
    this.#catalogFingerprint = createStudioCapabilityCatalog(
      options.platform.capabilityRegistry
    ).technical_fingerprint;
  }

  async resolve(
    request: StudioRunPlanRequest,
    signal?: AbortSignal
  ): Promise<StudioResolvedRunPlan<NativeStudioRunDispatchPayload>> {
    const snapshot = await captureNativeStudioRunSnapshot({
      projectRoot: this.#projectRoot,
      configRoot: this.#configRoot,
      workflowId: request.workflow_id
    });
    const resolution = await withMaterializedNativeStudioRunSnapshot(
      snapshot,
      async (definitionRoots) => {
        const context = await loadNativeRunContext(
          {
            projectRoot: this.#projectRoot,
            configRoot: this.#configRoot,
            definitionRoots,
            target: { type: "workflow", id: request.workflow_id },
            invocation: request.invocation
          },
          { platform: this.#platform }
        );
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
        assertStudioRunCanFinishWithoutResume(context);
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
