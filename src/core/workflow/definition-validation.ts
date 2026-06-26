import type {
  ArtifactPublisherRegistration,
  BuiltInRegistration,
  GateRegistration,
  PolicyRegistration,
  SchemaRegistration
} from "../capabilities/manifest.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
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
  ParsedPatternNode
} from "./definition-types.js";
import { MAX_WORKFLOW_REPAIR_ATTEMPTS } from "./repair-attempts.js";

type RegistrationKind =
  | "built_ins"
  | "patterns"
  | "gates"
  | "policies"
  | "artifact_publishers"
  | "schemas";

type Registration =
  | BuiltInRegistration
  | PatternRegistration
  | GateRegistration
  | PolicyRegistration
  | ArtifactPublisherRegistration
  | SchemaRegistration;

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
  registry: CapabilityRegistry | undefined
): void {
  const seen = new Set<string>();
  nodes.forEach((node, index) => {
    if (seen.has(node.id)) {
      throw new WorkflowDefinitionError(
        "workflow_node_duplicate",
        `Duplicate workflow node id: ${node.id}`,
        { path: `$.nodes[${index}].id` }
      );
    }
    seen.add(node.id);

    walkNoStringExpressions(node, `$.nodes[${index}]`);
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
      requireDeclaredCapability("agents", declaredCapabilities, `$.nodes[${index}].type`);
    } else if (node.type === "pattern") {
      validatePatternNode(node, index, declaredCapabilities, nodeIds, registry);
    } else {
      const gate = requireRegistration(
        node.uses,
        "gates",
        declaredCapabilities,
        registry,
        `$.nodes[${index}].uses`
      ) as GateRegistration | undefined;
      if (gate && node.decision !== undefined) {
        validateJsonSchema(gate.decision_schema, node.decision, {
          path: `$.nodes[${index}].decision`,
          capability: gate.id
        });
      }
    }
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
      patternConfigFor(node),
      `$.nodes[${index}]`,
      pattern.id,
      nodeIds,
      pattern.local_context_roots
    );
    validateJsonSchema(pattern.input_schema, patternConfigFor(node), {
      path: `$.nodes[${index}]`,
      capability: pattern.id
    });
  }

  const worker = node.worker;
  if (worker) {
    requireDeclaredCapability("agents", declaredCapabilities, `$.nodes[${index}].worker`);
  }

  (node.gates ?? []).forEach((gate, gateIndex) => {
    validateGate(gate, `$.nodes[${index}].gates[${gateIndex}]`, {
      declaredCapabilities,
      nodeIds,
      registry
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
  kind: RegistrationKind,
  declaredCapabilities: readonly string[],
  registry: CapabilityRegistry | undefined,
  yamlPath: string
): Registration | undefined {
  assertNamespacedCapabilityId(id, yamlPath);
  const owner = id.split(".", 1)[0];
  requireDeclaredCapability(owner, declaredCapabilities, yamlPath);
  if (!registry) {
    return undefined;
  }
  for (const manifest of registry.orderedManifests()) {
    const registrations = manifest[kind] as Record<string, Registration> | undefined;
    if (registrations?.[id]) {
      return registrations[id];
    }
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

function assertNamespacedCapabilityId(id: string, yamlPath: string): void {
  if (!isNamespacedCapabilityId(id)) {
    throw new WorkflowDefinitionError(
      "workflow_capability_id_unqualified",
      `Capability-provided id must be namespaced: ${id}`,
      { path: yamlPath, capability: id }
    );
  }
}

function isNamespacedCapabilityId(id: string): boolean {
  return /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(id);
}

function patternConfigFor(
  node: ParsedPatternNode
): Record<string, unknown> {
  return {
    writer_agent: node.worker,
    gates: (node.gates ?? []).map((gate) => gate.type),
    ...(node.repair?.attempts !== undefined
      ? {
          max_iterations:
            typeof node.repair.attempts === "number"
              ? node.repair.attempts + 1
              : node.repair.attempts
        }
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
