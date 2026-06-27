import { describe, expect, it } from "vitest";
import {
  defaultAdapterContext,
  defineInputAdapters,
  executeJson,
  unknownAdapterError
} from "../../src/adapters/registry.js";
import { nativeInputAdapterRegistry } from "../../src/providers/native-input-adapters.js";
import type { InputAdapter } from "../../src/adapters/types.js";

function adapter(id: string): InputAdapter {
  return {
    id,
    description: `${id} adapter`,
    async load() {
      throw new Error("not used");
    }
  };
}

describe("input adapter registry", () => {
  it("resolves adapters by id and lists registered ids", () => {
    const github = adapter("github-pr-url");
    const jira = adapter("jira-task-url");
    const registry = defineInputAdapters([github, jira]);

    expect(registry.get("github-pr-url")).toBe(github);
    expect(registry.require("jira-task-url")).toBe(jira);
    expect(registry.ids()).toEqual(["github-pr-url", "jira-task-url"]);
  });

  it("rejects duplicate adapter ids", () => {
    expect(() =>
      defineInputAdapters([adapter("github-pr-url"), adapter("github-pr-url")])
    ).toThrow(expect.objectContaining({ code: "duplicate_input_adapter" }));
  });

  it("includes available adapters in unknown adapter errors", () => {
    const registry = defineInputAdapters([
      adapter("github-pr-url"),
      adapter("jira-task-url")
    ]);
    const error = unknownAdapterError("linear-task-url", registry);

    expect(error).toMatchObject({
      code: "unknown_input_adapter"
    });
    expect(error.message).toContain("linear-task-url");
    expect(error.message).toContain("github-pr-url");
    expect(error.message).toContain("jira-task-url");
    expect(() => registry.require("linear-task-url")).toThrow(error);
  });

  it("composes the native input adapters outside the generic registry", () => {
    expect(nativeInputAdapterRegistry.ids()).toEqual([
      "github-pr-url",
      "jira-task-url",
      "plane-task-url"
    ]);
    expect(nativeInputAdapterRegistry.require("github-pr-url").id).toBe("github-pr-url");
    expect(nativeInputAdapterRegistry.require("jira-task-url").id).toBe("jira-task-url");
    expect(nativeInputAdapterRegistry.require("plane-task-url").id).toBe("plane-task-url");
  });

  it("builds the default adapter context", () => {
    const context = defaultAdapterContext("/workspace/project", "/workspace/config");

    expect(context).toMatchObject({
      projectRoot: "/workspace/project",
      configRoot: "/workspace/config",
      env: process.env,
      fetch
    });
    expect(context.executeJson).toBe(executeJson);
  });

  it("executes a command and parses JSON output", async () => {
    await expect(
      executeJson("echo", ['{"ok":true}'])
    ).resolves.toEqual({ ok: true });
  });
});
