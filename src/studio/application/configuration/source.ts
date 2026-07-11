import { matchesJsonSchema } from "../../../core/capabilities/json-schema.js";
import type { JsonSchemaLike } from "../../../core/capabilities/json-schema-types.js";
import {
  assertJsonValue,
  isPlainObject,
  type JsonValue
} from "../../../core/json/value.js";
import { readWorkflowDefinitionReferences } from "../../../core/workflow/definition-references.js";
import {
  STUDIO_CONFIGURATION_LIMITS,
  type StudioConfigurationDiagnostic
} from "../../contracts/configuration.js";
import {
  StudioPathSchema,
  StudioResourceRefSchema,
  type StudioPath
} from "../../contracts/paths.js";
import { projectYamlSourceValue } from "../authoring/yaml-source-document.js";
import type {
  StudioAuthoringSourceFile,
  StudioAuthoringSourcePort
} from "../drafts/authoring-ports.js";
import {
  studioEditableDefinitionFile,
  studioEditableResourceFile,
  type StudioEditableResource
} from "../drafts/authoring-resource-paths.js";
import { studioAuthoringContentDigest } from "../drafts/authoring-digests.js";
import { analyzeStudioJsonSchema } from "../schemas/schema-analysis.js";
import { StudioConfigurationError } from "./errors.js";

const MAX_CONFIGURATION_SOURCE_BYTES = 2 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CONFIG_EXPRESSION = /\$\.config(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/gu;

export type StudioConfigurationSourceText = {
  readonly file: StudioPath;
  readonly content: string;
  readonly sha256: string;
  readonly mode: number;
};

export type StudioWorkflowConfigurationSource = {
  readonly workflowId: string;
  readonly workflow: StudioConfigurationSourceText;
  readonly declared: boolean;
  readonly references: readonly string[];
  readonly diagnostics: readonly StudioConfigurationDiagnostic[];
  readonly schemaFile?: StudioConfigurationSourceText;
  readonly configFile?: StudioConfigurationSourceText;
  readonly schema?: JsonValue;
  readonly value?: JsonValue;
  readonly schemaValid: boolean;
  readonly configValid: boolean;
};

function sourceDiagnostic(
  code: string,
  message: string
): StudioConfigurationDiagnostic {
  return { severity: "error", code, message };
}

function workflowResource(workflowId: string): StudioEditableResource {
  const parsed = StudioResourceRefSchema.safeParse({
    kind: "workflow",
    id: workflowId
  });
  if (!parsed.success || parsed.data.kind !== "workflow") {
    throw new StudioConfigurationError(
      "studio_configuration_request_invalid",
      "The workflow configuration request is invalid"
    );
  }
  return { kind: "workflow", id: parsed.data.id };
}

function validateSourceFile(
  file: StudioPath,
  loaded: StudioAuthoringSourceFile
): StudioConfigurationSourceText {
  const sha256 = studioAuthoringContentDigest(loaded.content);
  if (
    sha256 !== loaded.sha256 ||
    !Number.isInteger(loaded.mode) ||
    loaded.mode < 0 ||
    loaded.mode > 0o777
  ) {
    throw new StudioConfigurationError(
      "studio_configuration_source_invalid",
      "Workflow configuration source metadata is invalid"
    );
  }
  let content: string;
  try {
    content = UTF8_DECODER.decode(loaded.content);
  } catch (cause) {
    throw new StudioConfigurationError(
      "studio_configuration_source_invalid",
      "Workflow configuration source is not valid UTF-8",
      { cause }
    );
  }
  return { file, content, sha256, mode: loaded.mode };
}

async function readSource(
  source: StudioAuthoringSourcePort,
  file: StudioPath
): Promise<StudioConfigurationSourceText | undefined> {
  try {
    const loaded = await source.read(file, {
      maxBytes: MAX_CONFIGURATION_SOURCE_BYTES
    });
    return loaded === undefined ? undefined : validateSourceFile(file, loaded);
  } catch (cause) {
    if (cause instanceof StudioConfigurationError) throw cause;
    throw new StudioConfigurationError(
      "studio_configuration_source_invalid",
      "Workflow configuration source could not be read safely",
      { cause }
    );
  }
}

export function studioConfigurationReferences(source: string): readonly string[] {
  return [...new Set(source.match(CONFIG_EXPRESSION) ?? [])]
    .filter((expression) => expression.length <= 2_048)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, STUDIO_CONFIGURATION_LIMITS.maxReferences);
}

export function parseStudioConfigurationSchema(
  source: string
): { readonly schema?: JsonValue; readonly valid: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
    assertJsonValue(parsed, "$.schema");
  } catch {
    return { valid: false };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !isPlainObject(parsed)
  ) {
    return { valid: false };
  }
  const schema = parsed as JsonValue;
  const analysis = analyzeStudioJsonSchema(
    parsed as Record<string, JsonValue>
  );
  return { schema, valid: analysis.schema !== undefined };
}

