import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { inputAdapterRegistry } from "../../../src/adapters/registry.js";
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

  it("rejects legacy or workflow-specific target strings", () => {
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
    expect(inputAdapterRegistry.ids().sort()).toEqual([
      "github-pr-url",
      "jira-task-url",
      "plane-task-url"
    ]);

    for (const id of inputAdapterRegistry.ids()) {
      const adapter = inputAdapterRegistry.require(id);
      expect(adapter.load.constructor.name).toBe("AsyncFunction");
    }
  });

  it("keeps adapter modules independent from routing and runtime execution", async () => {
    const adapterFiles = [
      "src/adapters/github-pr-url/adapter.ts",
      "src/adapters/jira-task-url/adapter.ts",
      "src/adapters/plane-task-url/adapter.ts",
      "src/adapters/registry.ts"
    ];
    const forbiddenImports = [
      "configured-workflow",
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
