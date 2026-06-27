import { describe, expect, it } from "vitest";
import { officialCapabilityRegistry } from "../../src/capabilities/registry.js";
import { nativeInputAdapterRegistry } from "../../src/platform/native/native-input-adapters.js";
import {
  nativeAgentRuntimeFactories,
  nativeWorkflowRuntimeFactories
} from "../../src/platform/native/native-runtime-factories.js";
import { runNativeWorkflowTarget } from "../../src/platform/native/native-workflow-runner.js";
import { nativeLunaPlatform } from "../../src/platform/native/native-platform.js";
import { nativePlatformExtensions } from "../../src/platform/native/native-platform-extensions.js";

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

  it("composes native platform extension facets independently", () => {
    expect(nativePlatformExtensions.map((extension) => extension.id)).toEqual([
      "github",
      "jira",
      "plane"
    ]);
    expect(nativePlatformExtensions.flatMap((extension) =>
      (extension.inputAdapters ?? []).map((adapter) => adapter.id)
    )).toEqual(["github-pr-url", "jira-task-url", "plane-task-url"]);
    expect(nativePlatformExtensions.filter((extension) =>
      extension.taskBuiltIns !== undefined
    ).map((extension) => extension.id)).toEqual(["jira", "plane"]);
    expect(nativePlatformExtensions.filter((extension) =>
      extension.changeRequestProviderFactories !== undefined
    ).map((extension) => extension.id)).toEqual(["github"]);
  });
});
