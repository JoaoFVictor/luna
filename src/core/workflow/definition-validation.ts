import type {
  ArtifactPublisherRegistration,
  BuiltInRegistration,
  GateRegistration,
  PolicyRegistration,
  SchemaRegistration
} from "../capabilities/manifest.js";
import {
  registrationMapForKind,
  type CapabilityRegistration,
  type CapabilityRegistrationKind
} from "../capabilities/registration-index.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { isNamespacedCapabilityId } from "../capabilities/ids.js";
import { matchesJsonSchema } from "../capabilities/json-schema.js";
import {
  createSideEffectPolicy,
  type SideEffectPolicy
} from "../runtime/side-effects.js";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { isInsideRoot } from "../security/path.js";
import type {
  JsonSchemaLike,
  PatternRegistration
} from "../capabilities/pattern-registration.js";
import {
  assertLocalExpressionRoots,
  detectStringExpression,
  isExpressionObject,
  validateWorkflowExpression
} from "./expression.js";
import { WorkflowDefinitionError } from "./definition-errors.js";
import type {
  ParsedWorkflowGate,
  ParsedWorkflowNode,
  ParsedAgentNode,
  ParsedPatternEvidence,
  ParsedPatternNode,
  WorkflowDefinition
} from "./definition-types.js";
import { validateLoopStructure } from "./loop-definition-validation.js";
import { MAX_WORKFLOW_REPAIR_ATTEMPTS } from "./repair-attempts.js";
import { isReservedWorkflowNodeId } from "./node-id.js";

export function validateDeclaredCapabilities(
  capabilities: readonly string[],
  registry: CapabilityRegistry | undefined
): void {
  if (!registry) {
    return;
  }
  for (const capability of capabilities) {
    if (!registry.has(capability)) {
      throw new WorkflowDefinitionError(
        "workflow_capability_unknown",
        `Workflow declares unknown capability ${capability}.`,
        { capability }
      );
    }
  }
}

export function validateNodesAgainstCapabilities(
  nodes: readonly ParsedWorkflowNode[],
  declaredCapabilities: readonly string[],
  nodeIds: ReadonlySet<string>,
  registry: CapabilityRegistry | undefined,
  allowLoopWhen = false
): void {
  const seen = new Set<string>();
  nodes.forEach((node, index) => {
    if (isReservedWorkflowNodeId(node.id)) {
      throw new WorkflowDefinitionError(
        "workflow_node_id_reserved",
        `Workflow node id ${node.id} uses Luna's reserved internal namespace.`,
        { path: `$.nodes[${index}].id` }
      );
    }
    if (seen.has(node.id)) {
      throw new WorkflowDefinitionError(
        "workflow_node_duplicate",
        `Duplicate workflow node id: ${node.id}`,
        { path: `$.nodes[${index}].id` }
      );
    }
    seen.add(node.id);

    walkNoStringExpressions(node, `$.nodes[${index}]`);
    if (
      node.type !== "human_gate" &&
      "when" in node &&
      node.when !== undefined
    ) {
      if (!allowLoopWhen) {
        throw new WorkflowDefinitionError(
          "workflow_schema_invalid",
          "Node when is only supported inside a workflow loop body.",
          { path: `$.nodes[${index}].when` }
        );
      }
      validateExpressionBearingValue(
        node.when,
        `$.nodes[${index}].when`,
        "workflow.loop",
        nodeIds
      );
    }
    validatePolicies(node, index, declaredCapabilities, nodeIds, registry);
    validateArtifacts(node, index, declaredCapabilities, nodeIds, registry);

    if (node.type === "built_in") {
      const registration = requireRegistration(
        node.uses,
        "built_ins",
        declaredCapabilities,
        registry,
        `$.nodes[${index}].uses`
      ) as BuiltInRegistration | undefined;
      if (registration) {
        validateExpressionBearingValue(
          node.input ?? {},
          `$.nodes[${index}].input`,
          registration.id,
          nodeIds
        );
        validateJsonSchema(registration.input_schema, node.input ?? {}, {
          path: `$.nodes[${index}].input`,
          capability: registration.id
        });
        validateBuiltInSideEffectPolicy(
          node,
          index,
          registration,
          declaredCapabilities,
          registry
        );
      }
    } else if (node.type === "agent") {
      requireWorkflowNodeCapability(
        "agent",
        declaredCapabilities,
        `$.nodes[${index}].type`,
        registry
      );
    } else if (node.type === "pattern") {
      validatePatternNode(node, index, declaredCapabilities, nodeIds, registry);
    } else if (node.type === "human_gate") {
      const gate = requireRegistration(
        node.uses,
        "gates",
        declaredCapabilities,
        registry,
        `$.nodes[${index}].uses`
      ) as GateRegistration | undefined;
      validateExpressionBearingValue(
        node.input ?? {},
        `$.nodes[${index}].input`,
        gate?.id ?? node.uses,
        nodeIds
      );
    } else if (node.type === "workflow") {
      validateExpressionBearingValue(
        node.input ?? {},
        `$.nodes[${index}].input`,
        `workflow:${node.workflow}`,
        nodeIds
      );
    } else {
      validateLoopNode(
        node,
        index,
        declaredCapabilities,
        registry
      );
    }
  });
}

