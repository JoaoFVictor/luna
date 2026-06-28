export type WorkflowRuntimeContext = {
  readonly repository?: unknown;
  readonly workspaceRoot?: string;
  readonly agentsRoot?: string;
  workspace?: unknown;
  lifecycleEvidence?: unknown;
};
