import { describe, expect, it, vi } from "vitest";
import { defineInputAdapters } from "../../../src/adapters/registry.js";
import type { RegisteredInputAdapter } from "../../../src/adapters/types.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import {
  defineStudioAdapterPreviewPort,
  StudioAdapterPreviewRegistrationError
} from "../../../src/studio/application/inputs/adapter-preview-port.js";
import {
  listStudioInputAdapters,
  previewStudioInputAdapter
} from "../../../src/studio/application/inputs/input-adapters.js";
import {
  STUDIO_ADAPTER_INPUT_MAX_LENGTH,
  StudioInputAdapterSummarySchema
} from "../../../src/studio/contracts/input-routing.js";

function registeredAdapter(
  load: RegisteredInputAdapter["load"] = vi.fn(),
  loadEffects: NonNullable<RegisteredInputAdapter["loadEffects"]> = []
): RegisteredInputAdapter {
  return {
    id: "safe-preview",
    description: "Adapter used to exercise the controlled Studio preview port.",
    source: "fake",
    loadEffects,
    load
  };
}

describe("Studio input adapters", () => {
  it("lists typed registered adapters without exposing implementation fields", () => {
    const catalog = listStudioInputAdapters(
      nativeLunaPlatformRegistrations.inputAdapterRegistry
    );

    expect(catalog.adapters).toEqual([
      expect.objectContaining({
        id: "github-pr-url",
        source: "github",
        input_contract: { kind: "cli", value_type: "string" },
        preview: { enabled: false }
      }),
      expect.objectContaining({
        id: "jira-task-url",
        source: "jira",
        input_contract: { kind: "cli", value_type: "string" },
        preview: { enabled: false }
      }),
      expect.objectContaining({
        id: "plane-task-url",
        source: "plane",
        input_contract: { kind: "cli", value_type: "string" },
        preview: { enabled: false }
      })
    ]);
    expect(Object.keys(catalog.adapters[0] ?? {}).sort()).toEqual([
      "description",
      "id",
      "input_contract",
      "preview",
      "source"
    ]);
    expect(JSON.stringify(catalog)).not.toContain("load");
  });

  it("requires a source in every public adapter summary", () => {
    expect(
      StudioInputAdapterSummarySchema.safeParse({
        id: "missing-source",
        description: "Invalid summary",
        input_contract: { kind: "cli", value_type: "string" },
        preview: { enabled: false }
      }).success
    ).toBe(false);
  });

  it("defaults to deny without invoking the registered adapter or a raw context", async () => {
    const load = vi.fn();
    const adapter = registeredAdapter(load);
    const registry = defineInputAdapters([adapter]);

    await expect(
      previewStudioInputAdapter(
        {
          adapter_id: adapter.id,
          input: { kind: "cli", value: "opaque" },
          acknowledged_effects: []
        },
        { registry }
      )
    ).rejects.toMatchObject({ code: "studio_adapter_preview_disabled" });
    expect(load).not.toHaveBeenCalled();
  });

  it("requires an explicit controlled preview and redacts raw invocation fields", async () => {
    const rawLoad = vi.fn();
    const controlledPreview = vi.fn(async () => ({
      version: "2026-06" as const,
      source: "fake",
      event: "issue",
      action: "selected",
      references: { access_token: "reference-secret" },
      payload: {
        authorization: "payload-secret",
        callback: () => undefined
      }
    }));
    const adapter = registeredAdapter(rawLoad, [
      "credential_read",
      "network_read"
    ]);
    const registry = defineInputAdapters([adapter]);
    const previews = defineStudioAdapterPreviewPort(registry, [
      {
        adapterId: adapter.id,
        effects: ["credential_read", "network_read"],
        timeoutMs: 1_000,
        preview: controlledPreview
      }
    ]);

    expect(listStudioInputAdapters(registry, previews)).toMatchObject({
      adapters: [
        {
          id: adapter.id,
          preview: {
            enabled: true,
            effects: ["credential_read", "network_read"],
            timeout_ms: 1_000
          }
        }
      ]
    });

    const result = await previewStudioInputAdapter(
      {
        adapter_id: adapter.id,
        input: { kind: "cli", value: "opaque" },
        acknowledged_effects: ["network_read", "credential_read"]
      },
      { registry, previews }
    );

    expect(result).toEqual({
      adapter_id: adapter.id,
      effects: ["credential_read", "network_read"],
      invocation: {
        version: "2026-06",
        source: "fake",
        event: "issue",
        action: "selected"
      },
      redacted_fields: ["references", "payload"]
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(rawLoad).not.toHaveBeenCalled();
    expect(controlledPreview).toHaveBeenCalledWith(
      { kind: "cli", value: "opaque" },
      { signal: expect.any(AbortSignal) }
    );
  });

  it("does not execute a preview until every classified effect is acknowledged", async () => {
    const adapter = registeredAdapter(vi.fn(), [
      "network_read",
      "credential_read"
    ]);
    const registry = defineInputAdapters([adapter]);
    const controlledPreview = vi.fn();
    const previews = defineStudioAdapterPreviewPort(registry, [
      {
        adapterId: adapter.id,
        effects: ["network_read", "credential_read"],
        timeoutMs: 1_000,
        preview: controlledPreview
      }
    ]);

    await expect(
      previewStudioInputAdapter(
        {
          adapter_id: adapter.id,
          input: { kind: "cli", value: "opaque" },
          acknowledged_effects: ["network_read"]
        },
        { registry, previews }
      )
    ).rejects.toMatchObject({
      code: "studio_adapter_preview_effects_unacknowledged"
    });
    expect(controlledPreview).not.toHaveBeenCalled();
  });

  it("rejects oversized opaque input before invoking the preview", async () => {
    const adapter = registeredAdapter();
    const registry = defineInputAdapters([adapter]);
    const controlledPreview = vi.fn();
    const previews = defineStudioAdapterPreviewPort(registry, [
      {
        adapterId: adapter.id,
        effects: [],
        timeoutMs: 1_000,
        preview: controlledPreview
      }
    ]);

    await expect(
      previewStudioInputAdapter(
        {
          adapter_id: adapter.id,
          input: {
            kind: "cli",
            value: "x".repeat(STUDIO_ADAPTER_INPUT_MAX_LENGTH + 1)
          },
          acknowledged_effects: []
        },
        { registry, previews }
      )
    ).rejects.toMatchObject({
      code: "studio_adapter_preview_invalid_request"
    });
    expect(controlledPreview).not.toHaveBeenCalled();
  });

  it("rejects a controlled preview that violates the registered source", async () => {
    const adapter = registeredAdapter();
    const registry = defineInputAdapters([adapter]);
    const previews = defineStudioAdapterPreviewPort(registry, [
      {
        adapterId: adapter.id,
        effects: [],
        timeoutMs: 1_000,
        async preview() {
          return {
            version: "2026-06",
            source: "different-provider",
            event: "test"
          };
        }
      }
    ]);

    await expect(
      previewStudioInputAdapter(
        {
          adapter_id: adapter.id,
          input: { kind: "cli", value: "opaque" },
          acknowledged_effects: []
        },
        { registry, previews }
      )
    ).rejects.toMatchObject({
      code: "studio_adapter_preview_source_mismatch"
    });
  });

  it("times out even when the preview ignores cooperative cancellation", async () => {
    vi.useFakeTimers();
    try {
      const adapter = registeredAdapter();
      const registry = defineInputAdapters([adapter]);
      let operationSignal: AbortSignal | undefined;
      const previews = defineStudioAdapterPreviewPort(registry, [
        {
          adapterId: adapter.id,
          effects: [],
          timeoutMs: 25,
          preview(_input, context) {
            operationSignal = context.signal;
            return new Promise<never>(() => undefined);
          }
        }
      ]);
      const outcome = previewStudioInputAdapter(
        {
          adapter_id: adapter.id,
          input: { kind: "cli", value: "opaque" },
          acknowledged_effects: []
        },
        { registry, previews }
      ).catch((cause: unknown) => cause);

      await vi.advanceTimersByTimeAsync(25);

      await expect(outcome).resolves.toMatchObject({
        code: "studio_adapter_preview_timeout",
        message: "Studio adapter preview timed out"
      });
      expect(operationSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates abort cooperatively and removes timers and listeners", async () => {
    vi.useFakeTimers();
    try {
      const adapter = registeredAdapter();
      const registry = defineInputAdapters([adapter]);
      const caller = new AbortController();
      const removeListener = vi.spyOn(caller.signal, "removeEventListener");
      let operationSignal: AbortSignal | undefined;
      const previews = defineStudioAdapterPreviewPort(registry, [
        {
          adapterId: adapter.id,
          effects: [],
          timeoutMs: 1_000,
          preview(_input, context) {
            operationSignal = context.signal;
            return new Promise<never>(() => undefined);
          }
        }
      ]);
      const outcome = previewStudioInputAdapter(
        {
          adapter_id: adapter.id,
          input: { kind: "cli", value: "opaque" },
          acknowledged_effects: []
        },
        { registry, previews, signal: caller.signal }
      ).catch((cause: unknown) => cause);

      caller.abort();

      await expect(outcome).resolves.toMatchObject({
        code: "studio_adapter_preview_aborted",
        message: "Studio adapter preview was cancelled"
      });
      expect(operationSignal?.aborted).toBe(true);
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps implementation failures without exposing oversized secrets", async () => {
    const adapter = registeredAdapter();
    const registry = defineInputAdapters([adapter]);
    const previews = defineStudioAdapterPreviewPort(registry, [
      {
        adapterId: adapter.id,
        effects: [],
        timeoutMs: 1_000,
        async preview() {
          throw new Error(`secret-${"x".repeat(100_000)}`);
        }
      }
    ]);
    const error = await previewStudioInputAdapter(
      {
        adapter_id: adapter.id,
        input: { kind: "cli", value: "opaque" },
        acknowledged_effects: []
      },
      { registry, previews }
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "studio_adapter_preview_failed",
      message: "Studio adapter preview failed"
    });
    expect(String(error)).not.toContain("secret-");
    expect(String(error).length).toBeLessThan(128);
    expect(error).not.toHaveProperty("cause");
  });

  it("rejects duplicate or invalid preview registrations at composition", () => {
    const adapter = registeredAdapter();
    const registry = defineInputAdapters([adapter]);
    const definition = {
      adapterId: adapter.id,
      effects: [] as const,
      timeoutMs: 1_000,
      async preview() {
        return { version: "2026-06" as const, source: "fake", event: "test" };
      }
    };

    expect(() =>
      defineStudioAdapterPreviewPort(registry, [definition, definition])
    ).toThrow(
      expect.objectContaining<Partial<StudioAdapterPreviewRegistrationError>>({
        code: "studio_adapter_preview_duplicate"
      })
    );
    expect(() =>
      defineStudioAdapterPreviewPort(registry, [
        {
          ...definition,
          effects: ["network_read", "network_read"]
        }
      ])
    ).toThrow(
      expect.objectContaining<Partial<StudioAdapterPreviewRegistrationError>>({
        code: "studio_adapter_preview_invalid_effects"
      })
    );
    for (const timeoutMs of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        defineStudioAdapterPreviewPort(registry, [
          { ...definition, timeoutMs }
        ])
      ).toThrow(
        expect.objectContaining<Partial<StudioAdapterPreviewRegistrationError>>({
          code: "studio_adapter_preview_invalid_timeout"
        })
      );
    }

    const classified = registeredAdapter(vi.fn(), ["network_read"]);
    const classifiedRegistry = defineInputAdapters([classified]);
    expect(() =>
      defineStudioAdapterPreviewPort(classifiedRegistry, [{
        ...definition,
        adapterId: classified.id
      }])
    ).toThrow(
      expect.objectContaining<Partial<StudioAdapterPreviewRegistrationError>>({
        code: "studio_adapter_preview_effect_mismatch"
      })
    );
  });
});
