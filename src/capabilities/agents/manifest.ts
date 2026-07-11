import { capabilityManifest } from "../../core/capabilities/manifest.js";

const runtimeRequirementSchema = { type: "string", minLength: 1 } as const;

const agentInputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "run",
    "node_id",
    "agent_id",
    "agent_mode",
    "instructions",
    "input",
    "output_schema",
    "model_profile",
    "tools",
    "context",
    "signal",
    "events",
    "runtime_requirements"
  ],
  properties: {
    run: { type: "object" },
    node_id: { type: "string" },
    agent_id: { type: "string" },
    agent_mode: { enum: ["read_only", "trusted_local_write"] },
    instructions: { type: "string" },
    input: { description: "JSON input passed to the agent runtime." },
    output_schema: { type: "object" },
    model_profile: {
      type: "object",
      additionalProperties: false,
      required: ["model", "reasoning_effort"],
      properties: {
        model: { type: "string" },
        reasoning_effort: { enum: ["low", "medium", "high"] },
        transport: { enum: ["auto", "sse", "websocket"] }
      }
    },
    tools: {
      type: "object",
      additionalProperties: true,
      required: ["tools", "runtime_requirements"],
      properties: {
        tools: { type: "array", items: { type: "object" } },
        runtime_requirements: {
          type: "array",
          items: runtimeRequirementSchema
        }
      }
    },
    context: { description: "Workflow context passed to the agent runtime." },
    cwd: { type: "string" },
    signal: { description: "Opaque cancellation signal for in-memory runtime ports." },
    events: { description: "Opaque event sink for in-memory runtime ports." },
    runtime_requirements: {
      type: "array",
      items: runtimeRequirementSchema
    }
  }
} as const;

const agentOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["output"],
  properties: {
    output: { description: "Validated JSON output from the agent runtime." },
    usage: { type: "object" },
    runtime_metadata: { type: "object" }
  }
} as const;

const agentDefinitionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "description",
    "model_profile",
    "mode",
    "instructions",
    "outputSchema"
  ],
  properties: {
    id: { type: "string" },
    description: { type: "string" },
    model_profile: { type: "string" },
    mode: { enum: ["read_only", "trusted_local_write"] },
    instructions: { type: "string" },
    outputSchema: { type: "object" },
    skills: { type: "array", items: { type: "string" } },
    tools: { type: "array", items: { type: "string" } },
    mcp_servers: { type: "array", items: { type: "string" } },
    subagents: { type: "array", items: { type: "object" } },
    context: { type: "object" },
    runtime_requirements: {
      type: "array",
      items: runtimeRequirementSchema
    },
    runtime_preferences: { type: "object" },
    metadata: { type: "object" }
  }
} as const;

export const manifest = capabilityManifest({
  id: "agents",
  kind: "execution",
  version: "2026.06.25",
  workflow_node_types: ["agent"],
  ports: {
    "agents.runtime": {
      id: "agents.runtime",
      capability: "agents",
      option_schema: {
        type: "object",
        additionalProperties: false,
        required: ["runtime_id"],
        properties: {
          runtime_id: { type: "string" },
          supports_streaming: { type: "boolean" },
          supports_cancellation: { type: "boolean" }
        }
      },
      lifecycle: ["validate"],
      error_codes: [
        "runtime_unsupported_feature",
        "runtime_auth_failed",
        "runtime_rate_limited",
        "runtime_provider_unavailable",
        "runtime_tool_materialization_failed",
        "runtime_output_schema_invalid",
        "runtime_cancelled",
        "runtime_unknown_failure"
      ]
    }
  },
  schemas: {
    "agents.run_input": {
      id: "agents.run_input",
      schema: agentInputSchema
    },
    "agents.run_output": {
      id: "agents.run_output",
      schema: agentOutputSchema
    },
    "agents.agent_definition": {
      id: "agents.agent_definition",
      schema: agentDefinitionSchema
    }
  },
  docs: [{ title: "Reusable agent nodes" }]
});