function validateLoopNode(
  node: Extract<ParsedWorkflowNode, { readonly type: "loop" }>,
  index: number,
  declaredCapabilities: readonly string[],
  registry: CapabilityRegistry | undefined
): void {
  const path = `$.nodes[${index}]`;
  const body = node.body.nodes;
  validateLoopStructure(node, path);
  const bodyIds = new Set(body.map((candidate) => candidate.id));
  validateNodesAgainstCapabilities(body, declaredCapabilities, bodyIds, registry, true);
  validateExpressionBearingValue(
    node.repeat_when,
    `${path}.repeat_when`,
    "workflow.loop",
    bodyIds
  );
  validateExpressionBearingValue(
    node.result,
    `${path}.result`,
    "workflow.loop",
    bodyIds
  );
  if (node.halt_when !== undefined) {
    validateExpressionBearingValue(
      node.halt_when,
      `${path}.halt_when`,
      "workflow.loop",
      new Set(),
      ["result"]
    );
  }
}

export function validateWorkflowCallInputs(
  nodes: readonly ParsedWorkflowNode[],
  compositions: Readonly<Record<string, WorkflowDefinition>>,
  nodesPath = "$.nodes"
): void {
  nodes.forEach((node, index) => {
    const nodePath = `${nodesPath}[${index}]`;
    if (node.type === "loop") {
      validateWorkflowCallInputs(
        node.body.nodes,
        compositions,
        `${nodePath}.body.nodes`
      );
      return;
    }
    if (node.type !== "workflow") return;
    const child = compositions[node.workflow];
    if (child === undefined) {
      throw new WorkflowDefinitionError(
        "workflow_external_definition_missing",
        `Composed workflow ${node.workflow} was not resolved.`,
        { path: `${nodePath}.workflow`, nodeId: node.id }
      );
    }
    validateJsonSchema(
      child.input_schema_content as JsonSchemaLike,
      node.input ?? {},
      {
        path: `${nodePath}.input`,
        capability: `workflow:${child.id}`
      }
    );
  });
}

