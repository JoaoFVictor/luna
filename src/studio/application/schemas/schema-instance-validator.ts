import {
  STUDIO_SCHEMA_DIAGNOSTICS_MAX,
  STUDIO_SCHEMA_VALIDATION_TIMEOUT_MS,
  StudioSchemaValidationRequestSchema,
  StudioSchemaValidationSchema,
  type StudioSchemaDiagnostic,
  type StudioSchemaValidation,
  type StudioSchemaValidationRequest
} from "../../contracts/schema-validation.js";
import {
  isolatedStudioSchemaExecutor,
  type StudioSchemaExecution,
  type StudioSchemaExecutor
} from "./isolated-schema-executor.js";
import { analyzeStudioJsonSchema } from "./schema-analysis.js";
import { studioSchemaDiagnosticsForMismatches } from "./schema-mismatch.js";

export class StudioSchemaRequestError extends Error {
  readonly code = "studio_schema_request_invalid" as const;

  constructor() {
    super("The Studio schema validation request is invalid");
    this.name = "StudioSchemaRequestError";
  }
}

export type StudioSchemaValidationService = {
  readonly validate: (
    request: StudioSchemaValidationRequest,
    signal: AbortSignal
  ) => Promise<StudioSchemaValidation>;
};

function prioritizedDiagnostics(
  diagnostics: readonly StudioSchemaDiagnostic[],
  requiredCode?: "instance_schema_mismatch" | "schema_invalid"
): readonly StudioSchemaDiagnostic[] {
  const required = requiredCode === undefined
    ? undefined
    : diagnostics.find((diagnostic) => diagnostic.code === requiredCode);
  const ordered = required === undefined
    ? [...diagnostics]
    : [required, ...diagnostics.filter((diagnostic) => diagnostic !== required)];
  if (ordered.length <= STUDIO_SCHEMA_DIAGNOSTICS_MAX) {
    return ordered;
  }
  return [
    ...ordered.slice(0, STUDIO_SCHEMA_DIAGNOSTICS_MAX - 1),
    {
      severity: "warning" as const,
      code: "diagnostics_truncated" as const,
      message: "Additional schema diagnostics were omitted"
    }
  ];
}

function internalSchemaFailure(): StudioSchemaDiagnostic {
  return {
    severity: "error",
    code: "schema_invalid",
    message: "The JSON Schema could not be validated safely",
    keyword: "schema",
    schema_path: "#"
  };
}

function boundaryFailure(
  execution: Extract<
    StudioSchemaExecution,
    { readonly kind: "cancelled" | "failed" | "timeout" }
  >
): StudioSchemaDiagnostic {
  switch (execution.kind) {
    case "cancelled":
      return {
        severity: "error",
        code: "schema_validation_cancelled",
        message: "Schema validation was cancelled"
      };
    case "failed":
      return {
        severity: "error",
        code: "schema_validation_failed",
        message: "Schema validation failed"
      };
    case "timeout":
      return {
        severity: "error",
        code: "schema_validation_timeout",
        message: "Schema validation timed out"
      };
  }
}

function validatedTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new Error("Studio schema timeout must be between 1 and 5000 ms");
  }
  return timeoutMs;
}

export function createStudioSchemaValidationService(
  options: {
    readonly executor?: StudioSchemaExecutor;
    readonly timeoutMs?: number;
  } = {}
): StudioSchemaValidationService {
  const executor = options.executor ?? isolatedStudioSchemaExecutor;
  const timeoutMs = validatedTimeout(
    options.timeoutMs ?? STUDIO_SCHEMA_VALIDATION_TIMEOUT_MS
  );

  return Object.freeze({
    async validate(request, signal) {
      const parsed = StudioSchemaValidationRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new StudioSchemaRequestError();
      }

      const analysis = analyzeStudioJsonSchema(parsed.data.schema);
      if (analysis.schema === undefined) {
        const diagnostics = analysis.diagnostics.some(
          (diagnostic) => diagnostic.code === "schema_invalid"
        )
          ? analysis.diagnostics
          : [...analysis.diagnostics, internalSchemaFailure()];
        return StudioSchemaValidationSchema.parse({
          status: "schema_invalid",
          diagnostics: prioritizedDiagnostics(diagnostics, "schema_invalid")
        });
      }

      let execution: StudioSchemaExecution;
      try {
        execution = await executor.validate({
          instance: parsed.data.instance,
          schema: analysis.schema,
          signal,
          timeoutMs
        });
      } catch {
        execution = { kind: "failed" };
      }
      if (execution.kind === "valid") {
        return StudioSchemaValidationSchema.parse({
          status: "valid",
          diagnostics: prioritizedDiagnostics(analysis.diagnostics)
        });
      }
      if (execution.kind === "invalid") {
        const diagnostics = [
          ...analysis.diagnostics,
          ...studioSchemaDiagnosticsForMismatches(execution.mismatches)
        ];
        return StudioSchemaValidationSchema.parse({
          status: "invalid",
          diagnostics: prioritizedDiagnostics(
            diagnostics,
            "instance_schema_mismatch"
          )
        });
      }
      return StudioSchemaValidationSchema.parse({
        status: "error",
        diagnostics: prioritizedDiagnostics([
          ...analysis.diagnostics,
          boundaryFailure(execution)
        ])
      });
    }
  });
}