export function parseStudioConfigurationValue(
  source: string
): { readonly value?: JsonValue; readonly valid: boolean } {
  const projection = projectYamlSourceValue(source);
  return projection.ok
    ? { value: projection.value, valid: true }
    : { valid: false };
}

export function studioConfigurationMatchesSchema(
  schema: JsonValue | undefined,
  value: JsonValue | undefined,
  schemaValid: boolean,
  configParsed: boolean
): boolean {
  if (
    !schemaValid ||
    !configParsed ||
    schema === undefined ||
    value === undefined ||
    schema === null ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  ) {
    return false;
  }
  const analysis = analyzeStudioJsonSchema(
    schema as Record<string, JsonValue>
  );
  return (
    analysis.schema !== undefined &&
    matchesJsonSchema(analysis.schema as JsonSchemaLike, value)
  );
}

export async function loadStudioWorkflowConfigurationSource(
  source: StudioAuthoringSourcePort,
  workflowId: string
): Promise<StudioWorkflowConfigurationSource> {
  const resource = workflowResource(workflowId);
  const definitionFile = studioEditableDefinitionFile(resource);
  const workflow = await readSource(source, definitionFile);
  if (workflow === undefined) {
    throw new StudioConfigurationError(
      "studio_configuration_workflow_not_found",
      "The requested workflow does not exist"
    );
  }
  let references: ReturnType<typeof readWorkflowDefinitionReferences>;
  try {
    references = readWorkflowDefinitionReferences(workflow.content);
  } catch {
    return {
      workflowId,
      workflow,
      declared: false,
      references: studioConfigurationReferences(workflow.content),
      diagnostics: [
        sourceDiagnostic(
          "configuration_workflow_invalid",
          "The workflow definition cannot be inspected safely"
        )
      ],
      schemaValid: false,
      configValid: false
    };
  }
  if (references.config === undefined) {
    return {
      workflowId,
      workflow,
      declared: false,
      references: studioConfigurationReferences(workflow.content),
      diagnostics: [],
      schemaValid: false,
      configValid: false
    };
  }

  const schemaPath = studioEditableResourceFile(
    resource,
    references.config.schema
  );
  const configPath = StudioPathSchema.safeParse({
    root: "config",
    path: references.config.file
  });
  if (schemaPath === undefined || !configPath.success) {
    throw new StudioConfigurationError(
      "studio_configuration_source_invalid",
      "Workflow configuration references escape their authorized roots"
    );
  }
  const [schemaFile, configFile] = await Promise.all([
    readSource(source, schemaPath),
    readSource(source, configPath.data)
  ]);
  const diagnostics: StudioConfigurationDiagnostic[] = [];
  if (schemaFile === undefined) {
    diagnostics.push(
      sourceDiagnostic(
        "configuration_schema_unavailable",
        "The declared workflow configuration schema is unavailable"
      )
    );
  }
  if (configFile === undefined) {
    diagnostics.push(
      sourceDiagnostic(
        "configuration_file_unavailable",
        "The declared workflow configuration file is unavailable"
      )
    );
  }
  const parsedSchema =
    schemaFile === undefined
      ? { valid: false as const }
      : parseStudioConfigurationSchema(schemaFile.content);
  const parsedConfig =
    configFile === undefined
      ? { valid: false as const }
      : parseStudioConfigurationValue(configFile.content);
  if (schemaFile !== undefined && !parsedSchema.valid) {
    diagnostics.push(
      sourceDiagnostic(
        "configuration_schema_invalid",
        "The declared workflow configuration schema is invalid"
      )
    );
  }
  if (configFile !== undefined && !parsedConfig.valid) {
    diagnostics.push(
      sourceDiagnostic(
        "configuration_file_invalid",
        "The declared workflow configuration file is invalid"
      )
    );
  }
  const configValid = studioConfigurationMatchesSchema(
    parsedSchema.schema,
    parsedConfig.value,
    parsedSchema.valid,
    parsedConfig.valid
  );
  if (
    schemaFile !== undefined &&
    configFile !== undefined &&
    parsedSchema.valid &&
    parsedConfig.valid &&
    !configValid
  ) {
    diagnostics.push(
      sourceDiagnostic(
        "configuration_schema_mismatch",
        "The workflow configuration does not match its declared schema"
      )
    );
  }

  return {
    workflowId,
    workflow,
    declared: true,
    references: studioConfigurationReferences(workflow.content),
    diagnostics,
    ...(schemaFile === undefined ? {} : { schemaFile }),
    ...(configFile === undefined ? {} : { configFile }),
    ...(parsedSchema.schema === undefined
      ? {}
      : { schema: parsedSchema.schema }),
    ...(parsedConfig.value === undefined
      ? {}
      : { value: parsedConfig.value }),
    schemaValid: parsedSchema.valid,
    configValid
  };
}
