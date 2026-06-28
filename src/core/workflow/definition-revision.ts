import type { CapabilityRegistry } from "../capabilities/registry.js";
import { WorkflowDefinitionError } from "./definition-errors.js";
import {
  sha256Digest,
  type DefinitionDigestResolver
} from "./definition-digests.js";
import type { ParsedWorkflowNode } from "./definition-types.js";

export const LUNA_WORKFLOW_COMPILER_SCHEMA_VERSION = "2026-06-25.task-3";
export const LUNA_WORKFLOW_RUNTIME_SCHEMA_VERSION = "2026-06-25.task-3";

export async function collectExternalDefinitionDigests(
  nodes: readonly ParsedWorkflowNode[],
  resolver: DefinitionDigestResolver | undefined
): Promise<Record<string, string>> {
  const references = new Set<string>();
  for (const node of nodes) {
    if (node.type === "agent") {
      references.add(`agents/${node.agent}/agent.yaml`);
    }
    if (node.type === "pattern") {
      if (node.worker) {
        references.add(`agents/${node.worker}/agent.yaml`);
      }
      for (const gate of node.gates ?? []) {
        if ("agent" in gate && gate.agent) {
          references.add(`agents/${gate.agent}/agent.yaml`);
        }
        const reviewAgent = (gate.input as { review_agent?: unknown } | undefined)?.review_agent;
        if (typeof reviewAgent === "string") {
          references.add(`agents/${reviewAgent}/agent.yaml`);
        }
      }
    }
  }

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
  capabilities,
  externalDefinitionDigests,
  capabilityRegistry
}: {
  canonicalWorkflow: unknown;
  inputSchemaContent: unknown;
  outputSchemaContent: unknown;
  capabilities: readonly string[];
  externalDefinitionDigests: Record<string, string>;
  capabilityRegistry?: CapabilityRegistry;
}): string {
  return sha256Digest({
    workflow: canonicalWorkflow,
    input_schema: inputSchemaContent,
    output_schema: outputSchemaContent,
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
