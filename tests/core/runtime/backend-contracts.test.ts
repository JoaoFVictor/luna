import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertRefOnlyCheckpointState,
  validateBackendManifest
} from "../../../src/core/runtime/backends/contracts.js";

describe("runtime backend contracts", () => {
  it("validates backend manifest options through registered schemas", () => {
    const manifest = {
      id: "fake-events",
      kind: "event",
      options: { max_events: 100 }
    } as const;

    expect(
      validateBackendManifest(manifest, {
        id: "fake-events",
        kind: "event",
        optionsSchema: z.object({ max_events: z.number().int().positive() }).strict()
      })
    ).toEqual({ max_events: 100 });

    expect(() =>
      validateBackendManifest(manifest, {
        id: "fake-events",
        kind: "event",
        optionsSchema: z.object({ max_events: z.string() }).strict()
      })
    ).toThrow(expect.objectContaining({ code: "runtime_backend_invalid" }));
  });

  it("accepts checkpoint state with refs and cursors only", () => {
    expect(() =>
      assertRefOnlyCheckpointState({
        state_schema_version: "2026-06",
        run_status: "waiting_for_input",
        artifact_refs: [{ id: "artifact-1", uri: "luna://run/artifacts/a.json" }],
        interrupt_refs: [{ id: "interrupt-1", uri: "interrupt://run/1" }],
        cursors: { events: "42" }
      })
    ).not.toThrow();

    expect(() =>
      assertRefOnlyCheckpointState({
        state_schema_version: "2026-06",
        node_statuses: { writer: { status: "succeeded" } }
      })
    ).toThrow(expect.objectContaining({ code: "runtime_checkpoint_not_ref_only" }));
  });
});
