import { loadAgentDefinition } from "../../../capabilities/agents/agent-loader.js";
import { lunaToolCatalog } from "../../../capabilities/repository/tool-catalog.js";
import type { CapabilityRegistry } from "../../../core/capabilities/registry.js";
import type { AnyLunaToolDefinition } from "../../../core/tools/contracts.js";
import { collectWorkflowAgentReferences } from "../../../core/workflow/definition-references.js";
import type { WorkflowDefinition } from "../../../core/workflow/definition-types.js";
import { composedWorkflowNodes } from "../../../core/workflow/composition.js";
import { studioRunValueDigest } from "../../application/runs/launch-digests.js";
import type {
  StudioRunEffectCategory,
  StudioRunEffectUncertainty,
  StudioRunPlanWarning,
  StudioRunPotentialEffect,
  StudioRunResolvedEffect
} from "../../contracts/run-launch.js";

export type NativeStudioRunEffects = {
  readonly potential_effects: readonly StudioRunPotentialEffect[];
  readonly resolved_effects: readonly StudioRunResolvedEffect[];
  readonly effect_uncertainties: readonly StudioRunEffectUncertainty[];
  readonly warnings: readonly StudioRunPlanWarning[];
};

const nativeLocalTools: Readonly<Record<string, AnyLunaToolDefinition>> =
  lunaToolCatalog;

function effectId(
  kind: "effect" | "uncertainty" | "resolved",
  material: unknown
): string {
  return `${kind}:${studioRunValueDigest(material).slice("sha256:".length)}`;
}

function effectForPolicy(options: {
  readonly nodeId: string;
  readonly registrationId: string;
  readonly policyId: string;
  readonly operationId: string;
  readonly semantics: "none" | "read" | "write" | undefined;
  readonly category: StudioRunEffectCategory | undefined;
  readonly retrySemantics:
    | "replay_safe"
    | "retry_requires_adoption"
    | "retry_forbidden"
    | undefined;
  readonly idempotencyScope:
    | "run"
    | "node"
    | "attempt"
    | "external_resource"
    | undefined;
}): StudioRunPotentialEffect | undefined {
  if (options.semantics === undefined || options.semantics === "none") {
    return undefined;
  }
  const confirmationRequired = options.semantics === "write";
  // Older third-party manifests remain safe and deterministic: unknown writes
  // are presented conservatively as external writes, while unknown reads use
  // the generic provider-read category. No operation-id naming convention is
  // part of this decision.
  const category = options.category ?? (confirmationRequired
    ? "external_write"
    : "provider_read");
  return {
    effect_id: effectId("effect", {
      node_id: options.nodeId,
      registration_id: options.registrationId,
      policy_id: options.policyId,
      operation_id: options.operationId
    }),
    category,
    description: confirmationRequired
      ? `Node ${options.nodeId} may perform write operation ${options.operationId}.`
      : `Node ${options.nodeId} may perform read operation ${options.operationId}.`,
    confirmation_required: confirmationRequired,
    ...(options.retrySemantics === undefined
      ? {}
      : { retry_semantics: options.retrySemantics }),
    ...(options.idempotencyScope === undefined
      ? {}
      : { idempotency_scope: options.idempotencyScope }),
    operation_id: options.operationId,
    policy_id: options.policyId,
    registration_id: options.registrationId,
    node_id: options.nodeId
  };
}

function declaredEffects(
  workflow: WorkflowDefinition,
  registry: CapabilityRegistry
): StudioRunPotentialEffect[] {
  const indexes = registry.registrations();
  const effects = new Map<string, StudioRunPotentialEffect>();
  for (const entry of composedWorkflowNodes(workflow)) {
    const { node, qualifiedNodeId: nodeId } = entry;
    if (node.type === "human_gate" || node.type === "workflow" || node.type === "loop") {
      continue;
    }
    const registrationId = node.type === "agent" ? node.agent : node.uses;
    const implicitPolicy = node.type === "built_in"
      ? indexes.built_ins.get(node.uses)?.side_effect_policy
      : undefined;
    const policyIds = new Set<string>([
      ...(implicitPolicy === undefined
        ? []
        : [implicitPolicy]),
      ...(node.policies ?? []).map(({ uses }) => uses)
    ]);
    for (const policyId of policyIds) {
      const policy = indexes.policies.get(policyId);
      for (const operationId of policy?.side_effect_operation_ids ?? []) {
        const effect = effectForPolicy({
          nodeId,
          registrationId,
          policyId,
          operationId,
          semantics: policy?.side_effect_semantics,
          category: policy?.side_effect_category,
          retrySemantics: policy?.retry_semantics,
          idempotencyScope: policy?.idempotency_scope
        });
        if (effect !== undefined) {
          effects.set(effect.effect_id, effect);
        }
      }
    }
  }
  return [...effects.values()];
}