function validateBuiltInSideEffectPolicy(
  node: Extract<ParsedWorkflowNode, { type: "built_in" }>,
  nodeIndex: number,
  registration: BuiltInRegistration,
  declaredCapabilities: readonly string[],
  registry: CapabilityRegistry | undefined
): SideEffectPolicy | undefined {
  if (!registration.side_effect_policy) {
    return undefined;
  }

  const policyPath = `$.nodes[${nodeIndex}].policies`;
  const nodePolicy = (node.policies ?? []).find(
    (policy) => policy.uses === registration.side_effect_policy
  );
  if (!nodePolicy) {
    throw new WorkflowDefinitionError(
      "workflow_side_effect_policy_missing",
      `Side-effecting built-in ${registration.id} must declare policy ${registration.side_effect_policy}.`,
      { path: policyPath, capability: registration.id }
    );
  }

  const policyRegistration = requireRegistration(
    registration.side_effect_policy,
    "policies",
    declaredCapabilities,
    registry,
    `${policyPath}.uses`
  ) as PolicyRegistration | undefined;
  if (!policyRegistration) {
    return undefined;
  }

  const operationId = nodePolicy.config?.operation_id;
  if (typeof operationId !== "string" || operationId === "") {
    throw new WorkflowDefinitionError(
      "workflow_side_effect_policy_invalid",
      `Side-effect policy ${policyRegistration.id} must configure operation_id.`,
      { path: `${policyPath}.config.operation_id`, capability: policyRegistration.id }
    );
  }
  if (!policyRegistration.retry_semantics) {
    throw new WorkflowDefinitionError(
      "workflow_side_effect_policy_invalid",
      `Side-effect policy ${policyRegistration.id} must declare retry_semantics.`,
      { path: `${policyPath}.uses`, capability: policyRegistration.id }
    );
  }
  if (
    !(policyRegistration.side_effect_operation_ids ?? []).includes(operationId)
  ) {
    throw new WorkflowDefinitionError(
      "workflow_side_effect_policy_invalid",
      `Side-effect policy ${policyRegistration.id} does not register operation_id ${operationId}.`,
      { path: `${policyPath}.config.operation_id`, capability: policyRegistration.id }
    );
  }

  try {
    return createSideEffectPolicy({
      capability_id: policyRegistration.id.split(".", 1)[0] ?? "",
      operation_id: operationId,
      idempotency_scope: policyRegistration.idempotency_scope ?? "attempt",
      retry_semantics: policyRegistration.retry_semantics,
      adoption_required:
        policyRegistration.retry_semantics === "retry_requires_adoption"
    });
  } catch (cause) {
    throw new WorkflowDefinitionError(
      "workflow_side_effect_policy_invalid",
      cause instanceof Error ? cause.message : "Invalid side-effect policy.",
      { path: `${policyPath}.config.operation_id`, capability: policyRegistration.id }
    );
  }
}

function validatePolicies(
  node: ParsedWorkflowNode,
  nodeIndex: number,
  declaredCapabilities: readonly string[],
  nodeIds: ReadonlySet<string>,
  registry: CapabilityRegistry | undefined
): void {
  if (!("policies" in node)) {
    return;
  }
  (node.policies ?? []).forEach((policy, policyIndex) => {
    const policyPath = `$.nodes[${nodeIndex}].policies[${policyIndex}]`;
    const registration = requireRegistration(
      policy.uses,
      "policies",
      declaredCapabilities,
      registry,
      `${policyPath}.uses`
    ) as PolicyRegistration | undefined;
    if (!registration) {
      return;
    }
    assertLocalExpressionRoots(registration.local_context_roots, registration.id);
    validateExpressionBearingValue(
      policy.config ?? {},
      `${policyPath}.config`,
      registration.id,
      nodeIds,
      registration.local_context_roots
    );
    validateJsonSchema(registration.config_schema, policy.config ?? {}, {
      path: `${policyPath}.config`,
      capability: registration.id
    });
  });
}

export function validateJsonSchema(
  schema: JsonSchemaLike,
  value: unknown,
  context: { path: string; capability: string }
): void {
  if (!matchesJsonSchema(schema, value, { isExpressionObject })) {
    throw new WorkflowDefinitionError(
      "workflow_capability_config_invalid",
      `Config at ${context.path} does not match schema for ${context.capability}.`,
      { path: context.path, capability: context.capability }
    );
  }
}

function validatePatternNode(
  node: ParsedPatternNode,
  index: number,
  declaredCapabilities: readonly string[],
  nodeIds: ReadonlySet<string>,
  registry: CapabilityRegistry | undefined
): void {
  const pattern = requireRegistration(
    node.uses,
    "patterns",
    declaredCapabilities,
    registry,
    `$.nodes[${index}].uses`
  ) as PatternRegistration | undefined;
  if (pattern) {
    assertLocalExpressionRoots(pattern.local_context_roots, pattern.id);
    validatePatternRepair(node, index, pattern.id, nodeIds, pattern.local_context_roots);
    validateExpressionBearingValue(
      patternAuthoringConfigFor(node),
      `$.nodes[${index}]`,
      pattern.id,
      nodeIds,
      pattern.local_context_roots
    );
    validateJsonSchema(pattern.input_schema, patternAuthoringConfigFor(node), {
      path: `$.nodes[${index}]`,
      capability: pattern.id
    });
  }

  const worker = node.worker;
  if (worker) {
    requireWorkflowNodeCapability(
      "agent",
      declaredCapabilities,
      `$.nodes[${index}].worker`,
      registry
    );
  }

  (node.gates ?? []).forEach((gate, gateIndex) => {
    validateGate(gate, `$.nodes[${index}].gates[${gateIndex}]`, {
      declaredCapabilities,
      nodeIds,
      registry
    });
  });

  validatePatternEvidence(
    node.evidence ?? [],
    index,
    declaredCapabilities,
    nodeIds,
    registry,
    pattern?.local_context_roots
  );
}

