import type { StudioChangeSet } from "../../contracts/drafts.js";
import { StudioApplyError } from "./errors.js";

export type StudioApplyScope =
  | { readonly surface: "definition_authoring" }
  | {
      readonly surface: "workflow_configuration";
      readonly workflowId: string;
    };

export const STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE = Object.freeze({
  surface: "definition_authoring" as const
});

export function studioConfigurationApplyScope(
  workflowId: string
): StudioApplyScope {
  return Object.freeze({
    surface: "workflow_configuration" as const,
    workflowId
  });
}
export function assertStudioApplyScope(
  changeSet: StudioChangeSet,
  scope: StudioApplyScope
): void {
  const resource = changeSet.primary_resource;
  const matches =
    scope.surface === "definition_authoring"
      ? resource.kind === "workflow" || resource.kind === "agent"
      : resource.kind === "config" && resource.id === scope.workflowId;
  if (matches) return;

  // Conceal drafts owned by another Studio surface. The caller supplied an
  // identifier, but that must not become an existence or ETag oracle.
  throw new StudioApplyError(
    "studio_apply_draft_not_found",
    "The requested Studio draft does not exist in this apply scope",
    { details: { draftId: changeSet.draft_id } }
  );
}
