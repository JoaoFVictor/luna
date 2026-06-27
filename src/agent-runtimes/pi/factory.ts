import { runtimeError } from "../../core/runtime/errors.js";
import type { JsonObject } from "../../core/runtime/backends/contracts.js";
import type { AgentRuntimeFactory } from "../../runtime/composition/runtime-composition.js";
import { registerConfiguredPiOAuthProviders } from "./auth.js";
import { createPiAgentRuntimeAdapter } from "./adapter.js";

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw runtimeError(`${label} must be a positive integer`, "runtime_backend_invalid", {
      details: { value }
    });
  }

  return value;
}

export const piAgentRuntimeFactory = {
  id: "pi",
  async prepare({ configRoot, hasAgents }) {
    if (!hasAgents) {
      return;
    }

    await registerConfiguredPiOAuthProviders({ configRoot });
  },
  create: (options: JsonObject) =>
    createPiAgentRuntimeAdapter({
      maxToolIterations: optionalPositiveInteger(
        options.max_tool_iterations,
        "agent_runtime.options.max_tool_iterations"
      ),
      requestTimeoutMs: optionalPositiveInteger(
        options.request_timeout_ms,
        "agent_runtime.options.request_timeout_ms"
      )
    })
} satisfies AgentRuntimeFactory;
