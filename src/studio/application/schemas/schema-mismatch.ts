import type { JsonSchemaMismatch } from "../../../core/capabilities/json-schema.js";
import type { StudioSchemaDiagnostic } from "../../contracts/schema-validation.js";
import { appendStudioSchemaPointer } from "./schema-pointers.js";

function pointer(
  root: "$" | "#",
  segments: JsonSchemaMismatch["instancePath"]
): string {
  return segments.reduce<string>(appendStudioSchemaPointer, root);
}

function diagnostic(mismatch: JsonSchemaMismatch): StudioSchemaDiagnostic {
  return {
    severity: "error",
    code: "instance_schema_mismatch",
    message: "The instance does not satisfy this JSON Schema constraint",
    keyword: mismatch.keyword,
    instance_path: pointer("$", mismatch.instancePath),
    schema_path: pointer("#", mismatch.schemaPath)
  };
}

export function studioSchemaDiagnosticsForMismatches(
  mismatches: readonly JsonSchemaMismatch[]
): readonly StudioSchemaDiagnostic[] {
  const diagnostics = mismatches.map(diagnostic);
  return diagnostics.length > 0
    ? diagnostics
    : [
        diagnostic({
          keyword: "schema",
          instancePath: [],
          schemaPath: []
        })
      ];
}