function agentMayIncludeUnlistedWrite(
  agent: Awaited<ReturnType<typeof loadAgentDefinition>>
): boolean {
  if (
    agent.mode === "trusted_local_write" ||
    (agent.mcp_servers ?? []).length > 0
  ) {
    return true;
  }
  return (agent.tools ?? []).some((toolId) => {
    const tool = nativeLocalTools[toolId];
    return tool === undefined ||
      tool.safety.localWrites ||
      tool.safety.network ||
      tool.safety.externalSideEffects;
  });
}

async function agentEffects(
  workflow: WorkflowDefinition,
  agentsRoot: string,
  registry: CapabilityRegistry
): Promise<{
  readonly effects: readonly StudioRunPotentialEffect[];
  readonly uncertainties: readonly StudioRunEffectUncertainty[];
}> {
  const entries = composedWorkflowNodes(workflow);
  const references = collectWorkflowAgentReferences(entries.map(({ node }) => node));
  const agents = new Map(
    await Promise.all(
      [...new Set(references.map(({ agentId }) => agentId))]
        .sort((left, right) => left.localeCompare(right))
        .map(async (agentId) => [
          agentId,
          await loadAgentDefinition(agentsRoot, agentId, {
            capabilityRegistry: registry
          })
        ] as const)
    )
  );
  const effects: StudioRunPotentialEffect[] = [];
  const uncertainties: StudioRunEffectUncertainty[] = [];
  for (const { node, qualifiedNodeId: nodeId } of entries) {
    const agentIds = node.type === "agent"
      ? [node.agent]
      : node.type === "pattern"
        ? [
            ...(node.worker === undefined ? [] : [node.worker]),
            ...(node.gates ?? []).flatMap((gate) => {
              const reviewAgent = gate.input?.review_agent;
              return typeof reviewAgent === "string" ? [reviewAgent] : [];
            })
          ]
        : [];
    for (const agentId of [...new Set(agentIds)]) {
      const agent = agents.get(agentId);
      if (agent === undefined) {
        continue;
      }
      effects.push({
        effect_id: effectId("effect", {
          node_id: nodeId,
          agent_id: agentId,
          kind: "model"
        }),
        category: "model_call",
        description: `Node ${nodeId} may invoke model agent ${agentId}.`,
        confirmation_required: false,
        retry_semantics: "retry_forbidden",
        idempotency_scope: "attempt",
        registration_id: agentId,
        node_id: nodeId
      });
      uncertainties.push({
        uncertainty_id: effectId("uncertainty", {
          node_id: nodeId,
          agent_id: agentId,
          kind: "dynamic_agent_tools"
        }),
        kind: "dynamic_agent_tools",
        description: `Agent ${agentId} can choose among its declared local and MCP runtime tools dynamically.`,
        may_include_unlisted_write: agentMayIncludeUnlistedWrite(agent),
        node_id: nodeId
      });
    }
  }
  return { effects, uncertainties };
}

export async function resolveNativeStudioRunEffects(options: {
  readonly workflow: WorkflowDefinition;
  readonly agentsRoot: string;
  readonly capabilityRegistry: CapabilityRegistry;
}): Promise<NativeStudioRunEffects> {
  const agents = await agentEffects(
    options.workflow,
    options.agentsRoot,
    options.capabilityRegistry
  );
  const potentialEffects = [
    ...declaredEffects(options.workflow, options.capabilityRegistry),
    ...agents.effects
  ].sort((left, right) => left.effect_id.localeCompare(right.effect_id));
  const resolvedEffects: StudioRunResolvedEffect[] = potentialEffects.map(
    (effect) => ({
      ...effect,
      effect_id: effectId("resolved", effect.effect_id),
      potential_effect_id: effect.effect_id,
      resolution_source: "preflight"
    })
  );
  const warnings: StudioRunPlanWarning[] = [
    {
      code: "local_real_run",
      message: "This plan launches a real workflow in the local Luna runtime."
    },
    ...(options.workflow.requires.repository
      ? [{
          code: "live_repository",
          message: "Execution uses the configured live repository or a worktree derived from it."
        } satisfies StudioRunPlanWarning]
      : [])
  ];
  return {
    potential_effects: potentialEffects,
    resolved_effects: resolvedEffects,
    effect_uncertainties: [...agents.uncertainties].sort((left, right) =>
      left.uncertainty_id.localeCompare(right.uncertainty_id)
    ),
    warnings
  };
}