function validatePatternEvidence(
  evidenceEntries: readonly ParsedPatternEvidence[],
  nodeIndex: number,
  declaredCapabilities: readonly string[],
  nodeIds: ReadonlySet<string>,
  registry: CapabilityRegistry | undefined,
  localRoots?: readonly string[]
): void {
  const seenIds = new Set<string>();
  evidenceEntries.forEach((evidence, evidenceIndex) => {
    const evidencePath = `$.nodes[${nodeIndex}].evidence[${evidenceIndex}]`;
    if (!/^[A-Za-z0-9_-]+$/.test(evidence.id)) {
      throw new WorkflowDefinitionError(
        "workflow_schema_invalid",
        `Invalid pattern evidence id: ${evidence.id}`,
        { path: `${evidencePath}.id` }
      );
    }
    if (seenIds.has(evidence.id)) {
      throw new WorkflowDefinitionError(
        "workflow_schema_invalid",
        `Duplicate pattern evidence id: ${evidence.id}`,
        { path: `${evidencePath}.id` }
      );
    }
    seenIds.add(evidence.id);

    const registration = requireRegistration(
      evidence.uses,
      "built_ins",
      declaredCapabilities,
      registry,
      `${evidencePath}.uses`
    ) as BuiltInRegistration | undefined;
    if (registration === undefined) {
      return;
    }
    if (registration.side_effect_policy !== undefined) {
      throw new WorkflowDefinitionError(
        "workflow_side_effect_policy_invalid",
        `Pattern evidence built-in ${registration.id} must be read-only and replay-safe.`,
        { path: `${evidencePath}.uses`, capability: registration.id }
      );
    }
    validateExpressionBearingValue(
      evidence.input ?? {},
      `${evidencePath}.input`,
      registration.id,
      nodeIds,
      localRoots
    );
    validateJsonSchema(registration.input_schema, evidence.input ?? {}, {
      path: `${evidencePath}.input`,
      capability: registration.id
    });
  });
}

function validatePatternRepair(
  node: ParsedPatternNode,
  index: number,
  capability: string,
  nodeIds: ReadonlySet<string>,
  localRoots?: readonly string[]
): void {
  if (node.repair?.attempts === undefined) {
    return;
  }
  const attempts = node.repair.attempts;
  if (typeof attempts === "number") {
    if (
      !Number.isSafeInteger(attempts) ||
      attempts < 0 ||
      attempts > MAX_WORKFLOW_REPAIR_ATTEMPTS
    ) {
      throw new WorkflowDefinitionError(
        "workflow_schema_invalid",
        `Pattern repair.attempts must be an integer between 0 and 9 for node ${node.id}.`,
        { path: `$.nodes[${index}].repair.attempts`, capability }
      );
    }
    return;
  }
  if (!isExpressionObject(attempts)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      `Pattern repair.attempts must be an integer between 0 and 9 or expression for node ${node.id}.`,
      { path: `$.nodes[${index}].repair.attempts`, capability }
    );
  }
  validateWorkflowExpression(attempts, {
    path: `$.nodes[${index}].repair.attempts.expression`,
    capability,
    nodeIds,
    localRoots
  });
}

