import { capabilityManifest } from "../../core/capabilities/manifest.js";

const workspaceRefSchema = {
  type: "object",
  additionalProperties: true,
  required: ["run_id", "path", "preserved", "reason"],
  properties: {
    run_id: { type: "string" },
    path: { type: "string" },
    preserved: { type: "boolean" },
    reason: { type: "string" },
    repository_id: { type: "string" },
    branch: { type: "string" },
    remote: { type: "string" },
    base_ref: { type: "string" },
    base_sha: { type: "string" }
  }
} as const;

export const manifest = capabilityManifest({
  id: "repository-workspace",
  kind: "execution",
  version: "2026.06.25",
  ports: {
    "repository-workspace.manager": {
      id: "repository-workspace.manager",
      capability: "repository-workspace",
      option_schema: {
        type: "object",
        additionalProperties: false,
        required: ["repository_id"],
        properties: {
          repository_id: { type: "string" },
          lock_timeout_ms: { type: "number", minimum: 1 }
        }
      },
      lifecycle: ["validate", "open", "close"],
      error_codes: ["workspace_unavailable", "workspace_lock_conflict"]
    }
  },
  built_ins: {
    "repository-workspace.capture": {
      id: "repository-workspace.capture",
      input_schema: {
        type: "object",
        additionalProperties: false
      },
      output_schema: workspaceRefSchema,
      required_ports: ["repository-workspace.manager"]
    }
  },
  docs: [{ title: "Repository workspace capture, locks, and lifecycle" }]
});
