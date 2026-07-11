import { matchesJsonSchema } from "./json-schema.js";
import type { JsonSchemaLike } from "./json-schema-types.js";
import {
  StudioPresentationSchema,
  type StudioFieldControl,
  type StudioFieldHint,
  type StudioPresentation
} from "./studio-presentation.js";
import { resolveStudioSchemaPointer } from "./studio-schema-pointer.js";
import { CapabilityValidationError } from "./validation-error.js";

export function validateStudioPresentation(
  value: unknown,
  label = "Studio presentation",
  ownerSchema?: JsonSchemaLike
): asserts value is StudioPresentation {
  const parsed = StudioPresentationSchema.safeParse(value);
  if (!parsed.success) {
    presentationError(label, "is structurally invalid");
  }
  const candidate = parsed.data;

  if (candidate.field_hints !== undefined) {
    if (ownerSchema === undefined) {
      presentationError(label, "field_hints require an owner schema");
    }
    for (const [pointer, hint] of Object.entries(candidate.field_hints)) {
      const hintPath = `${label}.field_hints[${JSON.stringify(pointer)}]`;
      if (hint === undefined) {
        presentationError(hintPath, "must define a field hint");
      }
      const fieldSchema = resolveStudioSchemaPointer(
        ownerSchema,
        pointer,
        hintPath
      );
      validateStudioFieldHint(hint, hintPath, fieldSchema);
    }
  }
}

function validateStudioFieldHint(
  candidate: StudioFieldHint,
  path: string,
  fieldSchema: JsonSchemaLike
): void {
  if (candidate.control !== undefined) {
    validateControlCompatibility(candidate.control, fieldSchema, path);
  }

  if (candidate.option_labels !== undefined) {
    validateOptionLabels(candidate.option_labels, fieldSchema, path);
  }
}

function validateControlCompatibility(
  control: StudioFieldControl,
  schema: JsonSchemaLike,
  path: string
): void {
  const finiteSelectDomain = finiteStringDomain(schema);
  const type =
    unambiguousSchemaType(schema) ??
    (finiteSelectDomain === undefined ? undefined : "string");
  const compatible =
    ((control === "text" || control === "textarea" || control === "select") &&
      type === "string") ||
    (control === "number" && (type === "number" || type === "integer")) ||
    (control === "switch" && type === "boolean") ||
    (control === "json" && (type === "object" || type === "array"));

  if (!compatible) {
    presentationError(
      path,
      `control ${control} is incompatible with schema type ${type ?? "ambiguous"}`
    );
  }

  if (control === "select" && finiteSelectDomain === undefined) {
    presentationError(path, "select requires a finite string schema domain");
  }
}

function unambiguousSchemaType(schema: JsonSchemaLike): string | undefined {
  if (typeof schema.type === "string") {
    return schema.type;
  }
  if (Array.isArray(schema.type) && schema.type.length === 1) {
    return schema.type[0];
  }
  return undefined;
}

function validateOptionLabels(
  labels: Readonly<Record<string, string>>,
  schema: JsonSchemaLike,
  path: string
): void {
  const domain = finiteStringDomain(schema);
  if (domain === undefined) {
    presentationError(path, "option_labels require a finite string schema domain");
  }
  const labelValues = Object.keys(labels);
  if (
    labelValues.length !== domain.length ||
    domain.some((option) => !Object.hasOwn(labels, option))
  ) {
    presentationError(path, "option_labels must exactly cover the schema domain");
  }
}

function finiteStringDomain(
  schema: JsonSchemaLike
): readonly string[] | undefined {
  const candidates = finiteDomainCandidates(schema);
  if (candidates === undefined || !isStringArray(candidates)) {
    return undefined;
  }

  const domain = [...new Set(candidates)].filter((candidate) =>
    matchesJsonSchema(schema, candidate)
  );
  return domain.length === 0 ? undefined : domain;
}

function finiteDomainCandidates(
  schema: JsonSchemaLike
): readonly unknown[] | undefined {
  if (schema.const !== undefined) {
    return [schema.const];
  }
  if (schema.enum !== undefined) {
    return schema.enum;
  }
  if (schema.oneOf === undefined) {
    return undefined;
  }

  const candidates: unknown[] = [];
  for (const branch of schema.oneOf) {
    const branchCandidates = finiteDomainCandidates(branch);
    if (branchCandidates === undefined) {
      return undefined;
    }
    candidates.push(...branchCandidates);
  }
  return candidates;
}

function isStringArray(values: readonly unknown[]): values is readonly string[] {
  return values.every((value) => typeof value === "string");
}

function presentationError(label: string, reason: string): never {
  throw new CapabilityValidationError(
    "capability_presentation_invalid",
    `${label} ${reason}.`
  );
}
