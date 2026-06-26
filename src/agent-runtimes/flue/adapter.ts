import {
  AgentRuntimeError,
  normalizeAgentRuntimeError,
  type AgentRuntimeDescriptor,
  type AgentRuntimePort,
  type RuntimeErrorCode,
  type RunAgentInput,
  type RunAgentOutput
} from "../../core/agent-runtime/contracts.js";
import {
  validateAgentRuntimeInput
} from "../../core/agent-runtime/validation.js";

type FlueAgentRuntimeRunner = (
  input: RunAgentInput
) => Promise<RunAgentOutput>;

type FlueAgentRuntimeAdapterOptions = {
  readonly runner?: FlueAgentRuntimeRunner;
};

const FLUE_DESCRIPTOR: AgentRuntimeDescriptor = {
  id: "flue",
  display_name: "Flue",
  supported_tool_protocols: ["local", "mcp"],
  supported_runtime_requirements: ["tool_calling", "mcp_tools"]
};

async function missingRunner(): Promise<RunAgentOutput> {
  throw new AgentRuntimeError(
    "runtime_unknown_failure",
    "Flue runtime runner has not been configured"
  );
}

const FLUE_ERROR_CODE_MAP = new Map<string, RuntimeErrorCode>([
  ["flue_auth_failed", "runtime_auth_failed"],
  ["flue_rate_limited", "runtime_rate_limited"],
  ["flue_provider_unavailable", "runtime_provider_unavailable"],
  ["flue_tool_materialization_failed", "runtime_tool_materialization_failed"],
  ["flue_output_schema_invalid", "runtime_output_schema_invalid"],
  ["flue_cancelled", "runtime_cancelled"],
  ["aborted", "runtime_cancelled"]
]);

function flueErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;

  return typeof code === "string" ? code : undefined;
}

function normalizeFlueRuntimeError(error: unknown): AgentRuntimeError {
  if (error instanceof AgentRuntimeError) {
    return error;
  }

  const code = flueErrorCode(error);
  const mapped = code === undefined ? undefined : FLUE_ERROR_CODE_MAP.get(code);
  if (mapped === undefined) {
    return normalizeAgentRuntimeError(error);
  }

  return new AgentRuntimeError(
    mapped,
    error instanceof Error ? error.message : "Unknown runtime failure",
    {
      cause: error,
      details: { original_code: code }
    }
  );
}

export function createFlueAgentRuntimeAdapter(
  options: FlueAgentRuntimeAdapterOptions = {}
): AgentRuntimePort {
  const runner = options.runner ?? missingRunner;

  return {
    describe(): AgentRuntimeDescriptor {
      return FLUE_DESCRIPTOR;
    },
    async validate(input: RunAgentInput): Promise<void> {
      await validateAgentRuntimeInput(input, FLUE_DESCRIPTOR);
    },
    async runAgent(input: RunAgentInput): Promise<RunAgentOutput> {
      await validateAgentRuntimeInput(input, FLUE_DESCRIPTOR);

      try {
        return await runner(input);
      } catch (error) {
        throw normalizeFlueRuntimeError(error);
      }
    }
  };
}
