import { readWorkflowDefinitionReferences } from "../../../core/workflow/definition-references.js";
import {
  STUDIO_CONFIGURATION_LIMITS,
  StudioConfigurationDraftSchema,
  StudioWorkflowConfigurationSchema,
  type StudioConfigurationDraft,
  type StudioConfigurationValueDiff,
  type StudioWorkflowConfiguration
} from "../../contracts/configuration.js";
import type { StudioChangeSet } from "../../contracts/drafts.js";
import {
  StudioPathSchema,
  studioPathKey,
  type StudioPath
} from "../../contracts/paths.js";
import {
  studioEditableDefinitionFile,
  studioEditableResourceFile
} from "../drafts/authoring-resource-paths.js";
import type { StudioDraftPersistencePort } from "../drafts/persistence.js";
import { studioDraftEtag } from "../drafts/versioning.js";
import {
  changedStudioConfigurationFields,
  projectStudioConfigurationExposure
} from "./exposure.js";
import { StudioConfigurationError } from "./errors.js";
import {
  parseStudioConfigurationSchema,
  parseStudioConfigurationValue,
  studioConfigurationMatchesSchema,
  studioConfigurationReferences,
  type StudioConfigurationSourceText,
  type StudioWorkflowConfigurationSource
} from "./source.js";

const MAX_PRIVATE_DRAFT_SOURCE_BYTES = 2 * 1024 * 1024;

function assertConfigurationDraft(
  changeSet: StudioChangeSet,
  workflowId: string
): void {
  if (
    changeSet.primary_resource.kind !== "config" ||
    changeSet.primary_resource.id !== workflowId ||
    changeSet.resources.length !== 1 ||
    changeSet.resources[0]?.kind !== "config" ||
    changeSet.resources[0].id !== workflowId
  ) {
    throw new StudioConfigurationError(
      "studio_configuration_draft_mismatch",
      "The draft does not belong to this workflow configuration"
    );
  }
  const configFiles = changeSet.allowed_files.filter(
    (file) => file.root === "config"
  );
  if (
    configFiles.length !== 1 ||
    changeSet.changes.some(
      (change) => studioPathKey(change.file) !== studioPathKey(configFiles[0])
    )
  ) {
    throw new StudioConfigurationError(
      "studio_configuration_draft_mismatch",
      "The configuration draft contains an unauthorized file scope"
    );
  }
}

function baseFor(changeSet: StudioChangeSet, file: StudioPath) {
  return changeSet.base_files.find(
    (candidate) => studioPathKey(candidate.file) === studioPathKey(file)
  );
}

async function privateDraftSource(
  drafts: StudioDraftPersistencePort,
  changeSet: StudioChangeSet,
  file: StudioPath,
  baseOnly: boolean
): Promise<StudioConfigurationSourceText> {
  const base = baseFor(changeSet, file);
  if (
    base === undefined ||
    base.content_ref === null ||
    base.sha256 === null ||
    base.mode === null
  ) {
    throw new StudioConfigurationError(
      "studio_configuration_draft_mismatch",
      "The configuration draft is missing a pinned source file"
    );
  }
  const change = baseOnly
    ? undefined
    : changeSet.changes.find(
        (candidate) => studioPathKey(candidate.file) === studioPathKey(file)
      );
  if (change?.action === "delete") {
    throw new StudioConfigurationError(
      "studio_configuration_draft_mismatch",
      "Configuration drafts cannot delete their source file"
    );
  }
  const contentRef =
    change?.action === "write" ? change.content_ref : base.content_ref;
  let content: string;
  try {
    content = await drafts.getBlob(changeSet.draft_id, contentRef, {
      maxBytes: MAX_PRIVATE_DRAFT_SOURCE_BYTES
    });
  } catch (cause) {
    throw new StudioConfigurationError(
      "studio_configuration_source_invalid",
      "A private configuration draft source is unavailable",
      { cause }
    );
  }
  return {
    file,
    content,
    sha256:
      change?.action === "write" ? change.content_sha256 : base.sha256,
    mode: change?.action === "write" ? (change.mode ?? base.mode) : base.mode
  };
}

