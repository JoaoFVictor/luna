import { describe, expect, it } from "vitest";
import type { WorkflowRuntimeRunner } from "../../../src/core/workflow/runner-port.js";
import {
  createLangGraphWorkflowRuntimeRunner,
  type ResumeCompiledWorkflowInput,
  type RunCompiledWorkflowInput,
  type WorkflowRunResult
} from "../../../src/runtime/langgraph/workflow-runner.js";

describe("LangGraph workflow runtime runner", () => {
  it("exposes LangGraph as a neutral workflow runtime runner implementation", () => {
    const runner: WorkflowRuntimeRunner<
      RunCompiledWorkflowInput,
      ResumeCompiledWorkflowInput,
      WorkflowRunResult
    > = createLangGraphWorkflowRuntimeRunner();

    expect(runner).toEqual({
      run: expect.any(Function),
      resume: expect.any(Function)
    });
  });
});
