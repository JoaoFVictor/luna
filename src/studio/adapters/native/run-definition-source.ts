import path from "node:path";
import type { JsonValue } from "../../../core/runtime/json.js";
import type { NativeLunaPlatformRegistrations } from "../../../platform/native/native-platform-registrations.js";
import {
  compileNativeWorkflow,
  loadNativeWorkflowDefinition,
  loadWorkflowRuntimeConfig
} from "../../../platform/native/native-run-context.js";
import { assertNodeOutputMatchesSchema } from "../../../runtime/workflow/node-output-validation.js";
import type {
  StudioDraftNodeOutputValidatorPort,
  StudioDraftRunDefinitionPort,
  StudioInstalledRunDefinition,
  StudioInstalledRunDefinitionPort
} from "../../application/runs/launch-definition-ports.js";
import { studioRunLaunchError } from "../../application/runs/launch-errors.js";
import type { StudioDraftItem } from "../../contracts/draft-authoring.js";
import type { StudioRunDefinitionSource } from "../../contracts/run-launch.js";
import {
  captureNativeStudioDraftRunSnapshot,
  captureNativeStudioRunSnapshot,
  withMaterializedNativeStudioRunSnapshot
} from "./run-definition-snapshot.js";
import type { NativeStudioRunSnapshot } from "./run-snapshot-contracts.js";

type DraftReader = { get(draftId: string): Promise<StudioDraftItem> };

export type NativeStudioRunDefinitionSourceOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly platform: Pick<
    NativeLunaPlatformRegistrations,
    | "capabilityRegistry"
    | "capabilityManifests"
    | "workflowBuiltIns"
    | "taskProviderBuiltIns"
  >;
  readonly drafts: DraftReader;
};

type LoadedDefinition = StudioInstalledRunDefinition & {
  readonly workflowId: string;
};

export class NativeStudioRunDefinitionSource
  implements
    StudioInstalledRunDefinitionPort,
    StudioDraftRunDefinitionPort,
    StudioDraftNodeOutputValidatorPort
{
  readonly #projectRoot: string;
  readonly #configRoot: string;
  readonly #platform: NativeStudioRunDefinitionSourceOptions["platform"];
  readonly #drafts: DraftReader;

  constructor(options: NativeStudioRunDefinitionSourceOptions) {
    this.#projectRoot = options.projectRoot;
    this.#configRoot = options.configRoot;
    this.#platform = options.platform;
    this.#drafts = options.drafts;
  }

  async load(workflowId: string): Promise<StudioInstalledRunDefinition> {
    return await this.#loadSnapshot(await this.captureDefinition(
      { kind: "installed" },
      workflowId
    ));
  }

  async loadDraft(
    source: Extract<StudioRunDefinitionSource, { kind: "draft" }>
  ): Promise<LoadedDefinition> {
    return await this.#loadSnapshot(await this.captureDefinition(source));
  }

  async validateDraftNodeOutput(
    source: Extract<StudioRunDefinitionSource, { kind: "draft" }>,
    nodeId: string,
    output: JsonValue
  ): Promise<void> {
    const snapshot = await this.captureDefinition(source);
    await withMaterializedNativeStudioRunSnapshot(snapshot, async (roots) => {
      const workflow = await loadNativeWorkflowDefinition({
        projectRoot: roots.projectRoot,
        workflowId: snapshot.workflow_id,
        platform: this.#platform
      });
      const compiled = await compileNativeWorkflow({
        workflow,
        agentsRoot: path.join(roots.projectRoot, "agents"),
        platform: this.#platform,
        precompletedNodeIds: new Set([nodeId])
      });
      const node = compiled.compiled.nodes.find((candidate) => candidate.id === nodeId);
      if (node === undefined) {
        throw studioRunLaunchError(
          "studio_run_plan_resolution_invalid",
          "Manual test output references a node outside the workflow",
          { node_id: nodeId }
        );
      }
      assertNodeOutputMatchesSchema(node, output);
    });
  }

  async captureDefinition(
    source: StudioRunDefinitionSource,
    workflowId?: string
  ): Promise<NativeStudioRunSnapshot> {
    if (source.kind === "installed") {
      if (workflowId === undefined) {
        throw studioRunLaunchError(
          "studio_run_plan_resolution_invalid",
          "Installed workflow id is required"
        );
      }
      return await captureNativeStudioRunSnapshot({
        projectRoot: this.#projectRoot,
        configRoot: this.#configRoot,
        workflowId
      });
    }
    const draft = await this.#drafts.get(source.draft_id);
    if (draft.etag !== source.etag) {
      throw studioRunLaunchError(
        "studio_run_plan_stale",
        "Workflow draft changed and must be planned again",
        { draft_id: source.draft_id }
      );
    }
    if (workflowId !== undefined && draft.primary_resource.id !== workflowId) {
      throw studioRunLaunchError(
        "studio_run_plan_resolution_mismatch",
        "Workflow draft does not match the requested workflow"
      );
    }
    return await captureNativeStudioDraftRunSnapshot({
      projectRoot: this.#projectRoot,
      configRoot: this.#configRoot,
      draft
    });
  }

  async #loadSnapshot(snapshot: NativeStudioRunSnapshot): Promise<LoadedDefinition> {
    return await withMaterializedNativeStudioRunSnapshot(snapshot, async (roots) => {
      const workflow = await loadNativeWorkflowDefinition({
        projectRoot: roots.projectRoot,
        workflowId: snapshot.workflow_id,
        platform: this.#platform
      });
      const config: JsonValue = await loadWorkflowRuntimeConfig({
        workflow,
        configRoot: roots.configRoot
      });
      return {
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        definitionBundleHash: snapshot.bundle_hash,
        config
      };
    });
  }
}
