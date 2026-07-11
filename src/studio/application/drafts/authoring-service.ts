import type { StudioApplyService } from "../apply/service.js";
import type {
  StudioApplyPlanResponse,
  StudioApplyResult
} from "../../contracts/apply.js";
import {
  StudioDraftAuthoringListPageSchema,
  StudioDraftCreateRequestSchema,
  StudioDraftListQuerySchema,
  StudioDraftPatchRequestSchema,
  StudioDraftSourceEditRequestSchema,
  StudioDraftSourceViewSchema,
  type StudioDraftTemplateCatalog,
  StudioDraftValidationResponseSchema,
  type StudioDraftAuthoringListPage,
  type StudioDraftCreateRequest,
  type StudioDraftItem,
  type StudioDraftListQuery,
  type StudioDraftPatchRequest,
  type StudioDraftSourceEditRequest,
  type StudioDraftSourceView,
  type StudioDraftValidationResponse
} from "../../contracts/draft-authoring.js";
import {
  applyYamlSourceOperations,
  projectYamlSourceValue
} from "../authoring/index.js";
import type { StudioChangeSet } from "../../contracts/drafts.js";
import {
  StudioPathSchema,
  studioPathKey,
  studioResourceKey,
  type StudioPath
} from "../../contracts/paths.js";
import { StudioDraftValidationResultSchema } from "../../contracts/validation.js";
import type { StudioDraftValidationService } from "../validation/draft-validation.js";
import type { StudioDraftPersistencePort } from "./persistence.js";
import { buildStudioDraftBundle } from "./authoring-bundles.js";
import { mergeStudioDraftBlobs } from "./authoring-blobs.js";
import { StudioDraftAuthoringError } from "./authoring-errors.js";
import { applyStudioDraftPatch } from "./authoring-mutations.js";
import { refreshStudioDraftClosure } from "./authoring-closure.js";
import type {
  StudioAuthoringSourcePort,
  StudioCatalogFingerprintPort,
  StudioModelProfileCatalogPort,
  StudioResourceRevisionPort
} from "./authoring-ports.js";
import {
  projectStudioDraftItem,
  projectStudioDraftList
} from "./authoring-projection.js";
import { studioDraftTemplateCatalog } from "./authoring-templates.js";
import {
  StudioDraftLifecycle,
  type StudioDraftLifecycleFailure
} from "./lifecycle.js";
import { STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE } from "../apply/scope.js";

export type StudioDraftAuthoringServiceOptions = {
  readonly drafts: StudioDraftPersistencePort;
  readonly source: StudioAuthoringSourcePort;
  readonly revisions: StudioResourceRevisionPort;
  readonly catalogs: StudioCatalogFingerprintPort;
  readonly modelProfiles: StudioModelProfileCatalogPort;
  readonly validation: Pick<StudioDraftValidationService, "validate">;
  readonly apply: Pick<StudioApplyService, "plan" | "apply">;
  readonly now?: () => Date;
  readonly randomDraftId?: () => string;
};

function authoringLifecycleError(
  failure: StudioDraftLifecycleFailure
): StudioDraftAuthoringError {
  switch (failure.kind) {
    case "clock_invalid":
      return new StudioDraftAuthoringError(
        "studio_draft_authoring_config_invalid",
        "The Studio authoring clock returned an invalid date",
        { cause: failure.cause }
      );
    case "catalog_fingerprint_invalid":
      return new StudioDraftAuthoringError(
        "studio_draft_authoring_config_invalid",
        `The Studio ${failure.catalog} catalog fingerprint is invalid`
      );
    case "draft_missing":
      return new StudioDraftAuthoringError(
        "studio_draft_authoring_not_found",
        "The requested Studio draft does not exist",
        { details: { draftId: failure.draftId } }
      );
    case "precondition_required":
      return new StudioDraftAuthoringError(
        "studio_draft_authoring_precondition_required",
        "Studio draft mutation requires If-Match",
        { details: { draftId: failure.draftId } }
      );
    case "apply_unavailable":
      return new StudioDraftAuthoringError(
        "studio_draft_authoring_config_invalid",
        "Studio draft apply is not configured"
      );
    case "revision_conflict":
      return new StudioDraftAuthoringError(
        "studio_draft_authoring_precondition_failed",
        failure.phase.startsWith("validation")
          ? "The Studio draft changed during validation"
          : "The Studio draft changed concurrently",
        {
          cause: failure.cause,
          details: {
            draftId: failure.draftId,
            actualEtag: failure.actualEtag
          }
        }
      );
  }
}

