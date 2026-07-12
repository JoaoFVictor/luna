import { z } from "zod";
import type { WorkflowSubagentPolicy } from "../agents/subagent-policy.js";
import type { ArtifactSemanticType } from "../artifacts/semantic-type.js";
import type { JsonSchemaLike } from "../capabilities/json-schema-types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { WorkflowExpression } from "./expression.js";
import type { DefinitionDigestResolver } from "./definition-digests.js";

export const WorkflowMetadataSchema = z.record(z.unknown());

export type WorkflowExecution = {
  max_concurrency: number;
  lock_timeout_ms?: number;
  agent_sessions?: {
    read_only: "exclusive" | "shared";
  };
};

export type WorkflowRequirements = {
  repository: boolean;
};

export type WorkflowRuntimeConfig = {
  file: string;
  schema: string;
  schema_content: JsonSchemaLike;
};

export type WorkflowObservabilityConfig = {
  exporters: {
    runtime_log: { enabled: boolean; required: boolean };
  };
};

export const defaultWorkflowObservabilityConfig: WorkflowObservabilityConfig = {
  exporters: {
    runtime_log: { enabled: true, required: false }
  }
};

export type WorkflowMetadata = {
  id: string;
  type: "workflow";
  mode?: "read_only" | "trusted_local_write";
  input_schema: string;
  output_schema: string;
  config?: {
    file: string;
    schema: string;
  };
  capabilities?: string[];
  execution?: WorkflowExecution;
  observability?: WorkflowObservabilityConfig;
  subagent_policy?: Partial<WorkflowSubagentPolicy>;
  requires?: Partial<WorkflowRequirements>;
};

export type ArtifactWritePlan = {
  path: string;
  source: WorkflowExpression;
  format: "json" | "markdown";
  required: boolean;
  publisher: string;
  semantic_type?: ArtifactSemanticType;
  config?: Record<string, unknown>;
};

export type ParsedArtifactWritePlan = ArtifactWritePlan;

export type ParsedWorkflowPolicy = {
  uses: string;
  config?: Record<string, unknown>;
};

export type WorkflowBuiltInNode = {
  id: string;
  type: "built_in";
  uses: string;
  input?: Record<string, unknown>;
  artifacts?: ArtifactWritePlan[];
  after?: string[];
};

export type WorkflowAgentNode = {
  id: string;
  type: "agent";
  agent: string;
  output_schema: string;
  input?: Record<string, unknown>;
  artifacts?: ArtifactWritePlan[];
  after?: string[];
  retry?: Record<string, unknown>;
  runtime_requirements?: string[];
  agent_session?: {
    isolation: "exclusive" | "shared";
  };
};

export type ParsedCapabilityGate = {
  id: string;
  type: `${string}.${string}`;
  input?: Record<string, unknown>;
  decision?: unknown;
  block_when?: WorkflowExpression;
  feedback?: WorkflowExpression;
};

export type ParsedWorkflowGate = ParsedCapabilityGate;

export type ParsedBuiltInNode = Omit<WorkflowBuiltInNode, "artifacts"> & {
  artifacts?: ParsedArtifactWritePlan[];
  policies?: ParsedWorkflowPolicy[];
};

export type ParsedAgentNode = Omit<WorkflowAgentNode, "artifacts"> & {
  artifacts?: ParsedArtifactWritePlan[];
  policies?: ParsedWorkflowPolicy[];
};

export type ParsedPatternNode = {
  id: string;
  type: "pattern";
  uses: string;
  worker?: string;
  input?: Record<string, unknown>;
  gates?: ParsedWorkflowGate[];
  repair?: Record<string, unknown>;
  artifacts?: ParsedArtifactWritePlan[];
  after?: string[];
  policies?: ParsedWorkflowPolicy[];
};

export type ParsedHumanGateNode = {
  id: string;
  type: "human_gate";
  uses: string;
  decision?: unknown;
  after?: string[];
  artifacts?: ParsedArtifactWritePlan[];
  policies?: ParsedWorkflowPolicy[];
};

/** A synchronous call to another installed workflow definition. */
export type ParsedWorkflowCallNode = {
  id: string;
  type: "workflow";
  workflow: string;
  input?: Record<string, unknown>;
  artifacts?: ParsedArtifactWritePlan[];
  after?: string[];
};

export type ParsedWorkflowNode =
  | ParsedBuiltInNode
  | ParsedAgentNode
  | ParsedPatternNode
  | ParsedHumanGateNode
  | ParsedWorkflowCallNode;

export type ParsedWorkflowGraph = {
  nodes: ParsedWorkflowNode[];
};

export type WorkflowPatternNode = ParsedPatternNode;
export type WorkflowHumanGateNode = ParsedHumanGateNode;
export type WorkflowCallNode = ParsedWorkflowCallNode;
export type WorkflowNode = ParsedWorkflowNode;

export type WorkflowGraph = ParsedWorkflowGraph;

export type WorkflowDefinition = {
  id: string;
  type: "workflow";
  mode: "read_only" | "trusted_local_write";
  directory: string;
  input_schema: string;
  output_schema: string;
  input_schema_content: unknown;
  output_schema_content: unknown;
  config?: WorkflowRuntimeConfig;
  capabilities: string[];
  graph: WorkflowGraph;
  revision: string;
  external_definition_digests: Record<string, string>;
  execution: WorkflowExecution;
  requires: WorkflowRequirements;
  observability: WorkflowObservabilityConfig;
  subagent_policy: WorkflowSubagentPolicy;
  /** Resolved direct children, keyed by installed workflow id. */
  compositions?: Readonly<Record<string, WorkflowDefinition>>;
};

export type LoadWorkflowDefinitionOptions = {
  capabilityRegistry?: CapabilityRegistry;
  digestResolver?: DefinitionDigestResolver;
  agentsRoot?: string;
};
