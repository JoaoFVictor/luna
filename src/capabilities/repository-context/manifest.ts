import { capabilityManifest } from "../../core/capabilities/manifest.js";
import { localToolRegistrations } from "../../core/tools/local-tool-registration.js";
import {
  RelatedContextConfigJsonSchema,
  RelatedContextTaskJsonSchema
} from "./contracts.js";
import { WorktreeDiffJsonSchema } from "../git/diff/worktree-diff-contracts.js";
import { RepoContextJsonSchema } from "../git/diff/repo-context-json-schema.js";
import { RelatedContextOutputJsonSchema } from "./output-schemas.js";
import { repositoryContextLocalTools } from "./tools.js";

export const manifest = capabilityManifest({
  id: "repository-context",
  kind: "execution",
  version: "2026.07.13",
  tools: localToolRegistrations(repositoryContextLocalTools),
  built_ins: {
    "repository-context.related_context": {
      id: "repository-context.related_context",
      input_schema: {
        type: "object",
        additionalProperties: false,
        oneOf: [
          { required: ["repo_context"] },
          { required: ["task"] },
          { required: ["worktree_diff"] }
        ],
        properties: {
          repo_context: RepoContextJsonSchema,
          task: RelatedContextTaskJsonSchema,
          worktree_diff: {
            type: "object",
            additionalProperties: false,
            required: ["diff"],
            properties: {
              diff: {
                ...WorktreeDiffJsonSchema
              },
              task: RelatedContextTaskJsonSchema
            }
          },
          config: RelatedContextConfigJsonSchema
        }
      },
      output_schema: RelatedContextOutputJsonSchema,
      required_ports: []
    }
  },
  docs: [{ title: "Repository impact context for code review" }]
});
