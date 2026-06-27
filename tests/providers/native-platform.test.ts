import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../src/adapters/types.js";
import { officialCapabilityRegistry } from "../../src/capabilities/registry.js";
import { nativeInputAdapterRegistry } from "../../src/platform/native/native-input-adapters.js";
import {
  nativeAgentRuntimeFactories,
  nativeWorkflowRuntimeFactories
} from "../../src/platform/native/native-runtime-factories.js";
import { runNativeWorkflowTarget } from "../../src/platform/native/native-workflow-runner.js";
import { nativeLunaPlatform } from "../../src/platform/native/native-platform.js";
import {
  defineNativePlatformExtensions,
  nativePlatformExtensions
} from "../../src/platform/native/native-platform-extensions.js";

describe("native Luna platform", () => {
  const adapterContext = {
    projectRoot: "/project",
    configRoot: "/config",
    env: {},
    fetch,
    executeJson: async () => ({})
  } satisfies AdapterContext;

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

  it("derives adapter registration sources from provider extension ids", () => {
    const extensions = defineNativePlatformExtensions([
      {
        id: "linear",
        inputAdapters: [
          {
            id: "linear-task-url",
            description: "Linear task URL",
            load: async () => ({
              version: "2026-06",
              source: "linear",
              event: "issue",
              action: "selected",
              subject: {
                type: "issue",
                id: "ISS-1",
                url: "https://linear.app/ISS-1",
                title: "Issue"
              }
            })
          }
        ]
      }
    ]);

    expect(extensions[0]?.inputAdapters?.[0]).toMatchObject({
      id: "linear-task-url",
      source: "linear"
    });
  });

  it("rejects native adapters that return a different invocation source at load time", async () => {
    const extensions = defineNativePlatformExtensions([
      {
        id: "linear",
        inputAdapters: [
          {
            id: "linear-task-url",
            description: "Linear task URL",
            load: async () => ({
              version: "2026-06",
              source: "jira",
              event: "issue",
              action: "selected",
              subject: {
                type: "issue",
                id: "ISS-1",
                url: "https://linear.app/ISS-1",
                title: "Issue"
              }
            })
          }
        ]
      }
    ]);

    await expect(
      extensions[0]?.inputAdapters?.[0]?.load(
        { kind: "cli", value: "https://linear.app/ISS-1" },
        adapterContext
      )
    ).rejects.toMatchObject({
      code: "native_extension_invalid",
      message: expect.stringContaining("source jira does not match extension linear")
    });
  });
});
