import type { StudioDraftAuthoringService } from "../application/drafts/authoring-service.js";
import type { StudioDraftAuthoringControl } from "./routes/drafts.js";

/**
 * Integration hook for local mode. Authentication remains owned by the server
 * composition root; this adapter only forwards an already-authenticated command.
 */
export function createLocalStudioDraftAuthoringControl(
  service: StudioDraftAuthoringService
): StudioDraftAuthoringControl {
  return {
    listDraftTemplates: (_principal) => service.templates(),
    createDraft: async (_principal, request) => await service.create(request),
    listDrafts: async (_principal, query) => await service.list(query),
    getDraft: async (_principal, draftId) => await service.get(draftId),
    patchDraft: async (_principal, draftId, request, ifMatch) =>
      await service.patch(draftId, request, ifMatch),
    editDraftSource: async (_principal, draftId, request, ifMatch) =>
      await service.editSource(draftId, request, ifMatch),
    getDraftSourceView: async (_principal, draftId, file) =>
      await service.sourceView(draftId, file),
    deleteDraft: async (_principal, draftId, ifMatch) =>
      await service.delete(draftId, ifMatch),
    validateDraft: async (_principal, draftId, ifMatch) =>
      await service.validate(draftId, ifMatch),
    compileDraft: async (_principal, draftId, ifMatch) =>
      await service.compile(draftId, ifMatch),
    planDraftApply: async (_principal, draftId) =>
      await service.planApply(draftId),
    applyDraft: async (_principal, draftId, request) =>
      await service.apply(draftId, request)
  };
}
