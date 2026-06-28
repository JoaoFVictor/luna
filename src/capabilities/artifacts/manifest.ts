import { capabilityManifest } from "../../core/capabilities/manifest.js";
import {
  artifactPublisherOutputSchema,
  artifactRefSchema
} from "./publisher.js";

export const manifest = capabilityManifest({
  id: "artifacts",
  kind: "execution",
  version: "2026.06.25",
  artifact_publishers: {
    "artifacts.manifest_publisher": {
      id: "artifacts.manifest_publisher",
      source_node_ownership: "declaring_node",
      path_policy: "declared_path",
      overwrite_policy: "forbid",
      config_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          overwrite_policy: { enum: ["forbid", "replace"] }
        }
      },
      backend_requirements: ["artifact_manifest_store"],
      manifest_transaction: "required"
    }
  },
  ports: {
    "artifacts.manifest_store": {
      id: "artifacts.manifest_store",
      capability: "artifacts",
      option_schema: {
        type: "object",
        additionalProperties: false,
        required: ["backend"],
        properties: {
          backend: { type: "string" }
        }
      },
      lifecycle: ["validate", "open", "close"],
      error_codes: ["artifact_manifest_unavailable", "artifact_transaction_failed"]
    }
  },
  schemas: {
    "artifacts.artifact_ref": {
      id: "artifacts.artifact_ref",
      schema: artifactRefSchema
    },
    "artifacts.publisher_output": {
      id: "artifacts.publisher_output",
      schema: artifactPublisherOutputSchema
    }
  },
  docs: [{ title: "Artifact declarations and manifest publishing" }]
});
