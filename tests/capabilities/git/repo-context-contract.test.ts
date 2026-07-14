import { describe, expect, it } from "vitest";
import { matchesJsonSchema } from "../../../src/core/capabilities/json-schema.js";
import {
  RepoContextSchema,
  type RepoContext
} from "../../../src/capabilities/git/diff/types.js";
import { RepoContextJsonSchema } from
  "../../../src/capabilities/git/diff/repo-context-json-schema.js";
import { REPO_CONTEXT_LIMITS } from
  "../../../src/capabilities/git/diff/repo-context-policy.js";
import { collectRepoContext } from
  "../../../src/capabilities/git/diff/repo-context.js";
import { manifest as repositoryDiffManifest } from
  "../../../src/capabilities/repository-diff/manifest.js";
import { manifest as repositoryContextManifest } from
  "../../../src/capabilities/repository-context/manifest.js";
import { manifest as findingsManifest } from
  "../../../src/capabilities/findings/manifest.js";
import { manifest as reviewManifest } from
  "../../../src/capabilities/review/manifest.js";
import {
  publishAuthoringInputSchema
} from "../../../src/capabilities/pull-request-review/manifest.js";

function validRepoContext(): RepoContext {
  return {
    repository: {
      owner: "octo-org",
      name: "hello-world",
      full_name: "octo-org/hello-world"
    },
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    merge_base: "c".repeat(40),
    files: [{
      path: "src/app.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "+change\n",
      excerpt: { start_line: 1, end_line: 1, content: "change\n" }
    }],
    changed_files_truncated: false,
    total_changed_files: 1,
    changed_file_limit: 1,
    changed_files_omitted_count: 0,
    file_excerpts_truncated: [],
    git: {
      merge_base: "c".repeat(40),
      status_short: [],
      status_short_omitted_count: 0,
      status_short_truncated_count: 0
    }
  };
}

describe("public RepoContext contract", () => {
  it("publishes one strict bounded schema across capability manifests", () => {
    const context = validRepoContext();
    expect(RepoContextSchema.safeParse(context).success).toBe(true);
    expect(matchesJsonSchema(RepoContextJsonSchema, context)).toBe(true);
    expect(repositoryDiffManifest.built_ins["repository-diff.collect_context"]
      .output_schema).toBe(RepoContextJsonSchema);
    expect(repositoryContextManifest.built_ins["repository-context.related_context"]
      .input_schema.properties.repo_context).toBe(RepoContextJsonSchema);
    expect(findingsManifest.built_ins["findings.validate_evidence"]
      .input_schema.properties.repo_context).toBe(RepoContextJsonSchema);
    expect(reviewManifest.built_ins["review.coverage_plan"]
      .input_schema.properties.repo_context).toBe(RepoContextJsonSchema);
    expect(publishAuthoringInputSchema.properties.repo_context.anyOf)
      .toContain(RepoContextJsonSchema);

    expect(matchesJsonSchema(RepoContextJsonSchema, {
      ...context,
      git: { ...context.git, unexpected: true }
    })).toBe(false);
    expect(RepoContextSchema.safeParse({
      ...context,
      changed_files_omitted_count: 1
    }).success).toBe(false);
  });

  it("enforces UTF-8 byte limits beyond JSON Schema character limits", () => {
    const context = validRepoContext();
    const oversizedMultibytePath = "界".repeat(
      Math.floor(REPO_CONTEXT_LIMITS.max_path_bytes / 3) + 1
    );
    const oversized = {
      ...context,
      files: [{ ...context.files[0], path: oversizedMultibytePath }]
    };

    expect(matchesJsonSchema(RepoContextJsonSchema, oversized)).toBe(true);
    expect(RepoContextSchema.safeParse(oversized).success).toBe(false);
  });

  it("bounds status collection and reports omitted and truncated entries", async () => {
    const longStatus = ` M ${"界".repeat(REPO_CONTEXT_LIMITS.max_git_status_bytes)}`;
    const statuses = [
      longStatus,
      ...Array.from(
        { length: REPO_CONTEXT_LIMITS.max_git_status_entries },
        (_, index) => `?? file-${index}.txt`
      )
    ];
    const context = await collectRepoContext({
      repository: {
        id: "repo",
        provider: "github",
        owner: "octo-org",
        name: "hello-world",
        path: "/repo",
        remote: "origin"
      },
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      runGit: async (_cwd, args) => {
        if (args[0] === "merge-base") {
          return `${"c".repeat(40)}\n`;
        }
        if (args.join(" ") === "status --short") {
          return `${statuses.join("\n")}\n`;
        }
        return "";
      }
    });

    expect(context.git.status_short).toHaveLength(
      REPO_CONTEXT_LIMITS.max_git_status_entries
    );
    expect(context.git.status_short_omitted_count).toBe(1);
    expect(context.git.status_short_truncated_count).toBe(1);
    expect(Buffer.byteLength(context.git.status_short[0] ?? "", "utf8"))
      .toBeLessThanOrEqual(REPO_CONTEXT_LIMITS.max_git_status_bytes);
    expect(matchesJsonSchema(RepoContextJsonSchema, context)).toBe(true);
  });
});
