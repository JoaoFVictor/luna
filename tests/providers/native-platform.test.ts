import { describe, expect, it } from "vitest";
import { officialCapabilityRegistry } from "../../src/capabilities/registry.js";
import { nativeInputAdapterRegistry } from "../../src/providers/native-input-adapters.js";
import {
  nativeAgentRuntimeFactories,
  nativeWorkflowRuntimeFactories
} from "../../src/providers/native-runtime-factories.js";
import { runNativeWorkflowTarget } from "../../src/providers/native-workflow-runner.js";
import { nativeLunaPlatform } from "../../src/providers/native-platform.js";

describe("native Luna platform", () => {
  it("is the canonical registration object for native adapters, runtimes, capabilities, and runner", () => {
    expect(nativeLunaPlatform.inputAdapterRegistry).toBe(nativeInputAdapterRegistry);
    expect(nativeLunaPlatform.agentRuntimeFactories).toBe(nativeAgentRuntimeFactories);
    expect(nativeLunaPlatform.workflowRuntimeFactories).toBe(nativeWorkflowRuntimeFactories);
    expect(nativeLunaPlatform.capabilityRegistry).toBe(officialCapabilityRegistry);
    expect(nativeLunaPlatform.runWorkflow).toBe(runNativeWorkflowTarget);
  });

  it("exposes adapter and runtime ids from one extension surface", () => {
    expect(nativeLunaPlatform.inputAdapterRegistry.ids()).toEqual([
      "github-pr-url",
      "jira-task-url",
      "plane-task-url"
    ]);
    expect(Object.keys(nativeLunaPlatform.agentRuntimeFactories)).toEqual(["pi"]);
    expect(Object.keys(nativeLunaPlatform.workflowRuntimeFactories)).toEqual(["langgraph"]);
  });
});
