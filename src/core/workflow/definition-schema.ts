import YAML from "yaml";
import { AgentRuntimeRequirementSchema } from "../agent-runtime/contracts.js";
import { assertExpressionObject } from "./expression.js";
import { WorkflowDefinitionError } from "./definition-errors.js";
import type {
  ParsedArtifactWritePlan,
  ParsedWorkflowPolicy,
  ParsedWorkflowGate,
  ParsedWorkflowGraph,
  ParsedWorkflowNode,
  WorkflowExecution
} from "./definition-types.js";

const TOP_LEVEL_FIELDS = new Set([
  "id",
  "type",
  "mode",
  "input_schema",
  "output_schema",
  "capabilities",
  "nodes",
  "execution",
  "observability",
  "subagent_policy",
  "requires"
]);

const NODE_FIELDS: Record<string, ReadonlySet<string>> = {
  built_in: new Set(["id", "type", "uses", "input", "artifacts", "after", "policies"]),
  agent: new Set(["id", "type", "agent", "output_schema", "input", "artifacts", "after", "retry", "runtime_requirements", "policies"]),
  pattern: new Set(["id", "type", "uses", "worker", "input", "gates", "repair", "artifacts", "after", "capabilities", "policies"]),
  human_gate: new Set(["id", "type", "uses", "decision", "after", "input", "artifacts"])
};

const GATE_FIELDS = new Set([
  "id",
  "type",
  "input",
  "decision",
  "block_when",
  "feedback"
]);

const ARTIFACT_FIELDS = new Set([
  "path",
  "source",
  "format",
  "required",
  "publisher",
  "config"
]);

const POLICY_FIELDS = new Set(["uses", "config"]);

export function parseWorkflowYaml(content: string, yamlPath = "$"): unknown {
  try {
    return YAML.parse(content);
  } catch {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      `Workflow YAML is invalid at ${yamlPath}.`,
      { path: yamlPath }
    );
  }
}

export function assertWorkflowDocument(value: unknown): Record<string, unknown> {
  const raw = assertObject(value, "$");
  assertKnownFields(raw, TOP_LEVEL_FIELDS, "$");
  return raw;
}

export function readCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow capabilities must be an array.",
      { path: "$.capabilities" }
    );
  }
  return value.map((capability, index) => {
    const id = requireString(capability, `$.capabilities[${index}]`);
    if (id.includes(".")) {
      throw new WorkflowDefinitionError(
        "workflow_capability_id_unqualified",
        `Workflow capability ${id} must be an unqualified capability id.`,
        { path: `$.capabilities[${index}]`, capability: id }
      );
    }
    return id;
  });
}

export function readGraph(raw: Record<string, unknown>): ParsedWorkflowGraph {
  return {
    nodes: readNodes(raw.nodes)
  };
}

export function normalizeExecution(value: unknown): WorkflowExecution {
  if (value === undefined) {
    return { max_concurrency: 1 };
  }
  const record = assertObject(value, "$.execution");
  assertKnownFields(record, new Set(["max_concurrency", "lock_timeout_ms"]), "$.execution");
  if (record.max_concurrency !== undefined && !isPositiveInteger(record.max_concurrency)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow execution.max_concurrency must be a positive integer.",
      { path: "$.execution.max_concurrency" }
    );
  }
  if (record.lock_timeout_ms !== undefined && !isPositiveInteger(record.lock_timeout_ms)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow execution.lock_timeout_ms must be a positive integer.",
      { path: "$.execution.lock_timeout_ms" }
    );
  }
  return {
    max_concurrency:
      typeof record.max_concurrency === "number" ? record.max_concurrency : 1,
    ...(typeof record.lock_timeout_ms === "number"
      ? { lock_timeout_ms: record.lock_timeout_ms }
      : {})
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function assertObject(
  value: unknown,
  yamlPath: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      `Expected object at ${yamlPath}.`,
      { path: yamlPath }
    );
  }
  return value as Record<string, unknown>;
}

