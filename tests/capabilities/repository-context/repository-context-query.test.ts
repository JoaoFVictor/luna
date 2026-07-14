import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { queryRepositoryContext } from
  "../../../src/capabilities/repository-context/collector.js";
import {
  initializeGitRepository,
  write
} from "./related-context-test-support.js";

describe("canonical repository context query view", () => {
  it("reuses the canonical snapshot without manufacturing repository provenance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-query-"));
    await initializeGitRepository(root);
    try {
      await write(root, "src/CommentComposer.ts", [
        "export function CommentComposer() {",
        "  return 'desktop comment input arrows';",
        "}"
      ].join("\n"));
      const input = {
        root,
        task: {
          text: "remove desktop comment input arrows",
          paths: ["src/CommentComposer.ts"],
          symbols: ["CommentComposer"]
        }
      };

      const first = await queryRepositoryContext(input);
      const second = await queryRepositoryContext(input);

      expect(second).toEqual(first);
      expect(first).toMatchObject({
        kind: "luna.repository_context_query.v1",
        schema_version: "1",
        source: { kind: "query" },
        query: input.task,
        snapshot: { head_sha: expect.stringMatching(/^[0-9a-f]{40,64}$/u) }
      });
      expect(first.files.map((file) => file.path)).toContain("src/CommentComposer.ts");
      expect(first).not.toHaveProperty("repository");
      expect(first).not.toHaveProperty("base_sha");
      expect(first).not.toHaveProperty("head_sha");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors cancellation before index or scoring admission", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel query"));
    await expect(queryRepositoryContext({
      root: process.cwd(),
      task: { text: "cancelled" },
      signal: controller.signal
    })).rejects.toThrow("cancel query");
  });
});