export class StudioDraftAuthoringService {
  private readonly drafts: StudioDraftPersistencePort;
  private readonly source: StudioAuthoringSourcePort;
  private readonly revisions: StudioResourceRevisionPort;
  private readonly modelProfiles: StudioModelProfileCatalogPort;
  private readonly validation: Pick<StudioDraftValidationService, "validate">;
  private readonly lifecycle: StudioDraftLifecycle;

  constructor(options: StudioDraftAuthoringServiceOptions) {
    this.drafts = options.drafts;
    this.source = options.source;
    this.revisions = options.revisions;
    this.modelProfiles = options.modelProfiles;
    this.validation = options.validation;
    this.lifecycle = new StudioDraftLifecycle({
      drafts: options.drafts,
      catalogs: options.catalogs,
      apply: options.apply,
      errors: authoringLifecycleError,
      now: options.now,
      randomDraftId: options.randomDraftId
    });
  }

  async create(input: StudioDraftCreateRequest): Promise<StudioDraftItem> {
    const request = StudioDraftCreateRequestSchema.parse(input);
    await this.assertBlankAgentModelProfile(request);
    const bundle = await buildStudioDraftBundle(
      { source: this.source, revisions: this.revisions },
      request.resource,
      request.source
    );
    const created = await this.lifecycle.create({
      primaryResource: request.resource,
      resources: [request.resource],
      resourceRevisions: {
        [studioResourceKey(request.resource)]: bundle.resourceRevision
      },
      baseBundleHash: bundle.baseBundleHash,
      baseFiles: bundle.baseFiles,
      dependencies: bundle.dependencies,
      allowedFiles: bundle.allowedFiles,
      changes: bundle.changes,
      blobs: bundle.blobs
    });
    const persisted =
      request.source.mode === "template"
        ? await this.validateTemplateDraft(created)
        : created;
    return await projectStudioDraftItem(this.drafts, persisted);
  }