function validateGate(
  gate: ParsedWorkflowGate,
  gatePath: string,
  context: {
    declaredCapabilities: readonly string[];
    nodeIds: ReadonlySet<string>;
    registry: CapabilityRegistry | undefined;
  }
): void {
  const registration = requireRegistration(
    gate.type,
    "gates",
    context.declaredCapabilities,
    context.registry,
    `${gatePath}.type`
  ) as GateRegistration | undefined;

  if (!registration) {
    return;
  }

  const reviewAgent = gate.input?.review_agent;
  if (
    reviewAgent !== undefined &&
    (typeof reviewAgent !== "string" || reviewAgent === "")
  ) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      `Gate review_agent must be a static non-empty agent id for ${registration.id}.`,
      { path: `${gatePath}.input.review_agent`, capability: registration.id }
    );
  }

  assertLocalExpressionRoots(registration.local_context_roots, registration.id);
  validateExpressionBearingValue(
    gate.input ?? {},
    `${gatePath}.input`,
    registration.id,
    context.nodeIds,
    registration.local_context_roots
  );
  validateJsonSchema(registration.input_schema, gate.input ?? {}, {
    path: `${gatePath}.input`,
    capability: registration.id
  });
  if ("decision" in gate && gate.decision !== undefined) {
    validateJsonSchema(registration.decision_schema, gate.decision, {
      path: `${gatePath}.decision`,
      capability: registration.id
    });
  }
  if (gate.block_when) {
    validateWorkflowExpression(gate.block_when, {
      path: `${gatePath}.block_when.expression`,
      capability: registration.id,
      nodeIds: context.nodeIds,
      localRoots: registration.local_context_roots
    });
  }
  if (gate.feedback) {
    validateWorkflowExpression(gate.feedback, {
      path: `${gatePath}.feedback.expression`,
      capability: registration.id,
      nodeIds: context.nodeIds,
      localRoots: registration.local_context_roots
    });
  }
}

function validateArtifacts(
  node: ParsedWorkflowNode,
  nodeIndex: number,
  declaredCapabilities: readonly string[],
  nodeIds: ReadonlySet<string>,
  registry: CapabilityRegistry | undefined
): void {
  if (!("artifacts" in node)) {
    return;
  }
  (node.artifacts ?? []).forEach((artifact, artifactIndex) => {
    const artifactPath = `$.nodes[${nodeIndex}].artifacts[${artifactIndex}]`;
    const publisher = artifact.publisher;
    if (!publisher) {
      return;
    }
    const registration = requireRegistration(
      publisher,
      "artifact_publishers",
      declaredCapabilities,
      registry,
      `${artifactPath}.publisher`
    ) as ArtifactPublisherRegistration | undefined;
    if (registration) {
      validateExpressionBearingValue(
        artifact.config ?? {},
        `${artifactPath}.config`,
        registration.id,
        nodeIds
      );
      validateJsonSchema(
        registration.config_schema ?? {
          type: "object",
          additionalProperties: false
        },
        artifact.config ?? {},
        {
          path: `${artifactPath}.config`,
          capability: registration.id
        }
      );
      validateWorkflowExpression(artifact.source, {
        path: `${artifactPath}.source.expression`,
        capability: registration.id,
        nodeIds
      });
      validateArtifactSourceOwnership(
        node.id,
        artifact.source.expression,
        registration,
        `${artifactPath}.source.expression`
      );
    }
  });
}

export async function validateAgentOutputSchemas(
  nodes: readonly ParsedWorkflowNode[],
  agentsRoot: string,
  declaredCapabilities: readonly string[],
  registry: CapabilityRegistry | undefined
): Promise<void> {
  for (const [index, node] of nodes.entries()) {
    if (node.type !== "agent") {
      continue;
    }
    const schemaRef = node.output_schema;
    const schemaPath = `$.nodes[${index}].output_schema`;
    if (!schemaRef.endsWith(".json") && isNamespacedCapabilityId(schemaRef)) {
      requireRegistration(schemaRef, "schemas", declaredCapabilities, registry, schemaPath);
      continue;
    }
    await assertAgentSchemaFileExists({
      agentsRoot,
      agentId: node.agent,
      relativePath: schemaRef,
      yamlPath: schemaPath
    });
  }
}

