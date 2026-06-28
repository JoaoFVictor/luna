import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { nativeInputAdapterRegistry } from "../../../src/platform/native/native-input-adapters.js";
import {
  InvocationEnvelopeSchema,
  type InvocationEnvelope
} from "../../../src/core/router/invocation.js";

const minimalInvocation = {
  version: "2026-06",
  source: "manual",
  event: "dispatch"
} satisfies InvocationEnvelope;

describe("invocation envelope", () => {
  it("validates normalized provider-agnostic invocations", () => {
    expect(InvocationEnvelopeSchema.parse(minimalInvocation)).toEqual(
      minimalInvocation
    );
  });

  it("rejects workflow-specific target strings", () => {
    expect(() =>
      InvocationEnvelopeSchema.parse({
        version: "2026-06",
        source: "manual",
        event: "dispatch",
        target: "code-review"
      })
    ).toThrow();
  });

  it("keeps every registered adapter normalize-only through the shared envelope", () => {
    expect(nativeInputAdapterRegistry.ids().sort()).toEqual([
      "github-pr-url",
      "jira-task-url",
      "plane-task-url"
    ]);

    for (const id of nativeInputAdapterRegistry.ids()) {
      const adapter = nativeInputAdapterRegistry.require(id);
      expect(adapter.load.constructor.name).toBe("AsyncFunction");
    }
  });

  it("keeps adapter modules independent from routing and runtime execution", async () => {
    const adapterFiles = [
      "src/providers/github/input-adapter.ts",
      "src/providers/jira/input-adapter.ts",
      "src/providers/plane/input-adapter.ts",
      "src/adapters/registry.ts"
    ];
    const forbiddenImports = [
      "agent-runtime/pi",
      "core/router/router",
      "core/router/router-definition",
      "workflow-factory",
      "workflows/"
    ];

    await Promise.all(
      adapterFiles.map(async (file) => {
        const source = await readFile(file, "utf8");

        for (const forbiddenImport of forbiddenImports) {
          expect(source, `${file} imports ${forbiddenImport}`).not.toContain(
            forbiddenImport
          );
        }
      })
    );
  });
});
