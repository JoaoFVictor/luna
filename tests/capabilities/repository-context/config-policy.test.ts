import { describe, expect, it } from "vitest";
import {
  RelatedContextConfigSchema,
  RelatedContextTaskSchema,
  RelatedContextWorktreeDiffSchema
} from
  "../../../src/capabilities/repository-context/contracts.js";
import {
  REPOSITORY_CONTEXT_DEFAULTS,
  REPOSITORY_CONTEXT_INPUT_LIMITS,
  REPOSITORY_CONTEXT_LIMITS
} from "../../../src/capabilities/repository-context/config-policy.js";
import { manifest } from "../../../src/capabilities/repository-context/manifest.js";
import { WorktreeDiffJsonSchema } from
  "../../../src/capabilities/git/diff/worktree-diff-contracts.js";

describe("repository context configuration policy", () => {
  it("publishes the v2 contract under the current capability version", () => {
    expect(manifest.version).toBe("2026.07.13");
  });

  it("composes the worktree input from the Git capability's canonical JSON schema", () => {
    const inputSchema = manifest.built_ins["repository-context.related_context"].input_schema as {
      properties: { worktree_diff: { properties: { diff: unknown } } };
    };
    expect(inputSchema.properties.worktree_diff.properties.diff).toEqual(WorktreeDiffJsonSchema);
  });
  it("accepts the hard ceilings", () => {
    expect(RelatedContextConfigSchema.safeParse({
      max_related_files: REPOSITORY_CONTEXT_LIMITS.max_related_files,
      max_seed_files: REPOSITORY_CONTEXT_LIMITS.max_seed_files,
      max_excerpt_bytes: REPOSITORY_CONTEXT_LIMITS.max_excerpt_bytes
    }).success).toBe(true);
  });

  it.each([
    { max_related_files: REPOSITORY_CONTEXT_LIMITS.max_related_files + 1 },
    { max_seed_files: REPOSITORY_CONTEXT_LIMITS.max_seed_files + 1 },
    { max_excerpt_bytes: REPOSITORY_CONTEXT_LIMITS.max_excerpt_bytes + 1 },
    { max_related_files: 10, max_seed_files: 11 },
    { max_seed_files: REPOSITORY_CONTEXT_DEFAULTS.max_related_files + 1 }
  ])("rejects unsafe or inconsistent values: %o", (config) => {
    expect(RelatedContextConfigSchema.safeParse(config).success).toBe(false);
  });

  it.each([
    { text: "x".repeat(REPOSITORY_CONTEXT_INPUT_LIMITS.task_text_bytes + 1) },
    { text: "task", paths: Array(REPOSITORY_CONTEXT_INPUT_LIMITS.task_paths + 1).fill("src/a.ts") },
    { text: "task", paths: ["x".repeat(REPOSITORY_CONTEXT_INPUT_LIMITS.task_path_bytes + 1)] },
    { text: "task", symbols: Array(REPOSITORY_CONTEXT_INPUT_LIMITS.task_symbols + 1).fill("Symbol") },
    { text: "task", symbols: ["x".repeat(REPOSITORY_CONTEXT_INPUT_LIMITS.task_symbol_bytes + 1)] }
  ])("rejects task input that exceeds deterministic tokenization bounds", (task) => {
    expect(RelatedContextTaskSchema.safeParse(task).success).toBe(false);
  });

  it("rejects malformed nested worktree diff entries before seed derivation", () => {
    expect(RelatedContextWorktreeDiffSchema.safeParse({
      diff: {
        files: [1],
        untracked_files: [],
        untracked_summaries: [],
        staged_diff: "",
        unstaged_diff: "",
        staged_diff_truncated: false,
        unstaged_diff_truncated: false,
        max_diff_bytes: 1,
        status_files_omitted_count: 0,
        untracked_files_omitted_count: 0,
        untracked_summary_bytes: 0,
        max_untracked_summary_bytes: 1
      }
    }).success).toBe(false);
  });
});