async function assertAgentSchemaFileExists({
  agentsRoot,
  agentId,
  relativePath,
  yamlPath
}: {
  agentsRoot: string;
  agentId: string;
  relativePath: string;
  yamlPath: string;
}): Promise<void> {
  const resolved = safeAgentSchemaFilePath({
    agentsRoot,
    agentId,
    relativePath,
    yamlPath
  });
  try {
    await access(resolved);
  } catch (error) {
    void error;
    throw new WorkflowDefinitionError(
      "workflow_schema_missing",
      `Workflow referenced file does not exist: ${relativePath}`,
      { path: yamlPath }
    );
  }
}

export function validateWorkflowNodeOutput({
  node,
  output,
  declaredCapabilities,
  capabilityRegistry,
  path: outputPath
}: {
  node: ParsedWorkflowNode;
  output: unknown;
  declaredCapabilities: readonly string[];
  capabilityRegistry?: CapabilityRegistry;
  path: string;
}): void {
  if (node.type !== "built_in" && node.type !== "pattern") {
    return;
  }
  const registration = requireRegistration(
    node.uses,
    node.type === "built_in" ? "built_ins" : "patterns",
    declaredCapabilities,
    capabilityRegistry,
    `${outputPath}.capability`
  ) as BuiltInRegistration | PatternRegistration | undefined;
  if (!registration) {
    return;
  }
  validateJsonSchema(registration.output_schema, output, {
    path: outputPath,
    capability: registration.id
  });
}

export async function validateWorkflowAgentNodeOutput({
  node,
  output,
  agentsRoot,
  declaredCapabilities,
  capabilityRegistry,
  path: outputPath
}: {
  node: ParsedAgentNode;
  output: unknown;
  agentsRoot: string;
  declaredCapabilities: readonly string[];
  capabilityRegistry?: CapabilityRegistry;
  path: string;
}): Promise<void> {
  const schema = await resolveWorkflowAgentOutputSchema({
    agentId: node.agent,
    schemaRef: node.output_schema,
    agentsRoot,
    declaredCapabilities,
    capabilityRegistry,
    path: `${outputPath}.output_schema`
  });
  validateJsonSchema(schema, output, {
    path: outputPath,
    capability: node.output_schema
  });
}

export async function resolveWorkflowAgentOutputSchema({
  agentId,
  schemaRef,
  agentsRoot,
  declaredCapabilities,
  capabilityRegistry,
  path: schemaPath
}: {
  agentId: string;
  schemaRef: string;
  agentsRoot: string;
  declaredCapabilities: readonly string[];
  capabilityRegistry?: CapabilityRegistry;
  path: string;
}): Promise<JsonSchemaLike> {
  if (!schemaRef.endsWith(".json") && isNamespacedCapabilityId(schemaRef)) {
    const registration = requireRegistration(
      schemaRef,
      "schemas",
      declaredCapabilities,
      capabilityRegistry,
      schemaPath
    ) as SchemaRegistration | undefined;
    return registration?.schema ?? {};
  }

  const resolved = safeAgentSchemaFilePath({
    agentsRoot,
    agentId,
    relativePath: schemaRef,
    yamlPath: schemaPath
  });
  try {
    return JSON.parse(await readFile(resolved, "utf8")) as JsonSchemaLike;
  } catch (error) {
    void error;
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      `Workflow agent output schema is invalid JSON: ${schemaRef}`,
      { path: schemaPath }
    );
  }
}

function safeAgentSchemaFilePath({
  agentsRoot,
  agentId,
  relativePath,
  yamlPath
}: {
  agentsRoot: string;
  agentId: string;
  relativePath: string;
  yamlPath: string;
}): string {
  const root = path.resolve(agentsRoot, agentId);
  const resolved = path.resolve(root, relativePath);
  if (!isInsideRoot(root, resolved)) {
    throw new WorkflowDefinitionError(
      "workflow_path_escape",
      `Agent output schema path escapes agent directory: ${relativePath}`,
      { path: yamlPath }
    );
  }
  return resolved;
}

