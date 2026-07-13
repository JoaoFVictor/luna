import type {
  ResumeWorkflowInput,
  RunWorkflowInput,
  WorkflowAgentDefaults,
  WorkflowAgentInputMap,
  WorkflowBuiltInExecutor,
  WorkflowBuiltInMetadataResolver,
  WorkflowPatternExecutor,
  WorkflowRunResult
} from "../../core/workflow/execution-contracts.js";

export type {
  WorkflowAgentDefaults,
  WorkflowAgentInputMap,
  WorkflowBuiltInExecutor,
  WorkflowBuiltInMetadataResolver,
  WorkflowPatternExecutor,
  WorkflowRunResult
};

export type RunCompiledWorkflowInput = RunWorkflowInput;

export type ResumeCompiledWorkflowInput = ResumeWorkflowInput;
