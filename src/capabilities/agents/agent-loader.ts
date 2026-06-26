import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadJsonFile, loadYamlFile } from "../../core/config/loader.js";
import { assertSafeSegment, isInsideRoot } from "../../core/security/path.js";
import {
  AgentMetadataSchema,
  agentDefinitionError,
  assertNoDuplicateCapabilities,
  type LoadedAgentDefinition
} from "./agent-definition.js";

async function safeAgentDirectory(
  agentsRoot: string,
  agentId: string
): Promise<string> {
  assertSafeSegment(agentId);
  const root = path.resolve(agentsRoot);
  const directory = path.resolve(root, agentId);

  if (!isInsideRoot(root, directory)) {
    throw agentDefinitionError(
      `Agent directory escapes agents root: ${agentId}`,
      "agent_path_escape"
    );
  }

  const rootReal = await realpath(root);
  const directoryReal = await realpath(directory);

  if (!isInsideRoot(rootReal, directoryReal)) {
    throw agentDefinitionError(
      `Agent directory resolves outside agents root: ${agentId}`,
      "agent_path_escape"
    );
  }

  return directory;
}

async function checkedRealpath(
  filePath: string,
  relativePath: string
): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw agentDefinitionError(
        `Agent file path does not exist: ${relativePath}`,
        "agent_path_missing",
        cause
      );
    }

    throw cause;
  }
}

async function safeAgentPath(
  directory: string,
  relativePath: string
): Promise<string> {
  const root = path.resolve(directory);
  const resolved = path.resolve(root, relativePath);

  if (!isInsideRoot(root, resolved)) {
    throw agentDefinitionError(
      `Agent file path escapes agent directory: ${relativePath}`,
      "agent_path_escape"
    );
  }

  const rootReal = await realpath(root);
  const resolvedReal = await checkedRealpath(resolved, relativePath);

  if (!isInsideRoot(rootReal, resolvedReal)) {
    throw agentDefinitionError(
      `Agent file path resolves outside agent directory: ${relativePath}`,
      "agent_path_escape"
    );
  }

  return resolved;
}

export async function loadAgentDefinition(
  agentsRoot: string,
  agentId: string
): Promise<LoadedAgentDefinition> {
  const directory = await safeAgentDirectory(agentsRoot, agentId);
  const metadata = await loadYamlFile(
    path.join(directory, "agent.yaml"),
    AgentMetadataSchema
  );

  assertNoDuplicateCapabilities(metadata);

  if (metadata.id !== agentId) {
    throw agentDefinitionError(
      `Agent id ${metadata.id} does not match directory ${agentId}`,
      "agent_id_mismatch"
    );
  }

  const instructionsPath = await safeAgentPath(
    directory,
    metadata.instructions_file
  );
  const outputSchemaPath = await safeAgentPath(directory, metadata.output_schema);

  return {
    ...metadata,
    directory,
    instructionsPath,
    outputSchemaPath,
    instructions: await readFile(instructionsPath, "utf8"),
    outputSchema: await loadJsonFile(outputSchemaPath, z.unknown())
  };
}