function invalidSourceDiagnostic(code: string, message: string) {
  return { severity: "error" as const, code, message };
}

export async function loadStudioConfigurationDraftSource(input: {
  readonly drafts: StudioDraftPersistencePort;
  readonly changeSet: StudioChangeSet;
  readonly workflowId: string;
  readonly baseOnly?: boolean;
}): Promise<StudioWorkflowConfigurationSource> {
  assertConfigurationDraft(input.changeSet, input.workflowId);
  const workflowResource = {
    kind: "workflow" as const,
    id: input.workflowId
  };
  const workflow = await privateDraftSource(
    input.drafts,
    input.changeSet,
    studioEditableDefinitionFile(workflowResource),
    true
  );
  let references: ReturnType<typeof readWorkflowDefinitionReferences>;
  try {
    references = readWorkflowDefinitionReferences(workflow.content);
  } catch (cause) {
    throw new StudioConfigurationError(
      "studio_configuration_draft_mismatch",
      "The pinned workflow definition is invalid",
      { cause }
    );
  }
  if (references.config === undefined) {
    throw new StudioConfigurationError(
      "studio_configuration_draft_mismatch",
      "The pinned workflow does not declare configuration"
    );
  }
  const schemaPath = studioEditableResourceFile(
    workflowResource,
    references.config.schema
  );
  const configPath = StudioPathSchema.safeParse({
    root: "config",
    path: references.config.file
  });
  if (schemaPath === undefined || !configPath.success) {
    throw new StudioConfigurationError(
      "studio_configuration_draft_mismatch",
      "The pinned configuration references are invalid"
    );
  }
  const schemaFile = await privateDraftSource(
    input.drafts,
    input.changeSet,
    schemaPath,
    true
  );
  const configFile = await privateDraftSource(
    input.drafts,
    input.changeSet,
    configPath.data,
    input.baseOnly === true
  );
  const parsedSchema = parseStudioConfigurationSchema(schemaFile.content);
  const parsedValue = parseStudioConfigurationValue(configFile.content);
  const configValid = studioConfigurationMatchesSchema(
    parsedSchema.schema,
    parsedValue.value,
    parsedSchema.valid,
    parsedValue.valid
  );
  const diagnostics = [];
  if (!parsedSchema.valid) {
    diagnostics.push(
      invalidSourceDiagnostic(
        "configuration_schema_invalid",
        "The pinned workflow configuration schema is invalid"
      )
    );
  }
  if (!parsedValue.valid) {
    diagnostics.push(
      invalidSourceDiagnostic(
        "configuration_file_invalid",
        "The drafted workflow configuration file is invalid"
      )
    );
  } else if (parsedSchema.valid && !configValid) {
    diagnostics.push(
      invalidSourceDiagnostic(
        "configuration_schema_mismatch",
        "The drafted workflow configuration does not match its schema"
      )
    );
  }
  return {
    workflowId: input.workflowId,
    workflow,
    declared: true,
    references: studioConfigurationReferences(workflow.content),
    diagnostics,
    schemaFile,
    configFile,
    ...(parsedSchema.schema === undefined
      ? {}
      : { schema: parsedSchema.schema }),
    ...(parsedValue.value === undefined ? {} : { value: parsedValue.value }),
    schemaValid: parsedSchema.valid,
    configValid
  };
}

