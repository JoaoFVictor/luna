import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
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

export type RunCompiledWorkflowInput = RunWorkflowInput & {
  readonly langGraphCheckpointer?: BaseCheckpointSaver;
};

export type ResumeCompiledWorkflowInput = ResumeWorkflowInput & {
  readonly langGraphCheckpointer?: BaseCheckpointSaver;
};
