import type { LocalToolContract } from "../../core/tools/contracts.js";
import {
  RelatedContextConfigJsonSchema,
  RelatedContextTaskJsonSchema
} from "./contracts.js";
import { RepositoryContextQueryOutputJsonSchema } from "./output-schemas.js";

export const repositoryContextQueryInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: RelatedContextTaskJsonSchema,
    config: RelatedContextConfigJsonSchema,
    expected_snapshot_id: {
      type: "string",
      pattern: "^sha256:[0-9a-f]{64}$"
    }
  }
} as const;

export const repositoryContextQueryOutputJsonSchema =
  RepositoryContextQueryOutputJsonSchema;

export const repositoryContextQueryToolContract = {
  id: "repository-context.query",
  description: "Query the bound repository's canonical impact index with bounded task, path, and symbol hints; agent calls are pinned to the supplied repository-context snapshot.",
  input_schema: repositoryContextQueryInputJsonSchema,
  output_schema: repositoryContextQueryOutputJsonSchema,
  safety: { localWrites: false, network: false, externalSideEffects: false },
  modes: ["read_only", "trusted_local_write"],
  runtime_requirements: ["tool_calling"]
} as const satisfies LocalToolContract;
