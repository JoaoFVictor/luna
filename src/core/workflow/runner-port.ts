export type WorkflowRuntimeRunner<TRunInput, TResumeInput, TResult> = {
  run(input: TRunInput): Promise<TResult>;
  resume(input: TResumeInput): Promise<TResult>;
};