export function assertKnownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  yamlPath: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new WorkflowDefinitionError(
        "workflow_unknown_field",
        `Unknown workflow field ${key} at ${yamlPath}.`,
        { path: `${yamlPath}.${key}` }
      );
    }
  }
}

export function requireString(value: unknown, yamlPath: string): string {
  if (typeof value !== "string" || value === "") {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      `Expected non-empty string at ${yamlPath}.`,
      { path: yamlPath }
    );
  }
  return value;
}

function readNodes(value: unknown): ParsedWorkflowNode[] {
  if (!Array.isArray(value)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow nodes must be an array.",
      { path: "$.nodes" }
    );
  }
  return value.map((node, index) => readNode(node, `$.nodes[${index}]`));
}

function readNode(
  value: unknown,
  yamlPath: string
): ParsedWorkflowNode {
  const raw = assertObject(value, yamlPath);
  const type = requireString(raw.type, `${yamlPath}.type`);
  const allowed = NODE_FIELDS[type];
  if (!allowed) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      `Unsupported workflow node type: ${type}`,
      { path: `${yamlPath}.type` }
    );
  }
  assertKnownFields(raw, allowed, yamlPath);
  const base = {
    id: requireString(raw.id, `${yamlPath}.id`),
    ...(raw.after === undefined
      ? {}
      : { after: readStringArray(raw.after, `${yamlPath}.after`) }),
    ...(raw.input === undefined
      ? {}
      : { input: assertObject(raw.input, `${yamlPath}.input`) }),
    ...(raw.artifacts === undefined
      ? {}
      : { artifacts: readArtifacts(raw.artifacts, `${yamlPath}.artifacts`) }),
    ...(raw.policies === undefined
      ? {}
      : { policies: readPolicies(raw.policies, `${yamlPath}.policies`) })
  };

  if (type === "built_in") {
    return {
      ...base,
      type: "built_in",
      uses: requireString(raw.uses, `${yamlPath}.uses`)
    };
  }
  if (type === "agent") {
    const outputSchema = raw.output_schema;
    if (typeof outputSchema !== "string" || outputSchema === "") {
      throw new WorkflowDefinitionError(
        "workflow_agent_output_schema_missing",
        "Agent nodes must declare output_schema.",
        { path: `${yamlPath}.output_schema` }
      );
    }
    return {
      ...base,
      type: "agent",
      agent: requireString(raw.agent, `${yamlPath}.agent`),
      output_schema: outputSchema,
      ...(raw.retry === undefined
        ? {}
        : { retry: assertObject(raw.retry, `${yamlPath}.retry`) }),
      ...(raw.runtime_requirements === undefined
        ? {}
        : {
            runtime_requirements: readRuntimeRequirements(
              raw.runtime_requirements,
              `${yamlPath}.runtime_requirements`
            )
          })
    };
  }
  if (type === "human_gate") {
    return {
      ...base,
      type: "human_gate",
      uses: requireString(raw.uses, `${yamlPath}.uses`),
      ...(raw.decision === undefined ? {} : { decision: raw.decision })
    };
  }

  return {
    ...base,
    type: "pattern",
    uses: requireString(raw.uses, `${yamlPath}.uses`),
    ...(raw.worker === undefined
      ? {}
      : { worker: requireString(raw.worker, `${yamlPath}.worker`) }),
    ...(raw.gates === undefined
      ? {}
      : { gates: readGates(raw.gates, `${yamlPath}.gates`) }),
    ...(raw.repair === undefined
      ? {}
      : { repair: assertObject(raw.repair, `${yamlPath}.repair`) })
  };
}

