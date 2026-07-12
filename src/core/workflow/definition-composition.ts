import { WorkflowDefinitionError } from "./definition-errors.js";
import type {
  ParsedWorkflowGraph,
  WorkflowDefinition,
  WorkflowRequirements
} from "./definition-types.js";

export async function resolveWorkflowCompositions(options: {
  readonly graph: ParsedWorkflowGraph;
  readonly parentId: string;
  readonly parentMode: "read_only" | "trusted_local_write";
  readonly resolver?: (workflowId: string) => Promise<WorkflowDefinition>;
}): Promise<Record<string, WorkflowDefinition>> {
  const ids = [...new Set(
    options.graph.nodes.flatMap((node) =>
      node.type === "workflow" ? [node.workflow] : []
    )
  )].sort();
  if (ids.length > 0 && options.resolver === undefined) {
    throw new WorkflowDefinitionError(
      "workflow_external_definition_missing",
      `Workflow ${options.parentId} contains composition references without a resolver.`
    );
  }
  const entries = await Promise.all(ids.map(async (childId) => {
    const child = await options.resolver!(childId);
    if (
      options.parentMode === "read_only" &&
      child.mode === "trusted_local_write"
    ) {
      throw new WorkflowDefinitionError(
        "workflow_composition_mode_invalid",
        `Read-only workflow ${options.parentId} cannot compose trusted-write workflow ${childId}.`
      );
    }
    if (!workflowSupportsSynchronousComposition(child)) {
      throw new WorkflowDefinitionError(
        "workflow_composition_interrupt_unsupported",
        `Composed workflow ${childId} can suspend for human input; synchronous composition does not support HITL yet.`
      );
    }
    return [childId, child] as const;
  }));
  return Object.fromEntries(entries);
}

export function assertWorkflowCompositionRequirements(options: {
  readonly parentId: string;
  readonly requirements: WorkflowRequirements;
  readonly compositions: Readonly<Record<string, WorkflowDefinition>>;
}): void {
  const repositoryChild = Object.values(options.compositions).find(
    (child) => child.requires.repository
  );
  if (!options.requirements.repository && repositoryChild !== undefined) {
    throw new WorkflowDefinitionError(
      "workflow_composition_requirement_missing",
      `Workflow ${options.parentId} must declare repository authority because composed workflow ${repositoryChild.id} requires it.`
    );
  }
}

export function workflowSupportsSynchronousComposition(
  workflow: WorkflowDefinition
): boolean {
  return !workflowTreeContainsInterrupt(workflow);
}

function workflowTreeContainsInterrupt(workflow: WorkflowDefinition): boolean {
  return workflow.graph.nodes.some((node) => node.type === "human_gate") ||
    Object.values(workflow.compositions ?? {}).some(workflowTreeContainsInterrupt);
}
