import type {
  JsonObject,
  RuntimeBackends
} from "../runtime/backends/contracts.js";

export type WorkflowRuntimeRunner<TRunInput, TResumeInput, TResult> = {
  run(input: TRunInput): Promise<TResult>;
  resume(input: TResumeInput): Promise<TResult>;
};

export type WorkflowRuntimeFactory<TRunInput, TResumeInput, TResult> = {
  readonly id: string;
  readonly create: (
    options: JsonObject,
    context: WorkflowRuntimeFactoryContext
  ) => WorkflowRuntimeRunner<
    TRunInput,
    TResumeInput,
    TResult
  >;
};

export type WorkflowRuntimeFactoryContext = {
  readonly checkpoints: {
    readonly backendId: string;
    readonly store: RuntimeBackends["checkpoints"];
  };
};
