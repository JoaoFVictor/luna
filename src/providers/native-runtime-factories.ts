import { piAgentRuntimeFactory } from "../agent-runtimes/pi/factory.js";
import { langGraphWorkflowRuntimeFactory } from "../runtime/langgraph/workflow-runner.js";

export const nativeAgentRuntimeFactories = {
  [piAgentRuntimeFactory.id]: piAgentRuntimeFactory
};

export const nativeWorkflowRuntimeFactories = {
  [langGraphWorkflowRuntimeFactory.id]: langGraphWorkflowRuntimeFactory
};
