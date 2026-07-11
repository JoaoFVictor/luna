import { isDeepStrictEqual } from "node:util";
import { replaceYamlValueAtPath } from "../authoring/yaml-source-editor.js";
import type { StudioApplyService } from "../apply/service.js";
import { studioConfigurationApplyScope } from "../apply/scope.js";
import {
  StudioConfigurationApplyPlanSchema,
  StudioConfigurationApplyResultSchema,
  StudioConfigurationDraftSchema,
  StudioConfigurationPatchRequestSchema,
  StudioConfigurationValidationResponseSchema,
  StudioWorkflowConfigurationSchema,
  studioConfigurationValueMatchesType,
  type StudioConfigurationApplyPlan,
  type StudioConfigurationApplyResult,
  type StudioConfigurationDraft,
  type StudioConfigurationField,
  type StudioConfigurationPatchRequest,
  type StudioConfigurationValidationResponse,
  type StudioWorkflowConfiguration
} from "../../contracts/configuration.js";
import type { StudioDraftFileChange } from "../../contracts/drafts.js";
import { studioPathKey, studioResourceKey } from "../../contracts/paths.js";
import type { StudioDraftValidationService } from "../validation/draft-validation.js";
import {
  replaceStudioDraftContent
} from "../drafts/change-set.js";
import type {
  StudioAuthoringSourcePort,
  StudioCatalogFingerprintPort,
  StudioResourceRevisionPort
} from "../drafts/authoring-ports.js";
import type { StudioDraftPersistencePort } from "../drafts/persistence.js";
import { studioAuthoringContentDigest } from "../drafts/authoring-digests.js";
import {
  StudioDraftLifecycle,
  type StudioDraftLifecycleFailure
} from "../drafts/lifecycle.js";
import { buildStudioConfigurationDraftBundle } from "./draft-bundle.js";
import {
  configurationDraftConfigFile,
  configurationDraftValueDiff,
  effectiveConfigurationDraftContent,
  loadStudioConfigurationDraftSource,
  projectStudioConfigurationDraft,
  projectStudioWorkflowConfiguration
} from "./draft-projection.js";
import { StudioConfigurationError } from "./errors.js";
import {
  loadStudioWorkflowConfigurationSource,
  parseStudioConfigurationValue
} from "./source.js";

export type StudioConfigurationServiceOptions = {
  readonly drafts: StudioDraftPersistencePort;
  readonly source: StudioAuthoringSourcePort;
  readonly revisions: StudioResourceRevisionPort;
  readonly catalogs: StudioCatalogFingerprintPort;
  readonly validation: Pick<StudioDraftValidationService, "validate">;
  readonly apply: Pick<StudioApplyService, "plan" | "apply">;
  readonly now?: () => Date;
  readonly randomDraftId?: () => string;
};

function configurationLifecycleError(
  failure: StudioDraftLifecycleFailure
): StudioConfigurationError {
  switch (failure.kind) {
    case "clock_invalid":
      return new StudioConfigurationError(
        "studio_configuration_source_invalid",
        "The Studio configuration clock returned an invalid date",
        { cause: failure.cause }
      );
    case "catalog_fingerprint_invalid":
      return new StudioConfigurationError(
        "studio_configuration_source_invalid",
        `The Studio ${failure.catalog} catalog fingerprint is invalid`
      );
    case "draft_missing":
      return new StudioConfigurationError(
        "studio_configuration_draft_not_found",
        "The requested configuration draft does not exist"
      );
    case "precondition_required":
      return new StudioConfigurationError(
        "studio_configuration_precondition_required",
        "Configuration draft mutation requires If-Match"
      );
    case "apply_unavailable":
      return new StudioConfigurationError(
        "studio_configuration_source_invalid",
        "Studio configuration apply is not configured"
      );
    case "revision_conflict":
      return new StudioConfigurationError(
        "studio_configuration_precondition_failed",
        failure.phase === "validation_readback"
          ? "The configuration draft changed during validation"
          : failure.phase === "if_match"
            ? "The configuration draft changed after the request was prepared"
            : "The configuration draft changed concurrently",
        { cause: failure.cause }
      );
  }
}

