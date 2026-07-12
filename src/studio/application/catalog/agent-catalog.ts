import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { CapabilityRegistry } from "../../../core/capabilities/registry.js";
import { assertJsonValue } from "../../../core/json/value.js";
import { assertSafeSegment } from "../../../core/security/path.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import { loadAgentDefinition } from "../../../capabilities/agents/agent-loader.js";
import { agentDefinitionRevision } from "../../../capabilities/agents/agent-revision.js";
import {
  StudioAgentCatalogSchema,
  StudioAgentCatalogItemSchema,
  StudioCatalogDiagnosticSchema,
  type StudioAgentCatalog,
  type StudioAgentCatalogItem,
  type StudioCatalogDiagnostic
} from "../../contracts/catalog.js";
import {
  publicCatalogReference,
  relativeCatalogFileReference
} from "./public-references.js";

export type LoadStudioAgentCatalogOptions = {
  readonly agentsRoot: string;
  readonly capabilityRegistry: Pick<CapabilityRegistry, "registrations">;
};

function errorCode(cause: unknown): string {
  const code = (cause as { readonly code?: unknown }).code;
  return typeof code === "string" && code.length > 0
    ? code
    : "agent_catalog_entry_invalid";
}

function diagnostic(
  agentId: string,
  cause: unknown
): StudioCatalogDiagnostic {
  const code = errorCode(cause);
  return StudioCatalogDiagnosticSchema.parse({
    severity: "error",
    code,
    message: `Agent ${agentId} could not be loaded (${code}).`,
    resource_kind: "agent",
    resource_id: agentId
  });
}

async function assertDirectoryIsNotSymlink(
  agentsRoot: string,
  agentId: string
): Promise<void> {
  assertSafeSegment(agentId);
  const stats = await lstat(path.join(agentsRoot, agentId));
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    const error = new Error(
      `Agent catalog entry is not a physical directory: ${agentId}`
    ) as Error & { code: string };
    error.code = "agent_catalog_entry_not_directory";
    throw error;
  }
}

async function loadCatalogItem(
  options: LoadStudioAgentCatalogOptions,
  agentId: string
): Promise<StudioAgentCatalogItem> {
  await assertDirectoryIsNotSymlink(options.agentsRoot, agentId);
  const definition = await loadAgentDefinition(options.agentsRoot, agentId, {
    capabilityRegistry: options.capabilityRegistry
  });
  assertJsonValue(definition.outputSchema, `agent:${agentId}.output_schema`);

  const revision = agentDefinitionRevision(definition);

  return StudioAgentCatalogItemSchema.parse({
    id: definition.id,
    description: definition.description,
    mode: definition.mode,
    model_profile: definition.model_profile,
    output_schema_reference: path.isAbsolute(definition.outputSchemaPath)
      ? relativeCatalogFileReference(
          definition.directory,
          definition.outputSchemaPath,
          `agent ${agentId} output schema`
        )
      : publicCatalogReference(
          definition.outputSchemaPath,
          `agent ${agentId} output schema`
        ),
    output_schema: definition.outputSchema,
    skills: (definition.skills ?? []).map((skill) => {
      const label = `agent ${agentId} skill`;
      if (path.isAbsolute(skill)) {
        return publicCatalogReference(skill, label);
      }
      return relativeCatalogFileReference(
        path.dirname(path.resolve(options.agentsRoot)),
        path.resolve(definition.directory, skill),
        label
      );
    }),
    tools: definition.tools ?? [],
    mcp_servers: definition.mcp_servers ?? [],
    subagents: definition.subagents ?? [],
    runtime_requirements: definition.runtime_requirements ?? [],
    ...(definition.runtime_preferences?.preferred_runtime === undefined
      ? {}
      : {
          preferred_runtime:
            definition.runtime_preferences.preferred_runtime
        }),
    runtime_order: definition.runtime_preferences?.runtime_order ?? [],
    revision
  });
}

export async function loadStudioAgentCatalog(
  options: LoadStudioAgentCatalogOptions
): Promise<StudioAgentCatalog> {
  const entries = await readdir(options.agentsRoot, { withFileTypes: true }).catch(
    (cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw cause;
    }
  );
  const candidateIds = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const agents: StudioAgentCatalogItem[] = [];
  const diagnostics: StudioCatalogDiagnostic[] = [];

  for (const agentId of candidateIds) {
    try {
      agents.push(await loadCatalogItem(options, agentId));
    } catch (cause) {
      diagnostics.push(diagnostic(agentId, cause));
    }
  }

  return StudioAgentCatalogSchema.parse({
    status: diagnostics.length === 0 ? "complete" : "partial",
    fingerprint: sha256Digest({ agents, diagnostics }),
    agents,
    diagnostics
  });
}
