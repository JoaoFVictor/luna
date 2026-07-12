import type { CapabilityRegistry } from "../../core/capabilities/registry.js";
import {
  loadWorkflowDefinition,
  type WorkflowDefinition
} from "../../core/workflow/definition.js";
import { createAgentDefinitionDigestResolver } from "./definition-digest-resolver.js";

export type LoadWorkflowDefinitionWithAgentDigestsOptions = {
  readonly agentsRoot: string;
  readonly capabilityRegistry: CapabilityRegistry;
};

/**
 * Loads a workflow with agent references bound to canonical agent revisions.
 * Production and authoring callers should use this instead of manually wiring
 * a DefinitionDigestResolver.
 */
export async function loadWorkflowDefinitionWithAgentDigests(
  workflowsRoot: string,
  workflowId: string,
  options: LoadWorkflowDefinitionWithAgentDigestsOptions
): Promise<WorkflowDefinition> {
  return await loadWorkflowDefinition(workflowsRoot, workflowId, {
    agentsRoot: options.agentsRoot,
    capabilityRegistry: options.capabilityRegistry,
    digestResolver: createAgentDefinitionDigestResolver(options)
  });
}
