import path from "node:path";
import { sha256Digest } from "../../core/workflow/definition-digests.js";
import type { LoadedAgentDefinition } from "./agent-definition.js";

function logicalFileReference(directory: string, resolvedPath: string): string {
  return path.relative(directory, resolvedPath).split(path.sep).join("/");
}

/**
 * Computes the canonical revision for a fully loaded agent definition.
 *
 * Host-local paths are projected back to definition-relative references while
 * the complete instructions and resolved output schema remain revision-bound.
 */
export function agentDefinitionRevision(
  definition: LoadedAgentDefinition
): string {
  const {
    directory: _directory,
    instructionsPath: _instructionsPath,
    outputSchemaPath: _outputSchemaPath,
    instructions,
    outputSchema,
    ...metadata
  } = definition;

  const normalizedMetadata = {
    ...metadata,
    instructions_file: logicalFileReference(
      definition.directory,
      definition.instructionsPath
    ),
    output_schema: path.isAbsolute(definition.outputSchemaPath)
      ? logicalFileReference(
          definition.directory,
          definition.outputSchemaPath
        )
      : definition.outputSchemaPath
  };

  return sha256Digest({
    metadata: normalizedMetadata,
    instructions,
    output_schema: outputSchema
  });
}