function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function valueSatisfiesField(
  field: StudioConfigurationField,
  value: StudioConfigurationPatchRequest["updates"][number]["value"]
): boolean {
  if (!studioConfigurationValueMatchesType(field.value_type, value)) {
    return false;
  }
  if (
    field.enum_values !== undefined &&
    !field.enum_values.some((candidate) => isDeepStrictEqual(candidate, value))
  ) {
    return false;
  }
  if (typeof value === "string") {
    if (field.min_length !== undefined && value.length < field.min_length) {
      return false;
    }
    if (field.max_length !== undefined && value.length > field.max_length) {
      return false;
    }
  }
  if (typeof value === "number") {
    if (field.minimum !== undefined && value < field.minimum) return false;
    if (field.maximum !== undefined && value > field.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (field.min_items !== undefined && value.length < field.min_items) {
      return false;
    }
    if (field.max_items !== undefined && value.length > field.max_items) {
      return false;
    }
  }
  return true;
}

export class StudioConfigurationService {
  private readonly drafts: StudioDraftPersistencePort;
  private readonly source: StudioAuthoringSourcePort;
  private readonly revisions: StudioResourceRevisionPort;
  private readonly validation: Pick<StudioDraftValidationService, "validate">;
  private readonly lifecycle: StudioDraftLifecycle;

  constructor(options: StudioConfigurationServiceOptions) {
    this.drafts = options.drafts;
    this.source = options.source;
    this.revisions = options.revisions;
    this.validation = options.validation;
    this.lifecycle = new StudioDraftLifecycle({
      drafts: options.drafts,
      catalogs: options.catalogs,
      apply: options.apply,
      errors: configurationLifecycleError,
      now: options.now,
      randomDraftId: options.randomDraftId
    });
  }

  async get(workflowId: string): Promise<StudioWorkflowConfiguration> {
    const source = await loadStudioWorkflowConfigurationSource(
      this.source,
      workflowId
    );
    const revision = source.declared
      ? await this.revisions.current({ kind: "config", id: workflowId })
      : null;
    return StudioWorkflowConfigurationSchema.parse(
      projectStudioWorkflowConfiguration({
        source,
        installedRevision: revision
      })
    );
  }

  async createDraft(workflowId: string): Promise<StudioConfigurationDraft> {
    const configuration = await loadStudioWorkflowConfigurationSource(
      this.source,
      workflowId
    );
    if (!configuration.declared) {
      throw new StudioConfigurationError(
        "studio_configuration_not_declared",
        "The workflow does not declare runtime configuration"
      );
    }
    if (configuration.schemaFile === undefined || !configuration.schemaValid) {
      throw new StudioConfigurationError(
        "studio_configuration_schema_unavailable",
        "The workflow configuration schema is unavailable"
      );
    }
    if (configuration.configFile === undefined || configuration.value === undefined) {
      throw new StudioConfigurationError(
        "studio_configuration_file_unavailable",
        "The workflow configuration file is unavailable"
      );
    }
    const bundle = await buildStudioConfigurationDraftBundle({
      source: this.source,
      revisions: this.revisions,
      configuration
    });
    const resource = { kind: "config" as const, id: workflowId };
    const created = await this.lifecycle.create({
      primaryResource: resource,
      resources: [resource],
      resourceRevisions: {
        [studioResourceKey(resource)]: bundle.resourceRevision
      },
      baseBundleHash: bundle.baseBundleHash,
      baseFiles: bundle.baseFiles,
      dependencies: bundle.dependencies,
      allowedFiles: bundle.allowedFiles,
      changes: bundle.changes,
      blobs: bundle.blobs
    });
    return await projectStudioConfigurationDraft({
      drafts: this.drafts,
      changeSet: created,
      workflowId
    });
  }

  async getDraft(
    workflowId: string,
    draftId: string
  ): Promise<StudioConfigurationDraft> {
    return await projectStudioConfigurationDraft({
      drafts: this.drafts,
      changeSet: await this.lifecycle.require(draftId),
      workflowId
    });
  }

  async patchDraft(
    workflowId: string,
    draftId: string,
    input: StudioConfigurationPatchRequest,
    ifMatch: string | undefined
  ): Promise<StudioConfigurationDraft> {
    const request = StudioConfigurationPatchRequestSchema.safeParse(input);
    if (!request.success) {
      throw new StudioConfigurationError(
        "studio_configuration_request_invalid",
        "The workflow configuration patch is invalid"
      );
    }
    const current = await this.lifecycle.require(draftId);
    this.lifecycle.assertIfMatch(current, ifMatch);
    const source = await loadStudioConfigurationDraftSource({
      drafts: this.drafts,
      changeSet: current,
      workflowId
    });
    const projection = projectStudioWorkflowConfiguration({ source });
    const fields = new Map(
      projection.fields.map((field) => [pathKey(field.path), field])
    );
    let content = await effectiveConfigurationDraftContent({
      drafts: this.drafts,
      changeSet: current,
      workflowId
    });
    for (const update of request.data.updates) {
      const field = fields.get(pathKey(update.path));
      if (field === undefined || field.exposure !== "editable") {
        throw new StudioConfigurationError(
          "studio_configuration_field_not_editable",
          "The requested configuration field is not explicitly editable",
          { details: { path: update.path } }
        );
      }
      if (!valueSatisfiesField(field, update.value)) {
        throw new StudioConfigurationError(
          "studio_configuration_value_invalid",
          "The configuration value does not match its safe field contract",
          { details: { path: update.path } }
        );
      }
      const replacement = replaceYamlValueAtPath({
        source: content,
        path: update.path,
        value: update.value
      });
      if (!replacement.ok) {
        throw new StudioConfigurationError(
          "studio_configuration_field_not_editable",
          "The configuration field cannot be updated safely in its YAML source",
          { details: { path: update.path } }
        );
      }
      content = replacement.source;
    }
    const before = await effectiveConfigurationDraftContent({
      drafts: this.drafts,
      changeSet: current,
      workflowId
    });
    if (content === before) {
      throw new StudioConfigurationError(
        "studio_configuration_noop",
        "The configuration patch does not change the draft"
      );
    }
    if (!parseStudioConfigurationValue(content).valid) {
      throw new StudioConfigurationError(
        "studio_configuration_value_invalid",
        "The configuration patch produced invalid YAML"
      );
    }
    const file = configurationDraftConfigFile(current, workflowId);
    const base = current.base_files.find(
      (candidate) => studioPathKey(candidate.file) === studioPathKey(file)
    );
    if (base === undefined || base.mode === null) {
      throw new StudioConfigurationError(
        "studio_configuration_draft_mismatch",
        "The configuration draft base is unavailable"
      );
    }
    const digest = studioAuthoringContentDigest(Buffer.from(content, "utf8"));
    const changes: StudioDraftFileChange[] =
      digest === base.sha256
        ? []
        : [
            {
              action: "write",
              file,
              base_sha256: base.sha256,
              content_sha256: digest,
              content_ref: digest,
              mode: base.mode
            }
          ];
    const persisted = await this.lifecycle.updateCas({
      current,
      mutate: (timestamp) => ({
        changeSet: replaceStudioDraftContent(
          current,
          changes,
          timestamp
        ),
        blobs: [{ digest, content }]
      })
    });
    return StudioConfigurationDraftSchema.parse(
      await projectStudioConfigurationDraft({
        drafts: this.drafts,
        changeSet: persisted,
        workflowId
      })
    );
  }

  async validateDraft(
    workflowId: string,
    draftId: string,
    ifMatch: string | undefined
  ): Promise<StudioConfigurationValidationResponse> {
    const current = await this.lifecycle.require(draftId);
    this.lifecycle.assertIfMatch(current, ifMatch);
    await loadStudioConfigurationDraftSource({
      drafts: this.drafts,
      changeSet: current,
      workflowId
    });
    const validation = await this.validation.validate(current, {
      compile: false
    });
    const targetStatus = validation.status === "valid" ? "valid" : "invalid";
    const persisted = await this.lifecycle.persistValidation(
      current,
      targetStatus
    );
    return StudioConfigurationValidationResponseSchema.parse({
      draft: await projectStudioConfigurationDraft({
        drafts: this.drafts,
        changeSet: persisted,
        workflowId
      }),
      validation: {
        status: validation.status,
        diagnostics: validation.diagnostics.map((item) => ({
          severity: item.severity,
          code: item.code,
          message: item.message
        })),
        validated_at: validation.validated_at
      }
    });
  }

  async planApply(
    workflowId: string,
    draftId: string
  ): Promise<StudioConfigurationApplyPlan> {
    const current = await this.lifecycle.require(draftId);
    await loadStudioConfigurationDraftSource({
      drafts: this.drafts,
      changeSet: current,
      workflowId
    });
    const [plan, changes] = await Promise.all([
      this.lifecycle.planApply(
        draftId,
        studioConfigurationApplyScope(workflowId)
      ),
      configurationDraftValueDiff({
        drafts: this.drafts,
        changeSet: current,
        workflowId
      })
    ]);
    if (
      plan.draft_id !== current.draft_id ||
      plan.record_revision !== current.record_revision ||
      plan.content_revision !== current.content_revision ||
      plan.draft_hash !== current.draft_hash
    ) {
      throw new StudioConfigurationError(
        "studio_configuration_precondition_failed",
        "The configuration draft changed while its apply plan was prepared"
      );
    }
    return StudioConfigurationApplyPlanSchema.parse({
      status: plan.status,
      draft_id: plan.draft_id,
      record_revision: plan.record_revision,
      content_revision: plan.content_revision,
      draft_hash: plan.draft_hash,
      changes,
      conflicts: plan.conflicts,
      ...(plan.status === "ready"
        ? {
            plan_token: plan.plan_token,
            expires_at: plan.expires_at
          }
        : {})
    });
  }

  async apply(
    workflowId: string,
    draftId: string,
    input: {
      readonly planToken: string;
      readonly idempotencyKey: string;
      readonly ifMatch: string | undefined;
    }
  ): Promise<StudioConfigurationApplyResult> {
    const ifMatch = this.lifecycle.requireIfMatch(draftId, input.ifMatch);
    const result = await this.lifecycle.applyDraft(draftId, {
      planToken: input.planToken,
      idempotencyKey: input.idempotencyKey,
      ifMatch
    }, studioConfigurationApplyScope(workflowId));
    return StudioConfigurationApplyResultSchema.parse({
      status: result.status,
      operation_id: result.operation_id,
      draft_id: result.draft_id,
      record_revision: result.record_revision,
      draft_hash: result.draft_hash,
      resource_revisions: result.resource_revisions,
      files: result.files,
      committed_at: result.committed_at,
      idempotent_replay: result.idempotent_replay
    });
  }

}
