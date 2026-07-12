import type { JsonValue } from "../../../core/runtime/json.js";
import type { StudioRunDefinitionSource } from "../../contracts/run-launch.js";

export type StudioInstalledRunDefinition = {
  readonly workflowRevision: string;
  readonly definitionBundleHash: string;
  readonly config: JsonValue;
};

export interface StudioInstalledRunDefinitionPort {
  load(workflowId: string): Promise<StudioInstalledRunDefinition>;
}

export interface StudioDraftRunDefinitionPort {
  loadDraft(
    source: Extract<StudioRunDefinitionSource, { kind: "draft" }>
  ): Promise<StudioInstalledRunDefinition & { readonly workflowId: string }>;
}

export interface StudioDraftNodeOutputValidatorPort {
  validateDraftNodeOutput(
    source: Extract<StudioRunDefinitionSource, { kind: "draft" }>,
    nodeId: string,
    output: JsonValue
  ): Promise<void>;
}