  private async assertBlankAgentModelProfile(
    request: StudioDraftCreateRequest
  ): Promise<void> {
    if (
      request.resource.kind !== "agent" ||
      request.source.mode !== "blank"
    ) {
      return;
    }
    if (!("model_profile" in request.source)) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_model_profile_unavailable",
        "Blank agent creation requires a model profile"
      );
    }
    let available: readonly string[];
    try {
      available = await this.modelProfiles.ids();
    } catch (cause) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_config_invalid",
        "Model profiles could not be loaded for blank agent creation",
        { cause }
      );
    }
    if (!available.includes(request.source.model_profile)) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_model_profile_unavailable",
        "The selected model profile is not available"
      );
    }
  }

  templates(): StudioDraftTemplateCatalog {
    return studioDraftTemplateCatalog();
  }

  async list(
    input: StudioDraftListQuery = {}
  ): Promise<StudioDraftAuthoringListPage> {
    const query = StudioDraftListQuerySchema.parse(input);
    return StudioDraftAuthoringListPageSchema.parse(
      await projectStudioDraftList(this.drafts, query)
    );
  }

  async get(draftId: string): Promise<StudioDraftItem> {
    return await projectStudioDraftItem(
      this.drafts,
      await this.requireAuthoringDraft(draftId)
    );
  }

  async patch(
    draftId: string,
    input: StudioDraftPatchRequest,
    ifMatch: string | undefined
  ): Promise<StudioDraftItem> {
    const request = StudioDraftPatchRequestSchema.parse(input);
    const current = await this.requireAuthoringDraft(draftId);
    this.lifecycle.assertIfMatch(current, ifMatch);
    const closure = await refreshStudioDraftClosure(
      { source: this.source, revisions: this.revisions },
      current,
      request
    );
    const updated = await this.lifecycle.updateCas({
      current,
      mutate: (timestamp) => {
        const mutation = applyStudioDraftPatch(
          closure.changeSet,
          request,
          timestamp,
          { comparisonDraftHash: closure.comparisonDraftHash }
        );
        return {
          changeSet: mutation.changeSet,
          blobs: mergeStudioDraftBlobs(closure.blobs, mutation.blobs)
        };
      }
    });
    return await projectStudioDraftItem(this.drafts, updated);
  }

  async editSource(
    draftId: string,
    input: StudioDraftSourceEditRequest,
    ifMatch: string | undefined
  ): Promise<StudioDraftItem> {
    const request = StudioDraftSourceEditRequestSchema.parse(input);
    const current = await this.requireAuthoringDraft(draftId);
    this.lifecycle.assertIfMatch(current, ifMatch);
    const projected = await projectStudioDraftItem(this.drafts, current);
    const target = projected.files.find(
      (file) => studioPathKey(file.file) === studioPathKey(request.file)
    );
    if (
      target === undefined ||
      target.state !== "present" ||
      target.content === undefined ||
      target.media_type !== "application/yaml"
    ) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_file_not_editable",
        "Structured source edits require a present YAML file in this draft",
        { details: { draftId, file: request.file } }
      );
    }
    const result = applyYamlSourceOperations({
      source: target.content,
      operations: request.operations
    });
    if (!result.ok) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_source_invalid",
        result.diagnostics[0]?.message ?? "The structured YAML edit is invalid",
        { details: { draftId, file: request.file } }
      );
    }
    if (!result.changed) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_noop",
        "The structured YAML edit does not change source",
        { details: { draftId, file: request.file } }
      );
    }
    return await this.patch(
      draftId,
      {
        edits: [{ action: "write", file: request.file, content: result.source }]
      },
      ifMatch
    );
  }

  async sourceView(
    draftId: string,
    file: StudioPath
  ): Promise<StudioDraftSourceView> {
    const requestedFile = StudioPathSchema.parse(file);
    const projected = await this.get(draftId);
    const target = projected.files.find(
      (item) => studioPathKey(item.file) === studioPathKey(requestedFile)
    );
    if (
      target === undefined ||
      target.state !== "present" ||
      target.content === undefined ||
      target.media_type !== "application/yaml"
    ) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_file_not_editable",
        "A source view requires a present YAML file in this draft",
        { details: { draftId, file: requestedFile } }
      );
    }
    const view = projectYamlSourceValue(target.content);
    if (!view.ok) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_source_invalid",
        view.diagnostics[0]?.message ?? "The YAML source cannot be projected",
        { details: { draftId, file: requestedFile } }
      );
    }
    return StudioDraftSourceViewSchema.parse({
      file: requestedFile,
      value: view.value
    });
  }

  async delete(draftId: string, ifMatch: string | undefined): Promise<void> {
    const current = await this.requireAuthoringDraft(draftId);
    this.lifecycle.assertIfMatch(current, ifMatch);
    await this.lifecycle.deleteCas(current);
  }

  async validate(
    draftId: string,
    ifMatch: string | undefined
  ): Promise<StudioDraftValidationResponse> {
    return await this.validateWithMode(draftId, ifMatch, false);
  }

  async compile(
    draftId: string,
    ifMatch: string | undefined
  ): Promise<StudioDraftValidationResponse> {
    return await this.validateWithMode(draftId, ifMatch, true);
  }

  async planApply(draftId: string): Promise<StudioApplyPlanResponse> {
    await this.requireAuthoringDraft(draftId);
    return await this.lifecycle.planApply(
      draftId,
      STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE
    );
  }

  async apply(
    draftId: string,
    input: {
      readonly planToken: string;
      readonly idempotencyKey: string;
      readonly ifMatch: string | undefined;
    }
  ): Promise<StudioApplyResult> {
    const ifMatch = this.lifecycle.requireIfMatch(draftId, input.ifMatch);
    return await this.lifecycle.applyDraft(draftId, {
      planToken: input.planToken,
      idempotencyKey: input.idempotencyKey,
      ifMatch
    }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE);
  }

  private async validateWithMode(
    draftId: string,
    ifMatch: string | undefined,
    compile: boolean
  ): Promise<StudioDraftValidationResponse> {
    const current = await this.requireAuthoringDraft(draftId);
    this.lifecycle.assertIfMatch(current, ifMatch);
    const validation = await this.validation.validate(current, { compile });
    const targetStatus = validation.status === "valid" ? "valid" : "invalid";
    const persisted = await this.lifecycle.persistValidation(
      current,
      targetStatus
    );
    const projectedValidation = StudioDraftValidationResultSchema.parse({
      ...validation,
      record_revision: persisted.record_revision,
      content_revision: persisted.content_revision,
      layout_revision: persisted.layout_revision,
      draft_hash: persisted.draft_hash
    });
    return StudioDraftValidationResponseSchema.parse({
      draft: await projectStudioDraftItem(this.drafts, persisted),
      validation: projectedValidation
    });
  }

  private async validateTemplateDraft(
    current: StudioChangeSet
  ): Promise<StudioChangeSet> {
    const validation = await this.validation.validate(current, {
      compile: false
    });
    return await this.lifecycle.persistValidation(
      current,
      validation.status === "valid" ? "valid" : "invalid"
    );
  }

  private async requireAuthoringDraft(
    draftId: string
  ): Promise<StudioChangeSet> {
    const current = await this.lifecycle.require(draftId);
    if (
      current.primary_resource.kind === "workflow" ||
      current.primary_resource.kind === "agent"
    ) {
      return current;
    }
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_not_found",
      "The requested Studio authoring draft does not exist",
      { details: { draftId } }
    );
  }

}