function readRuntimeRequirements(value: unknown, yamlPath: string): string[] {
  return readStringArray(value, yamlPath).map((requirement, index) => {
    const result = AgentRuntimeRequirementSchema.safeParse(requirement);
    if (!result.success) {
      throw new WorkflowDefinitionError(
        "workflow_schema_invalid",
        `Unsupported runtime requirement: ${requirement}`,
        { path: `${yamlPath}[${index}]` }
      );
    }

    return result.data;
  });
}

function readGates(value: unknown, yamlPath: string): ParsedWorkflowGate[] {
  if (!Array.isArray(value)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Workflow gates must be an array.",
      { path: yamlPath }
    );
  }
  return value.map((gate, index) => {
    const pathForGate = `${yamlPath}[${index}]`;
    const raw = assertObject(gate, pathForGate);
    assertKnownFields(raw, GATE_FIELDS, pathForGate);
    return {
      id: requireString(raw.id, `${pathForGate}.id`),
      type: requireString(raw.type, `${pathForGate}.type`),
      ...(raw.input === undefined
        ? {}
        : { input: assertObject(raw.input, `${pathForGate}.input`) }),
      ...(raw.decision === undefined ? {} : { decision: raw.decision }),
      ...(raw.block_when === undefined
        ? {}
        : {
            block_when: assertExpressionObject(
              raw.block_when,
              `${pathForGate}.block_when`
            )
          }),
      ...(raw.feedback === undefined
        ? {}
        : {
            feedback: assertExpressionObject(
              raw.feedback,
              `${pathForGate}.feedback`
            )
          }),
    } as ParsedWorkflowGate;
  });
}

function readArtifacts(
  value: unknown,
  yamlPath: string
): ParsedArtifactWritePlan[] {
  if (!Array.isArray(value)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Artifacts must be an array.",
      { path: yamlPath }
    );
  }

  return value.map((artifact, index) => {
    const artifactPath = `${yamlPath}[${index}]`;
    const raw = assertObject(artifact, artifactPath);
    assertKnownFields(raw, ARTIFACT_FIELDS, artifactPath);
    const publisher = requireString(raw.publisher, `${artifactPath}.publisher`);
    const format =
      raw.format === undefined
        ? "json"
        : raw.format === "json" || raw.format === "markdown"
          ? raw.format
          : undefined;
    if (format === undefined) {
      throw new WorkflowDefinitionError(
        "workflow_schema_invalid",
        "Artifact format must be json or markdown.",
        { path: `${artifactPath}.format` }
      );
    }
    if (raw.required !== undefined && typeof raw.required !== "boolean") {
      throw new WorkflowDefinitionError(
        "workflow_schema_invalid",
        "Artifact required must be a boolean.",
        { path: `${artifactPath}.required` }
      );
    }
    return {
      path: requireString(raw.path, `${artifactPath}.path`),
      source: assertExpressionObject(raw.source, `${artifactPath}.source`, publisher),
      format,
      required: raw.required !== false,
      publisher,
      ...(raw.config === undefined
        ? {}
        : { config: assertObject(raw.config, `${artifactPath}.config`) })
    };
  });
}

function readPolicies(value: unknown, yamlPath: string): ParsedWorkflowPolicy[] {
  if (!Array.isArray(value)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      "Policies must be an array.",
      { path: yamlPath }
    );
  }

  return value.map((policy, index) => {
    const policyPath = `${yamlPath}[${index}]`;
    const raw = assertObject(policy, policyPath);
    assertKnownFields(raw, POLICY_FIELDS, policyPath);
    return {
      uses: requireString(raw.uses, `${policyPath}.uses`),
      ...(raw.config === undefined
        ? {}
        : { config: assertObject(raw.config, `${policyPath}.config`) })
    };
  });
}

function readStringArray(value: unknown, yamlPath: string): string[] {
  if (!Array.isArray(value)) {
    throw new WorkflowDefinitionError(
      "workflow_schema_invalid",
      `Expected string array at ${yamlPath}.`,
      { path: yamlPath }
    );
  }
  return value.map((item, index) => requireString(item, `${yamlPath}[${index}]`));
}
