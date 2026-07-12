import path from "node:path";
import YAML from "yaml";
import {
  AgentMetadataSchema,
  assertNoDuplicateCapabilities
} from "../../../capabilities/agents/agent-definition.js";
import {
  assertWorkflowDocument,
  parseWorkflowYaml,
  readCapabilities,
  requireString
} from "../../../core/workflow/definition-schema.js";
import {
  discoverStudioAgentResources,
  discoverStudioWorkflowResources
} from "../../application/drafts/authoring-resource-discovery.js";
import { StudioResourceHistoryError } from "../../application/history/errors.js";
import { isStudioHistorySensitivePath } from "../../application/history/snapshot-validation.js";
import type { StudioHistoricalResourceFile } from "../../application/history/ports.js";
import {
  studioEditableDefinitionFile,
  studioEditableResourceFile
} from "../../application/drafts/authoring-resource-paths.js";
import type { StudioPath } from "../../contracts/paths.js";
import type { StudioHistoryResource } from "../../contracts/resource-history.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function historicalInvalid(
  resource: StudioHistoryResource,
  message: string,
  cause?: unknown
): StudioResourceHistoryError {
  return new StudioResourceHistoryError(
    "studio_history_resource_invalid",
    message,
    { cause, details: { resource } }
  );
}

function assertSafeHistoricalReference(
  resource: StudioHistoryResource,
  relativePath: string
): StudioPath {
  const file = studioEditableResourceFile(resource, relativePath);
  if (file === undefined) {
    throw historicalInvalid(
      resource,
      "A historical resource reference escapes its entity directory"
    );
  }
  if (isStudioHistorySensitivePath(relativePath)) {
    throw historicalInvalid(
      resource,
      "A historical resource references a credential-sensitive file"
    );
  }
  return file;
}

function workflowPaths(
  resource: StudioHistoryResource,
  definition: string
): readonly StudioPath[] {
  let raw: Record<string, unknown>;
  let references: ReturnType<typeof discoverStudioWorkflowResources>;
  try {
    raw = assertWorkflowDocument(parseWorkflowYaml(definition));
    if (
      requireString(raw.id, "$.id") !== resource.id ||
      raw.type !== "workflow"
    ) {
      throw new Error("Historical workflow identity does not match its entity");
    }
    readCapabilities(raw.capabilities);
    references = discoverStudioWorkflowResources(definition);
    if (!references.canonical) {
      throw new Error("Historical workflow references are not canonical");
    }
  } catch (cause) {
    throw historicalInvalid(
      resource,
      "The historical workflow definition is invalid",
      cause
    );
  }
  return [
    studioEditableDefinitionFile(resource),
    ...references.editable.map((relativePath) =>
      assertSafeHistoricalReference(resource, relativePath)
    )
  ];
}

function agentPaths(
  resource: StudioHistoryResource,
  definition: string
): readonly StudioPath[] {
  let metadata: ReturnType<typeof AgentMetadataSchema.parse>;
  try {
    metadata = AgentMetadataSchema.parse(YAML.parse(definition));
    assertNoDuplicateCapabilities(metadata);
    if (metadata.id !== resource.id) {
      throw new Error("Historical agent identity does not match its entity");
    }
  } catch (cause) {
    throw historicalInvalid(
      resource,
      "The historical agent definition is invalid",
      cause
    );
  }
  const references = discoverStudioAgentResources(definition);
  if (!references.canonical) {
    throw historicalInvalid(
      resource,
      "The historical agent references are not canonical"
    );
  }
  return [
    studioEditableDefinitionFile(resource),
    ...references.editable.map((relativePath) =>
      assertSafeHistoricalReference(resource, relativePath)
    )
  ];
}

export function historicalResourcePaths(
  resource: StudioHistoryResource,
  definition: string
): readonly StudioPath[] {
  const paths =
    resource.kind === "workflow"
      ? workflowPaths(resource, definition)
      : agentPaths(resource, definition);
  return [
    ...new Map(paths.map((file) => [file.path, file])).values()
  ].sort((left, right) => left.path.localeCompare(right.path));
}

function decodeHistoricalFile(
  resource: StudioHistoryResource,
  file: StudioHistoricalResourceFile
): string {
  try {
    return UTF8_DECODER.decode(file.content);
  } catch (cause) {
    throw historicalInvalid(
      resource,
      "Historical Studio resources must contain UTF-8 text",
      cause
    );
  }
}

export function validateHistoricalResourceFiles(
  resource: StudioHistoryResource,
  files: readonly StudioHistoricalResourceFile[]
): void {
  for (const file of files) {
    const source = decodeHistoricalFile(resource, file);
    if (path.posix.extname(file.file.path).toLowerCase() !== ".json") {
      continue;
    }
    try {
      JSON.parse(source);
    } catch (cause) {
      throw historicalInvalid(
        resource,
        "A historical resource JSON file is invalid",
        cause
      );
    }
  }
}