function validateExpressionBearingValue(
  value: unknown,
  yamlPath: string,
  capability: string,
  nodeIds: ReadonlySet<string>,
  localRoots?: readonly string[]
): void {
  if (isExpressionObject(value)) {
    validateWorkflowExpression(value, {
      path: `${yamlPath}.expression`,
      capability,
      nodeIds,
      localRoots
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateExpressionBearingValue(item, `${yamlPath}[${index}]`, capability, nodeIds, localRoots)
    );
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.entries(value as Record<string, unknown>).forEach(([key, nested]) =>
      validateExpressionBearingValue(nested, `${yamlPath}.${key}`, capability, nodeIds, localRoots)
    );
  }
}

export function requireRegistration(
  id: string,
  kind: CapabilityRegistrationKind,
  declaredCapabilities: readonly string[],
  registry: CapabilityRegistry | undefined,
  yamlPath: string
): CapabilityRegistration | undefined {
  assertNamespacedCapabilityId(id, yamlPath);
  const owner = id.split(".", 1)[0];
  requireDeclaredCapability(owner, declaredCapabilities, yamlPath);
  if (!registry) {
    return undefined;
  }
  const registration = registrationMapForKind(registry.registrations(), kind).get(id);
  if (registration !== undefined) {
    return registration;
  }
  throw new WorkflowDefinitionError(
    "workflow_capability_unknown",
    `Unknown ${kind} registration ${id}.`,
    { path: yamlPath, capability: id }
  );
}

function requireDeclaredCapability(
  capability: string,
  declaredCapabilities: readonly string[],
  yamlPath: string
): void {
  if (!declaredCapabilities.includes(capability)) {
    throw new WorkflowDefinitionError(
      "workflow_capability_missing",
      `Workflow must declare capability ${capability}.`,
      { path: yamlPath, capability }
    );
  }
}

function requireWorkflowNodeCapability(
  nodeType: "agent",
  declaredCapabilities: readonly string[],
  yamlPath: string,
  registry: CapabilityRegistry | undefined
): void {
  if (registry === undefined) {
    return;
  }
  const capability = registry.workflowNodeCapability(nodeType);
  if (capability === undefined) {
    throw new WorkflowDefinitionError(
      "workflow_capability_unknown",
      `No capability supplies workflow node type ${nodeType}.`,
      { path: yamlPath, capability: nodeType }
    );
  }
  requireDeclaredCapability(capability.id, declaredCapabilities, yamlPath);
}

function assertNamespacedCapabilityId(id: string, yamlPath: string): void {
  if (!isNamespacedCapabilityId(id)) {
    throw new WorkflowDefinitionError(
      "workflow_capability_id_unqualified",
      `Capability-provided id must be namespaced: ${id}`,
      { path: yamlPath, capability: id }
    );
  }
}

function patternAuthoringConfigFor(
  node: ParsedPatternNode
): Record<string, unknown> {
  return {
    worker: node.worker,
    ...(node.evidence === undefined
      ? {}
      : {
          evidence: node.evidence.map((evidence) => ({
            id: evidence.id,
            uses: evidence.uses
          }))
        }),
    gates: (node.gates ?? []).map((gate) => ({
      id: gate.id,
      type: gate.type
    })),
    ...(node.repair?.attempts !== undefined
      ? { repair: { attempts: node.repair.attempts } }
      : {})
  };
}

function walkNoStringExpressions(value: unknown, yamlPath: string): void {
  if (isExpressionObject(value)) {
    return;
  }
  if (detectStringExpression(value)) {
    throw new WorkflowDefinitionError(
      "workflow_string_expression",
      `Strings are literals; dynamic values at ${yamlPath} must use { expression }.`,
      { path: yamlPath }
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkNoStringExpressions(item, `${yamlPath}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.entries(value as Record<string, unknown>).forEach(([key, nested]) =>
      walkNoStringExpressions(nested, `${yamlPath}.${key}`)
    );
  }
}

function validateArtifactSourceOwnership(
  declaringNodeId: string,
  expression: string,
  registration: ArtifactPublisherRegistration,
  yamlPath: string
): void {
  if (registration.source_node_ownership !== "declaring_node") {
    return;
  }
  const match = /^\$\.steps\.([a-zA-Z0-9_-]+)(?:\.|$)/.exec(expression);
  if (!match || match[1] !== declaringNodeId) {
    throw new WorkflowDefinitionError(
      "workflow_reference_unknown",
      `Artifact source for ${registration.id} must read from declaring node ${declaringNodeId}.`,
      { path: yamlPath, capability: registration.id }
    );
  }
}