export function projectStudioWorkflowConfiguration(input: {
  readonly source: StudioWorkflowConfigurationSource;
  readonly installedRevision?: string | null;
}): StudioWorkflowConfiguration {
  const { source } = input;
  const exposure =
    source.schemaValid && source.schema !== undefined
      ? projectStudioConfigurationExposure({
          schema: source.schema,
          ...(source.value === undefined ? {} : { value: source.value })
        })
      : {
          fields: [],
          summary: {
            total_leaf_count: 0,
            classified_field_count: 0,
            unclassified_field_count: 0,
            unsupported_classified_field_count: 0
          },
          diagnostics: []
        };
  const status = !source.declared
    ? source.diagnostics.length === 0
      ? "not_declared"
      : "invalid"
    : source.schemaFile === undefined || source.configFile === undefined
      ? "unavailable"
      : !source.schemaValid || !source.configValid
        ? "invalid"
        : "ready";
  return StudioWorkflowConfigurationSchema.parse({
    workflow_id: source.workflowId,
    status,
    declared: source.declared,
    config_present: source.configFile !== undefined,
    schema_present: source.schemaFile !== undefined,
    raw_yaml_enabled: false,
    ...(source.configFile === undefined
      ? {}
      : {
          file_reference: `${source.configFile.file.root}:${source.configFile.file.path}`
        }),
    ...(source.schemaFile === undefined
      ? {}
      : {
          schema_reference: `${source.schemaFile.file.root}:${source.schemaFile.file.path}`
        }),
    ...(input.installedRevision === undefined ||
    input.installedRevision === null
      ? {}
      : { installed_revision: input.installedRevision }),
    schema_summary: exposure.summary,
    fields: exposure.fields,
    references: source.references.map((expression) => ({ expression })),
    diagnostics: [...source.diagnostics, ...exposure.diagnostics].slice(
      0,
      STUDIO_CONFIGURATION_LIMITS.maxDiagnostics
    )
  });
}

export async function projectStudioConfigurationDraft(input: {
  readonly drafts: StudioDraftPersistencePort;
  readonly changeSet: StudioChangeSet;
  readonly workflowId: string;
}): Promise<StudioConfigurationDraft> {
  const source = await loadStudioConfigurationDraftSource(input);
  const resourceRevision =
    input.changeSet.resource_revisions[`config:${input.workflowId}`];
  return StudioConfigurationDraftSchema.parse({
    draft_id: input.changeSet.draft_id,
    record_revision: input.changeSet.record_revision,
    content_revision: input.changeSet.content_revision,
    status: input.changeSet.status,
    draft_hash: input.changeSet.draft_hash,
    etag: studioDraftEtag(input.changeSet),
    configuration: projectStudioWorkflowConfiguration({
      source,
      installedRevision: resourceRevision
    }),
    created_at: input.changeSet.created_at,
    updated_at: input.changeSet.updated_at
  });
}

export async function configurationDraftValueDiff(input: {
  readonly drafts: StudioDraftPersistencePort;
  readonly changeSet: StudioChangeSet;
  readonly workflowId: string;
}): Promise<ReadonlyArray<StudioConfigurationValueDiff>> {
  const [before, after] = await Promise.all([
    loadStudioConfigurationDraftSource({ ...input, baseOnly: true }),
    loadStudioConfigurationDraftSource(input)
  ]);
  const beforeProjection = projectStudioWorkflowConfiguration({ source: before });
  const afterProjection = projectStudioWorkflowConfiguration({ source: after });
  return changedStudioConfigurationFields(
    beforeProjection.fields,
    afterProjection.fields
  );
}

export function configurationDraftConfigFile(
  changeSet: StudioChangeSet,
  workflowId: string
): StudioPath {
  assertConfigurationDraft(changeSet, workflowId);
  const file = changeSet.allowed_files.find((candidate) => candidate.root === "config");
  if (file === undefined) {
    throw new StudioConfigurationError(
      "studio_configuration_draft_mismatch",
      "The configuration draft has no authorized config file"
    );
  }
  return file;
}

export async function effectiveConfigurationDraftContent(input: {
  readonly drafts: StudioDraftPersistencePort;
  readonly changeSet: StudioChangeSet;
  readonly workflowId: string;
}): Promise<string> {
  const file = configurationDraftConfigFile(input.changeSet, input.workflowId);
  return (
    await privateDraftSource(input.drafts, input.changeSet, file, false)
  ).content;
}
