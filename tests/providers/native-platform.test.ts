import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../src/adapters/types.js";
import { officialCapabilityRegistry } from "../../src/capabilities/registry.js";
import { capabilityManifest } from "../../src/core/capabilities/manifest.js";
import { defineBuiltInStep } from "../../src/core/built-ins/registry.js";
import { nativeInputAdapterRegistry } from "../../src/platform/native/native-input-adapters.js";
import { runNativeWorkflowTarget } from "../../src/platform/native/native-workflow-runner.js";
import { nativeLunaPlatform } from "../../src/platform/native/native-platform.js";
import {
  createNativeLunaPlatformRegistrations
} from "../../src/platform/native/native-platform-registrations.js";
import {
  defineNativePlatformPlugins,
  nativePlatformPlugins
} from "../../src/platform/native/native-platform-plugins.js";

describe("native Luna platform", () => {
  const adapterContext = {
    projectRoot: "/project",
    configRoot: "/config",
    env: {},
    fetch,
    executeJson: async () => ({})
  } satisfies AdapterContext;

  it("is the canonical registration object for native adapters, runtimes, capabilities, and runner", () => {
    expect(nativeLunaPlatform.inputAdapterRegistry.ids()).toEqual(
      nativeInputAdapterRegistry.ids()
    );
    expect(Object.keys(nativeLunaPlatform.agentRuntimeFactories)).toEqual(["pi"]);
    expect(Object.keys(nativeLunaPlatform.workflowRuntimeFactories)).toEqual(["langgraph"]);
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

  it("composes native platform plugin facets independently", () => {
    expect(nativePlatformPlugins.map((plugin) => plugin.id)).toEqual([
      "runtime",
      "quality-gates",
      "github",
      "jira",
      "plane"
    ]);
    expect(nativePlatformPlugins.flatMap((plugin) =>
      (plugin.inputAdapters ?? []).map((adapter) => adapter.id)
    )).toEqual(["github-pr-url", "jira-task-url", "plane-task-url"]);
    expect(nativePlatformPlugins.filter((plugin) =>
      plugin.taskBuiltIns !== undefined
    ).map((plugin) => plugin.id)).toEqual(["jira", "plane"]);
    expect(nativePlatformPlugins.filter((plugin) =>
      plugin.changeRequestProviderFactories !== undefined
    ).map((plugin) => plugin.id)).toEqual(["github"]);
    expect(nativeLunaPlatform.patternExecutors).toHaveProperty(
      "quality-gates.gated_agent_loop"
    );
  });

  it("uses plugin ids as default adapter sources", () => {
    const plugins = defineNativePlatformPlugins([
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

    expect(plugins[0]?.inputAdapters?.[0]).toMatchObject({
      id: "linear-task-url",
      source: "linear"
    });
  });

  it("allows plugins to register adapters for explicit invocation sources", async () => {
    const plugins = defineNativePlatformPlugins([
      {
        id: "atlassian",
        inputAdapters: [
          {
            source: "jira",
            adapter: {
              id: "jira-cloud-url",
              description: "Jira Cloud issue URL",
              load: async () => ({
                version: "2026-06",
                source: "jira",
                event: "issue",
                action: "selected",
                subject: {
                  type: "issue",
                  id: "JRA-1",
                  url: "https://example.atlassian.net/browse/JRA-1",
                  title: "Issue"
                }
              })
            }
          }
        ]
      }
    ]);

    expect(plugins[0]?.inputAdapters?.[0]).toMatchObject({
      id: "jira-cloud-url",
      source: "jira"
    });
    await expect(
      plugins[0]?.inputAdapters?.[0]?.load(
        { kind: "cli", value: "https://example.atlassian.net/browse/JRA-1" },
        adapterContext
      )
    ).resolves.toMatchObject({ source: "jira" });
  });

  it("rejects native adapters that return a different invocation source at load time", async () => {
    const plugins = defineNativePlatformPlugins([
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
      plugins[0]?.inputAdapters?.[0]?.load(
        { kind: "cli", value: "https://linear.app/ISS-1" },
        adapterContext
      )
    ).rejects.toMatchObject({
      code: "native_plugin_invalid",
      message: expect.stringContaining("source jira does not match registered source linear")
    });
  });

  it("builds a real platform registration from plugin-provided manifests and runtimes", () => {
    const manifest = capabilityManifest({
      id: "linear",
      kind: "execution",
      version: "1.0.0",
      built_ins: {
        "linear.collect_issue": {
          id: "linear.collect_issue",
          input_schema: { type: "object" },
          output_schema: { type: "object" },
          required_ports: []
        }
      }
    });
    const plugins = defineNativePlatformPlugins([
      {
        id: "linear",
        capabilityManifests: [manifest],
        builtIns: [
          defineBuiltInStep({
            name: "linear.collect_issue",
            run: () => ({})
          })
        ],
        agentRuntimeFactories: {
          "linear.agent": {
            id: "linear.agent",
            create: () => ({
              describe: () => ({
                id: "linear.agent",
                display_name: "Linear Agent",
                supported_tool_protocols: [],
                supported_runtime_requirements: []
              }),
              validate: async () => {},
              runAgent: async () => ({ output: {} })
            })
          }
        }
      }
    ]);

    const platform = createNativeLunaPlatformRegistrations({
      plugins,
      baseCapabilityManifests: []
    });

    expect(platform.capabilityRegistry.has("linear")).toBe(true);
    expect(platform.capabilityRegistry.registrations().built_ins.has(
      "linear.collect_issue"
    )).toBe(true);
    expect(platform.workflowBuiltIns?.builtIns?.map((builtIn) => builtIn.name)).toEqual([
      "linear.collect_issue"
    ]);
    expect(Object.keys(platform.agentRuntimeFactories)).toEqual(["linear.agent"]);
  });

  it("registers task built-ins by explicit invocation source", () => {
    const taskBuiltIns = {
      collectTaskContext: () => ({ ok: true }),
      finalImplementationReport: () => ({ ok: true })
    };
    const plugins = defineNativePlatformPlugins([
      {
        id: "atlassian",
        taskSource: "jira",
        taskBuiltIns
      }
    ]);

    const platform = createNativeLunaPlatformRegistrations({
      plugins,
      baseCapabilityManifests: []
    });

    expect(platform.taskProviderBuiltIns).toEqual({ jira: taskBuiltIns });
  });

  it("rejects duplicate task provider invocation sources at plugin definition time", () => {
    const taskBuiltIns = {
      collectTaskContext: () => ({ ok: true }),
      finalImplementationReport: () => ({ ok: true })
    };

    expect(() =>
      defineNativePlatformPlugins([
        {
          id: "atlassian",
          taskSource: "jira",
          taskBuiltIns
        },
        {
          id: "jira-cloud",
          taskSource: "jira",
          taskBuiltIns
        }
      ])
    ).toThrow("Duplicate native task source: jira");
  });

  it("rejects duplicate runtime registrations even when registrations are built manually", () => {
    const agentRuntimeFactory = {
      id: "shared.agent",
      create: () => ({
        describe: () => ({
          id: "shared.agent",
          display_name: "Shared Agent",
          supported_tool_protocols: [],
          supported_runtime_requirements: []
        }),
        validate: async () => {},
        runAgent: async () => ({ output: {} })
      })
    };
    const buildDuplicateRegistration = () =>
      createNativeLunaPlatformRegistrations({
        plugins: [
          {
            id: "left",
            agentRuntimeFactories: { "shared.agent": agentRuntimeFactory }
          },
          {
            id: "right",
            agentRuntimeFactories: { "shared.agent": agentRuntimeFactory }
          }
        ],
        baseCapabilityManifests: []
      });

    let error: unknown;
    try {
      buildDuplicateRegistration();
    } catch (cause) {
      error = cause;
    }

    expect(error).toMatchObject({
      message: "Duplicate native agent runtime id: shared.agent",
      code: "native_platform_registration_invalid"
    });
  });
});
