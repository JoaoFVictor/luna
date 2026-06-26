import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertRefOnlyCheckpointState,
  validateBackendManifest
} from "../../../src/core/runtime/backends/contracts.js";
import { memoryEventBackendRegistration } from "../../../src/runtime/backends/memory/events.js";

async function tsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return await tsFiles(entryPath);
      }

      return entry.name.endsWith(".ts") ? [entryPath] : [];
    })
  );

  return nested.flat();
}

describe("runtime backend contracts", () => {
  it("keeps core runtime backend files to contracts only", async () => {
    const files = await tsFiles("src/core/runtime");
    const backendFiles = files.filter((file) => file.includes(`${path.sep}backends${path.sep}`));

    expect(backendFiles.sort()).toEqual([
      path.join("src", "core", "runtime", "backends", "contracts.ts")
    ]);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, `${file} imports concrete runtime backends`).not.toContain(
        "../../runtime/backends"
      );
      expect(source, `${file} imports concrete runtime backends`).not.toContain(
        "../../../runtime/backends"
      );
    }
  });

  it("validates backend manifest options through registered schemas", () => {
    expect(
      validateBackendManifest(
        {
          id: "memory.events",
          kind: "event",
          options: {}
        },
        memoryEventBackendRegistration
      )
    ).toEqual({});

    expect(() =>
      validateBackendManifest(
        {
          id: "memory.events",
          kind: "event",
          options: { unsupported: true }
        },
        memoryEventBackendRegistration
      )
    ).toThrow(expect.objectContaining({ code: "runtime_backend_invalid" }));

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
