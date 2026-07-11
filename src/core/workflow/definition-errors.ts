export type WorkflowDefinitionErrorCode =
  | "workflow_unknown_field"
  | "workflow_schema_invalid"
  | "workflow_schema_missing"
  | "workflow_id_mismatch"
  | "workflow_node_duplicate"
  | "workflow_node_id_reserved"
  | "workflow_capability_missing"
  | "workflow_capability_unknown"
  | "workflow_capability_id_unqualified"
  | "workflow_capability_config_invalid"
  | "workflow_side_effect_policy_missing"
  | "workflow_side_effect_policy_invalid"
  | "workflow_reference_unknown"
  | "workflow_cycle_detected"
  | "workflow_string_expression"
  | "workflow_expression_invalid"
  | "workflow_expression_unresolved"
  | "workflow_expression_context_shadow"
  | "workflow_agent_output_schema_missing"
  | "workflow_external_definition_missing"
  | "workflow_path_escape";

export class WorkflowDefinitionError extends Error {
  readonly code: WorkflowDefinitionErrorCode;
  readonly path?: string;
  readonly capability?: string;
  readonly nodeId?: string;
  readonly edge?: { readonly from: string; readonly to: string };

  constructor(
    code: WorkflowDefinitionErrorCode,
    message: string,
    options: {
      path?: string;
      capability?: string;
      nodeId?: string;
      edge?: { readonly from: string; readonly to: string };
    } = {}
  ) {
    super(message);
    this.name = "WorkflowDefinitionError";
    this.code = code;
    this.path = options.path;
    this.capability = options.capability;
    this.nodeId = options.nodeId;
    this.edge = options.edge;
  }
}
