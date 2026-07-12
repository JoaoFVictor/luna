import { runtimeError } from "../../core/runtime/errors.js";
import type { CapabilityRegistry } from "../../core/capabilities/registry.js";
import type { WorkflowDefinition, WorkflowNode } from "../../core/workflow/definition-types.js";
import type { RuntimeMode } from "./app-config.js";

export type RuntimeDurabilityRequirement =
  | "trusted_local_write"
  | "write_mode"
  | "human_gate"
  | "interrupt_gate"
  | "write_side_effect"
  | "external_side_effect";

export type RuntimeDurabilityPolicyInput = {
  readonly mode: RuntimeMode;
  readonly checkpointBackendId: string;
  readonly checkpointDurable?: boolean;
  readonly workflow?: {
    readonly id: string;
    readonly mode?: "read_only" | "trusted_local_write";
    readonly writeMode?: boolean;
  };
  readonly workflowDefinition?: Pick<WorkflowDefinition, "id" | "mode" | "graph">;
  readonly capabilityRegistry?: CapabilityRegistry;
  readonly requiresHumanInterrupts?: boolean;
  readonly hasExternalSideEffects?: boolean;
};

export function assertRuntimeDurabilityPolicy(
  input: RuntimeDurabilityPolicyInput
): void {
  if (input.mode === "test" || input.checkpointDurable === true) {
    return;
  }

  const requirements = classifyRuntimeDurabilityRequirements(input);
  if (requirements.length === 0) {
    return;
  }

  throw runtimeError(
    "Production runs with human interrupts, side effects, or write workflows require durable checkpointing",
    "runtime_backend_invalid",
    {
      details: {
        checkpoint_backend_id: input.checkpointBackendId,
        workflow_id: input.workflowDefinition?.id ?? input.workflow?.id,
        workflow_write_mode: input.workflow?.writeMode,
        durability_requirements: requirements,
        requires_human_interrupts: input.requiresHumanInterrupts,
        has_external_side_effects: input.hasExternalSideEffects
      }
    }
  );
}

export function classifyRuntimeDurabilityRequirements(
  input: Omit<RuntimeDurabilityPolicyInput, "mode" | "checkpointBackendId">
): RuntimeDurabilityRequirement[] {
  const requirements = new Set<RuntimeDurabilityRequirement>();
  const workflowMode = input.workflowDefinition?.mode ?? input.workflow?.mode;

  if (workflowMode === "trusted_local_write") {
    requirements.add("trusted_local_write");
  }
  if (input.workflow?.writeMode === true) {
    requirements.add("write_mode");
  }
  if (input.requiresHumanInterrupts === true) {
    requirements.add("human_gate");
  }
  if (input.hasExternalSideEffects === true) {
    requirements.add("external_side_effect");
  }

  for (const node of input.workflowDefinition?.graph.nodes ?? []) {
    addNodeRequirements(node, input.capabilityRegistry, requirements);
  }

  return [...requirements].sort();
}

function addNodeRequirements(
  node: WorkflowNode,
  registry: CapabilityRegistry | undefined,
  requirements: Set<RuntimeDurabilityRequirement>
): void {
  if (node.type === "human_gate") {
    requirements.add("human_gate");
  }

  if (node.type !== "workflow") {
    for (const policy of node.policies ?? []) {
      if (isWritePolicy(policy.uses, registry)) {
        requirements.add("write_side_effect");
      }
    }
  }

  if (node.type !== "pattern") {
    return;
  }

  for (const gate of node.gates ?? []) {
    if (isInterruptGate(gate.type, registry)) {
      requirements.add("interrupt_gate");
    }
  }
}

function isWritePolicy(
  policyId: string,
  registry: CapabilityRegistry | undefined
): boolean {
  return registry?.registrations().policies.get(policyId)?.side_effect_semantics === "write";
}

function isInterruptGate(
  gateType: string,
  registry: CapabilityRegistry | undefined
): boolean {
  const gate = registry?.registrations().gates.get(gateType);

  return gate !== undefined && gate.interrupt !== "none";
}
