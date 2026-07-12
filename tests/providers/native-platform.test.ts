import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../src/adapters/types.js";
import type { WebhookProviderAdapterFactory } from "../../src/webhooks/contracts.js";
import {
  createNativeLunaPlatformRegistrations
} from "../../src/platform/native/native-platform-registrations.js";
import {
  defineNativePlatformPlugins,
  nativePlatformPlugins
} from "../../src/platform/native/native-platform-plugins.js";

describe("native Luna platform", () => {
  function webhookAdapterFactory(id: string): WebhookProviderAdapterFactory {
    return {
      id,
      description: `${id} webhook provider`,
      create: () => ({
        id,
        description: `${id} webhook provider`,
        verify: () => {},
        normalize: () => ({
          kind: "ignored",
          deliveryId: "delivery-1",
          reason: "test factory"
        })
      })
    };
  }

  const adapterContext = {
    projectRoot: "/project",
    configRoot: "/config",
    env: {},
    fetch,
    executeJson: async () => ({})
  } satisfies AdapterContext;

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

  it("rejects duplicate native webhook provider ids at plugin definition time", () => {
    let error: unknown;

    try {
      defineNativePlatformPlugins([
        {
          id: "left",
          webhookAdapterFactories: [webhookAdapterFactory("github")]
        },
        {
          id: "right",
          webhookAdapterFactories: [webhookAdapterFactory("github")]
        }
      ]);
    } catch (cause) {
      error = cause;
    }

    expect(error).toMatchObject({
      code: "native_plugin_invalid",
      message: "Duplicate native webhook provider: github"
    });
  });

  it("exposes native webhook provider factory ids through registrations", () => {
    const registrations = createNativeLunaPlatformRegistrations({
      plugins: defineNativePlatformPlugins([
        {
          id: "webhooks",
          webhookAdapterFactories: [
            webhookAdapterFactory("github"),
            webhookAdapterFactory("plane")
          ]
        }
      ]),
      baseCapabilityManifests: []
    });

    expect(registrations.webhookProviderRegistry.ids()).toEqual(["github", "plane"]);
  });

  it("registers default webhook provider factories in the default native platform", () => {
    const registrations = createNativeLunaPlatformRegistrations({
      plugins: nativePlatformPlugins,
      baseCapabilityManifests: []
    });

    expect(registrations.webhookProviderRegistry.ids()).toContain("github");
    expect(registrations.webhookProviderRegistry.ids()).toContain("plane");
  });

  it("registers dedicated health probes for every default external provider", () => {
    const registrations = createNativeLunaPlatformRegistrations({
      plugins: nativePlatformPlugins,
      baseCapabilityManifests: []
    });

    expect(registrations.providerHealthProbeRegistry.ids()).toEqual([
      "github",
      "jira",
      "plane"
    ]);
    expect(
      registrations.providerHealthProbeRegistry.require("github").effects
    ).toEqual(["credential_read", "network_read", "process_execution"]);
    expect(
      registrations.providerHealthProbeRegistry.require("plane").effects
    ).toEqual(["credential_read", "network_read"]);
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
