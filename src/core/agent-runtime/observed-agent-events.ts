import type { RunAgentInput } from "./contracts.js";
import type { LunaUsageRecord } from "../observability/summary.js";
import { sanitizeJsonObject } from "../observability/sanitize.js";
import type { JsonObject } from "../runtime/json.js";

export type ObservedAgentEvent = {
  readonly type: "agent_call.started" | "agent_call.succeeded" | "agent_call.failed";
  readonly nodeId: string;
  readonly data: JsonObject;
};

export function agentStartedEvent({
  input,
  runtimeId
}: {
  readonly input: RunAgentInput;
  readonly runtimeId: string;
}): ObservedAgentEvent {
  return {
    type: "agent_call.started",
    nodeId: input.node_id,
    data: sanitizeJsonObject(baseAgentEventData(input, runtimeId))
  };
}

export function agentSucceededEvent({
  input,
  runtimeId,
  durationMs,
  usage,
  runtimeMetadata
}: {
  readonly input: RunAgentInput;
  readonly runtimeId: string;
  readonly durationMs: number;
  readonly usage: LunaUsageRecord | undefined;
  readonly runtimeMetadata: Record<string, unknown> | undefined;
}): ObservedAgentEvent {
  return {
    type: "agent_call.succeeded",
    nodeId: input.node_id,
    data: sanitizeJsonObject({
      ...baseAgentEventData(input, runtimeId),
      duration_ms: durationMs,
      ...(usage === undefined
        ? { usage_missing: true }
        : {
            tokens: usage.tokens,
            cost: usage.cost,
            provider: usage.provider,
            model: usage.model
          }),
      ...(runtimeMetadata === undefined ? {} : { runtime_metadata: runtimeMetadata })
    })
  };
}

export function agentFailedEvent({
  input,
  runtimeId,
  durationMs,
  cause
}: {
  readonly input: RunAgentInput;
  readonly runtimeId: string;
  readonly durationMs: number;
  readonly cause: unknown;
}): ObservedAgentEvent {
  return {
    type: "agent_call.failed",
    nodeId: input.node_id,
    data: sanitizeJsonObject({
      ...baseAgentEventData(input, runtimeId),
      duration_ms: durationMs,
      error: errorData(cause)
    })
  };
}

function baseAgentEventData(input: RunAgentInput, runtimeId: string): Record<string, unknown> {
  const mcpPolicy = input.tools.mcp_policy;

  return {
    agent_id: input.agent_id,
    agent_mode: input.agent_mode,
    runtime_id: runtimeId,
    model_profile: input.model_profile.model,
    ...(input.instructions_audit?.skills === undefined ||
    input.instructions_audit.skills.length === 0
      ? {}
      : { skills: input.instructions_audit.skills }),
    tools: {
      local_tool_ids: input.tools.tools
        .filter((tool) => tool.protocol === "local")
        .map((tool) => tool.id),
      mcp_server_ids: mcpPolicy?.servers.map((server) => server.id) ?? [],
      mcp_tool_ids: mcpPolicy?.tools.map((tool) => tool.id) ?? [],
      runtime_requirements: input.tools.runtime_requirements
    }
  };
}

function errorData(cause: unknown): Record<string, unknown> {
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return {
      name: cause.name,
      message: cause.message,
      ...(typeof code === "string" ? { code } : {})
    };
  }

  return { message: "Unknown agent runtime failure" };
}
