import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchesJsonSchema } from "../../../src/core/capabilities/json-schema.js";
import { manifest } from "../../../src/capabilities/repository-context/manifest.js";
import {
  clearRepositoryIndexCache,
  repositoryIndexCacheStats
} from "../../../src/capabilities/repository-context/repository-index.js";
import { REPOSITORY_CONTEXT_INPUT_LIMITS } from
  "../../../src/capabilities/repository-context/config-policy.js";
import {
  repositoryContextQueryInputJsonSchema,
  repositoryContextQueryOutputJsonSchema,
  repositoryContextQueryToolContract
} from "../../../src/capabilities/repository-context/tool-contracts.js";
import { repositoryContextQueryTool } from
  "../../../src/capabilities/repository-context/tools.js";
import { initializeGitRepository, write } from "./related-context-test-support.js";

describe("repository-context.query local tool", () => {
  it("registers one read-only capability-owned tool in both agent modes", () => {
    expect(manifest.tools?.["repository-context.query"]).toMatchObject({
      id: repositoryContextQueryToolContract.id,
      protocol: "local",
      input_schema: repositoryContextQueryToolContract.input_schema,
      output_schema: repositoryContextQueryToolContract.output_schema,
      allowed_agent_modes: repositoryContextQueryToolContract.modes,
      safety: repositoryContextQueryToolContract.safety
    });
    expect(repositoryContextQueryTool.safety).toEqual({
      localWrites: false,
      network: false,
      externalSideEffects: false
    });
    expect(repositoryContextQueryTool.modes).toEqual(["read_only", "trusted_local_write"]);
    expect(repositoryContextQueryTool.runtime_requirements).toEqual(["tool_calling"]);
  });

  it("publishes bounded strict input and output schemas", () => {
    expect(matchesJsonSchema(repositoryContextQueryInputJsonSchema, {
      query: { text: "comment composer", paths: [], symbols: [] }
    })).toBe(true);
    expect(matchesJsonSchema(repositoryContextQueryInputJsonSchema, {
      query: { text: "comment composer" }, expected_snapshot_id: `sha256:${"a".repeat(64)}`
    })).toBe(true);
    expect(matchesJsonSchema(repositoryContextQueryInputJsonSchema, {
      query: { text: "comment composer" }, expected_snapshot_id: "not-a-snapshot"
    })).toBe(false);
    expect(matchesJsonSchema(repositoryContextQueryInputJsonSchema, {
      query: { text: "comment composer" }, unexpected: true
    })).toBe(false);
    expect(matchesJsonSchema(repositoryContextQueryInputJsonSchema, {
      query: { text: "x", paths: Array(101).fill("src/a.ts") }
    })).toBe(false);
  });

  it("automatically pins agent queries to their supplied repository context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-query-snapshot-"));
    await initializeGitRepository(root);
    try {
      await write(root, "src/Composer.ts", "export const Composer = 'first';\n");
      clearRepositoryIndexCache();
      const initial = await repositoryContextQueryTool.createHandler({ cwd: root })({
        query: { text: "Composer" }
      });
      const bound = repositoryContextQueryTool.createHandler({
        cwd: root,
        agentInput: { related_context: initial }
      });

      await expect(bound({ query: { text: "Composer" } }))
        .resolves.toMatchObject({ snapshot: { id: initial.snapshot.id } });
      await write(root, "src/Composer.ts", "export const Composer = 'changed';\n");
      await expect(bound({ query: { text: "Composer" } }))
        .rejects.toThrow("Repository context snapshot changed");
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on a spoofed or ambiguous agent snapshot binding", async () => {
    const context = (id: string) => ({
      kind: "luna.repository_context.v2",
      snapshot: { id }
    });
    const one = repositoryContextQueryTool.createHandler({
      cwd: process.cwd(),
      agentInput: { related_context: context(`sha256:${"a".repeat(64)}`) }
    });
    await expect(one({
      query: { text: "bounded" },
      expected_snapshot_id: `sha256:${"b".repeat(64)}`
    })).rejects.toThrow("does not match the agent's bound snapshot");

    const ambiguous = repositoryContextQueryTool.createHandler({
      cwd: process.cwd(),
      agentInput: {
        initial: context(`sha256:${"a".repeat(64)}`),
        evidence: context(`sha256:${"b".repeat(64)}`)
      }
    });
    await expect(ambiguous({ query: { text: "bounded" } }))
      .rejects.toThrow("multiple snapshots");

    let tooDeep: Record<string, unknown> = {};
    for (let depth = 0; depth < 30; depth += 1) tooDeep = { child: tooDeep };
    const uninspectable = repositoryContextQueryTool.createHandler({
      cwd: process.cwd(),
      agentInput: tooDeep
    });
    await expect(uninspectable({ query: { text: "bounded" } }))
      .rejects.toThrow("complete agent snapshot binding");
  });

  it("returns the canonical snapshot and reuses the index cache", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-query-tool-"));
    await initializeGitRepository(root);
    try {
      await write(root, "src/Composer.ts", "export const Composer = 'comment input';\n");
      clearRepositoryIndexCache();
      const handler = repositoryContextQueryTool.createHandler({ cwd: root });
      const input = { query: { text: "comment input", symbols: ["Composer"] } };
      const first = await handler(input);
      const afterFirst = repositoryIndexCacheStats();
      const second = await handler(input);
      const afterSecond = repositoryIndexCacheStats();

      expect(second.snapshot).toEqual(first.snapshot);
      expect(afterFirst.builds).toBe(1);
      expect(afterSecond.hits).toBeGreaterThan(afterFirst.hits);
      expect(matchesJsonSchema(repositoryContextQueryOutputJsonSchema, second)).toBe(true);
      expect(second.files.map((file) => file.path)).toContain("src/Composer.ts");
      expect(matchesJsonSchema(repositoryContextQueryOutputJsonSchema, {
        ...second,
        snapshot: { ...second.snapshot, unexpected: true }
      })).toBe(false);
      expect(matchesJsonSchema(repositoryContextQueryOutputJsonSchema, {
        ...second,
        coverage: { ...second.coverage, indexed_files: "1" }
      })).toBe(false);
      expect(matchesJsonSchema(repositoryContextQueryOutputJsonSchema, {
        ...second,
        files: second.files.map((file, index) => index === 0
          ? { ...file, unexpected: true }
          : file)
      })).toBe(false);
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies platform-bound repository excludes that the model cannot override", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-query-tool-policy-"));
    await initializeGitRepository(root);
    try {
      await write(root, "generated/Private.ts", "export const Private = 'hidden';\n");
      await write(root, "src/Public.ts", "export const Public = 'visible';\n");
      clearRepositoryIndexCache();
      const handler = repositoryContextQueryTool.createHandler({
        cwd: root,
        configuration: { exclude_globs: ["generated/**"] }
      });

      const result = await handler({ query: { text: "Private Public" } });

      expect(result.coverage.policy_excluded_files).toBe(1);
      expect(result.files.map((file) => file.path)).toEqual(["src/Public.ts"]);
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates direct handler input with UTF-8 byte and config invariants", async () => {
    const handler = repositoryContextQueryTool.createHandler({ cwd: process.cwd() });
    const multibyteText = "🧠".repeat(
      Math.floor(REPOSITORY_CONTEXT_INPUT_LIMITS.task_text_bytes / 4) + 1
    );

    expect(matchesJsonSchema(repositoryContextQueryInputJsonSchema, {
      query: { text: multibyteText }
    })).toBe(true);
    await expect(handler({ query: { text: multibyteText } }))
      .rejects.toThrow("UTF-8 bytes");
    await expect(handler({
      query: { text: "valid" },
      config: { max_related_files: 1, max_seed_files: 2 }
    })).rejects.toThrow("max_seed_files");
    await expect(handler({
      query: { text: "valid", unexpected: true }
    } as never)).rejects.toThrow();
  });

  it("propagates the dependency AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("tool query cancelled"));
    const handler = repositoryContextQueryTool.createHandler({
      cwd: process.cwd(),
      signal: controller.signal
    });
    await expect(handler({ query: { text: "cancelled" } }))
      .rejects.toThrow("tool query cancelled");
  });
});
