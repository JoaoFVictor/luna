import path from "node:path";
import { isNamespacedCapabilityId } from "../capabilities/ids.js";
import { WorkflowDefinitionError } from "./definition-errors.js";
import {
  assertKnownFields,
  assertObject,
  assertWorkflowDocument,
  parseWorkflowYaml,
  readGraph,
  requireString
} from "./definition-schema.js";
import type { ParsedWorkflowNode } from "./definition-types.js";

export type WorkflowAgentReference = {
  readonly agentId: string;
  readonly outputSchema?: string;
};

export type WorkflowConfigReference = {
  readonly file: string;
  readonly schema: string;
};

export type WorkflowDefinitionReferences = {
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly config?: WorkflowConfigReference;
  readonly agents: readonly WorkflowAgentReference[];
  readonly workflows: readonly string[];
};

export function collectWorkflowAgentReferences(
  nodes: readonly ParsedWorkflowNode[]
): readonly WorkflowAgentReference[] {
  const references: WorkflowAgentReference[] = [];
  for (const node of nodes) {
    if (node.type === "loop") {
      references.push(...collectWorkflowAgentReferences(node.body.nodes));
      continue;
    }
    if (node.type === "agent") {
      references.push({
        agentId: node.agent,
        ...(!node.output_schema.endsWith(".json") &&
        isNamespacedCapabilityId(node.output_schema)
          ? {}
          : { outputSchema: node.output_schema })
      });
      continue;
    }
    if (node.type !== "pattern") {
      continue;
    }
    if (node.worker !== undefined) {
      references.push({ agentId: node.worker });
    }
    for (const gate of node.gates ?? []) {
      const reviewAgent = gate.input?.review_agent;
      if (typeof reviewAgent === "string" && reviewAgent !== "") {
        references.push({ agentId: reviewAgent });
      }
    }
  }
  return references;
}

export function collectWorkflowCallReferences(
  nodes: readonly ParsedWorkflowNode[]
): readonly string[] {
  const references = new Set<string>();
  for (const node of nodes) {
    if (node.type === "workflow") {
      references.add(node.workflow);
    } else if (node.type === "loop") {
      for (const workflowId of collectWorkflowCallReferences(node.body.nodes)) {
        references.add(workflowId);
      }
    }
  }
  return [...references].sort((left, right) => left.localeCompare(right));
}

export function collectWorkflowRegistrationReferences(
  nodes: readonly ParsedWorkflowNode[]
): readonly string[] {
  const references = new Set<string>();
  for (const node of nodes) {
    if (node.type === "loop") {
      for (const reference of collectWorkflowRegistrationReferences(node.body.nodes)) {
        references.add(reference);
      }
      continue;
    }
    if (node.type === "workflow") {
      continue;
    }
    if (node.type !== "agent") {
      references.add(node.uses);
    } else if (
      !node.output_schema.endsWith(".json") &&
      isNamespacedCapabilityId(node.output_schema)
    ) {
      references.add(node.output_schema);
    }
    for (const policy of node.policies ?? []) {
      references.add(policy.uses);
    }
    for (const artifact of node.artifacts ?? []) {
      references.add(artifact.publisher);
    }
    if (node.type === "pattern") {
      for (const gate of node.gates ?? []) {
        references.add(gate.type);
      }
    }
  }
  return [...references].sort((left, right) => left.localeCompare(right));
}

export function readWorkflowConfigReference(
  value: unknown
): WorkflowConfigReference | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = assertObject(value, "$.config");
  assertKnownFields(raw, new Set(["file", "schema"]), "$.config");
  const file = requireString(raw.file, "$.config.file");
  const schema = requireString(raw.schema, "$.config.schema");
  if (
    file.trim() === "" ||
    path.isAbsolute(file) ||
    file.split(/[\\/]/).includes("..")
  ) {
    throw new WorkflowDefinitionError(
      "workflow_path_escape",
      `Workflow config file path escapes config directory: ${file}`,
      { path: "$.config.file" }
    );
  }
  return { file, schema };
}

export function readWorkflowDefinitionReferences(
  source: string
): WorkflowDefinitionReferences {
  const raw = assertWorkflowDocument(parseWorkflowYaml(source));
  const graph = readGraph(raw);
  const config = readWorkflowConfigReference(raw.config);
  return {
    inputSchema: requireString(raw.input_schema, "$.input_schema"),
    outputSchema: requireString(raw.output_schema, "$.output_schema"),
    ...(config === undefined ? {} : { config }),
    agents: collectWorkflowAgentReferences(graph.nodes),
    workflows: collectWorkflowCallReferences(graph.nodes)
  };
}
