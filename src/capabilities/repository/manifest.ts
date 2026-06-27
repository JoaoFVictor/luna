import { capabilityManifest } from "../../core/capabilities/manifest.js";
import {
  repositoryDeleteFileInputSchema,
  repositoryDeleteFileOutputSchema,
  repositoryEmptyInputSchema,
  repositoryReadFileInputSchema,
  repositoryReadFileOutputSchema,
  repositoryWriteFileInputSchema,
  repositoryWriteFileOutputSchema
} from "../../core/tools/repository-schemas.js";

export const manifest = capabilityManifest({
  id: "repository",
  kind: "execution",
  version: "2026.06.25",
  tools: {
    "repository.status": {
      id: "repository.status",
      protocol: "local",
      input_schema: repositoryEmptyInputSchema,
      output_schema: { type: "string" },
      runtime_requirements: ["tool_calling"],
      materialization: "local"
    },
    "repository.diff-summary": {
      id: "repository.diff-summary",
      protocol: "local",
      input_schema: repositoryEmptyInputSchema,
      output_schema: { type: "string" },
      runtime_requirements: ["tool_calling"],
      materialization: "local"
    },
    "repository.read-file": {
      id: "repository.read-file",
      protocol: "local",
      input_schema: repositoryReadFileInputSchema,
      output_schema: repositoryReadFileOutputSchema,
      runtime_requirements: ["tool_calling"],
      materialization: "local"
    },
    "repository.write-file": {
      id: "repository.write-file",
      protocol: "local",
      input_schema: repositoryWriteFileInputSchema,
      output_schema: repositoryWriteFileOutputSchema,
      runtime_requirements: ["tool_calling"],
      materialization: "local"
    },
    "repository.delete-file": {
      id: "repository.delete-file",
      protocol: "local",
      input_schema: repositoryDeleteFileInputSchema,
      output_schema: repositoryDeleteFileOutputSchema,
      runtime_requirements: ["tool_calling"],
      materialization: "local"
    }
  },
  docs: [{ title: "Repository read-only local tools" }]
});
