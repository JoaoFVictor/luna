import type { CapabilityRegistry } from "../capabilities/registry.js";
import { WorkflowDefinitionError } from "./definition-errors.js";
import {
  sha256Digest,
  type DefinitionDigestResolver
} from "./definition-digests.js";
import type { ParsedWorkflowNode } from "./definition-types.js";
import { collectWorkflowAgentReferences } from "./definition-references.js";

export const LUNA_WORKFLOW_COMPILER_SCHEMA_VERSION = "2026-06-25.task-3";
export const LUNA_WORKFLOW_RUNTIME_SCHEMA_VERSION = "2026-06-25.task-3";

export async function collectExternalDefinitionDigests(
  nodes: readonly ParsedWorkflowNode[],
  resolver: DefinitionDigestResolver | undefined
): Promise<Record<string, string>> {
  const references = new Set(
    collectWorkflowAgentReferences(nodes).map(
      ({ agentId }) => `agents/${agentId}/agent.yaml`
    )
  );

  const result: Record<string, string> = {};
  for (const reference of [...references].sort()) {
    try {
      result[reference] = resolver
        ? await resolver.digestExternalDefinition(reference)
        : "sha256:unresolved";
    } catch {
      throw new WorkflowDefinitionError(
        "workflow_external_definition_missing",
        `Unable to resolve external definition digest for ${reference}.`
      );
    }
  }
  return result;
}

export function computeWorkflowRevision({
  canonicalWorkflow,
  inputSchemaContent,
  outputSchemaContent,
  configSchemaContent,
  capabilities,
  externalDefinitionDigests,
  capabilityRegistry
}: {
  canonicalWorkflow: unknown;
  inputSchemaContent: unknown;
  outputSchemaContent: unknown;
  configSchemaContent?: unknown;
  capabilities: readonly string[];
  externalDefinitionDigests: Record<string, string>;
  capabilityRegistry?: CapabilityRegistry;
}): string {
  return sha256Digest({
    workflow: canonicalWorkflow,
    input_schema: inputSchemaContent,
    output_schema: outputSchemaContent,
    config_schema: configSchemaContent,
    capabilities: capabilityVersions(capabilities, capabilityRegistry),
    external_definitions: externalDefinitionDigests,
    compiler_schema_version: LUNA_WORKFLOW_COMPILER_SCHEMA_VERSION,
    runtime_schema_version: LUNA_WORKFLOW_RUNTIME_SCHEMA_VERSION
  });
}

function capabilityVersions(
  capabilities: readonly string[],
  registry: CapabilityRegistry | undefined
): Record<string, string> {
  return Object.fromEntries(
    [...capabilities].sort().map((id) => [
      id,
      registry?.has(id) ? registry.get(id).version : "unknown"
    ])
  );
}
