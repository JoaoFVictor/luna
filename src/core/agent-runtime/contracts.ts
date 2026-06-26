import { z } from "zod";
import type { ModelProfile } from "../config/schemas.js";
import type { RunHandle } from "../runtime/run-handle.js";
import type { ResolvedToolCatalog } from "../tools/resolved-catalog.js";
import { ValidationResultSchema } from "../validation/runner.js";

const NonEmptyStringSchema = z.string().min(1);

export const AgentRuntimeRequirementSchema = z.enum([
  "tool_calling",
  "mcp_tools"
]);
export type AgentRuntimeRequirement = z.infer<
  typeof AgentRuntimeRequirementSchema
>;

export const RuntimeErrorCodeSchema = z.enum([
  "runtime_unsupported_feature",
  "runtime_auth_failed",
  "runtime_rate_limited",
  "runtime_provider_unavailable",
  "runtime_tool_materialization_failed",
  "runtime_output_schema_invalid",
  "runtime_cancelled",
  "runtime_unknown_failure"
]);
export type RuntimeErrorCode = z.infer<typeof RuntimeErrorCodeSchema>;

export const ToolProtocolSchema = z.enum(["local", "mcp"]);
export type ToolProtocol = z.infer<typeof ToolProtocolSchema>;

export type AgentRuntimeUsage = {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly [key: string]: unknown;
};

export type AgentRuntimeDescriptor = {
  readonly id: string;
  readonly display_name: string;
  readonly supported_tool_protocols: readonly ToolProtocol[];
  readonly supported_runtime_requirements: readonly AgentRuntimeRequirement[];
};

export type AgentRuntimeEventSink = {
  emit(event: {
    readonly type: string;
    readonly data?: unknown;
  }): Promise<void> | void;
};

export type RunAgentInput = {
  readonly run: RunHandle;
  readonly node_id: string;
  readonly agent_id: string;
  readonly agent_mode: "read_only" | "trusted_local_write";
  readonly instructions: string;
  readonly input: unknown;
  readonly output_schema: unknown;
  readonly model_profile: ModelProfile;
  readonly tools: ResolvedToolCatalog;
  readonly context: unknown;
  readonly cwd?: string;
  readonly runtime_requirements: readonly AgentRuntimeRequirement[];
  readonly signal: AbortSignal | undefined;
  readonly events: AgentRuntimeEventSink | undefined;
};

export type RunAgentOutput = {
  readonly output: unknown;
  readonly usage?: AgentRuntimeUsage;
  readonly runtime_metadata?: Record<string, unknown>;
};

export type AgentRuntimePort = {
  describe(): AgentRuntimeDescriptor;
  validate(input: RunAgentInput): Promise<void> | void;
  runAgent(input: RunAgentInput): Promise<RunAgentOutput>;
};

export const AgentRuntimePortSchema = z.custom<AgentRuntimePort>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as AgentRuntimePort).describe === "function" &&
    typeof (value as AgentRuntimePort).validate === "function" &&
    typeof (value as AgentRuntimePort).runAgent === "function",
  "AgentRuntimePort must expose describe, validate, and runAgent"
);

export class AgentRuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options: {
      readonly details?: Record<string, unknown>;
      readonly cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "AgentRuntimeError";
    this.code = code;
    this.details = options.details;
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;

  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown runtime failure";
}

export function normalizeAgentRuntimeError(error: unknown): AgentRuntimeError {
  if (error instanceof AgentRuntimeError) {
    return error;
  }

  return new AgentRuntimeError("runtime_unknown_failure", errorMessage(error), {
    cause: error,
    ...(errorCode(error) === undefined ? {} : { details: { original_code: errorCode(error) } })
  });
}

export const GateResultSchema = z
  .object({
    id: NonEmptyStringSchema,
    type: NonEmptyStringSchema,
    passed: z.boolean(),
    feedback: z.string().optional(),
    output: z.unknown().optional()
  })
  .strict();
export type GateResult = z.infer<typeof GateResultSchema>;

export const GatedAgentLoopAttemptSchema = z
  .object({
    attempt: z.number().int().positive(),
    phase: z.enum(["initial", "repair"]),
    agent_output: z.unknown().optional(),
    agent_error: z
      .object({
        message: NonEmptyStringSchema,
        code: NonEmptyStringSchema.optional()
      })
      .strict()
      .optional(),
    validation: ValidationResultSchema.optional(),
    gate_results: z.array(GateResultSchema).optional(),
    diff_summary: z.unknown().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional()
  })
  .strict();
export type GatedAgentLoopAttempt = z.infer<typeof GatedAgentLoopAttemptSchema>;

export const GatedAgentLoopResultSchema = z
  .object({
    status: z.enum(["passed", "failed"]),
    attempts_exhausted: z.boolean(),
    attempts: z.array(GatedAgentLoopAttemptSchema),
    validation: ValidationResultSchema,
    final_validation: ValidationResultSchema,
    gates: z.array(GateResultSchema),
    result: z
      .object({
        status: NonEmptyStringSchema
      })
      .passthrough()
  })
  .strict();
export type GatedAgentLoopResult = z.infer<typeof GatedAgentLoopResultSchema>;
