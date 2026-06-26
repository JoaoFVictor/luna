import { capabilityManifest } from "../../core/capabilities/manifest.js";

const agentInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agent_id", "input", "output_schema"],
  properties: {
    agent_id: { type: "string" },
    input: { description: "JSON input passed to the agent runtime." },
    output_schema: { type: "object" },
    runtime_requirements: {
      type: "array",
      items: { type: "string" }
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

export const manifest = capabilityManifest({
  id: "agents",
  kind: "execution",
  version: "2026.06.25",
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
    }
  },
  docs: [{ title: "Reusable agent nodes" }]
});
