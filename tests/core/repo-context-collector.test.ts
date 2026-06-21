import { describe, expect, it } from "vitest";
import { githubPullRequestContextFrom } from "../../src/core/providers/github/pull-request-context.js";
import { collectRepoContext } from "../../src/core/repo-context-collector.js";
import { gitInvocation, gitRepository } from "../fixtures/git-repo.js";

type FakeGitCall = {
  cwd: string;
  args: readonly string[];
};

const pullRequest = githubPullRequestContextFrom(gitInvocation);
const baseSha = pullRequest.references.base_sha;
const headSha = pullRequest.references.head_sha;
const tabbedPath = "src/tab\tpath.ts";

function nul(...fields: string[]): string {
  return `${fields.join("\0")}\0`;
}

function gitOutputFor(args: readonly string[]): string {
  if (args.join(" ") === `merge-base ${baseSha} ${headSha}`) {
    return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
  }

  if (args.join(" ") === "status --short") {
    return " M local-change.ts\n?? scratch.txt\n";
  }

  if (args.join(" ") === `diff --raw -z ${baseSha} ${headSha}`) {
    return nul(
      ":100644 100644 aaaaaaa bbbbbbb M",
      "src/alpha.ts",
      ":100644 100644 aaaaaaa bbbbbbb M",
      tabbedPath,
      ":100644 100644 aaaaaaa bbbbbbb M",
      "assets/logo.png",
      ":100644 000000 aaaaaaa 0000000 D",
      "src/old.ts",
      ":100644 100644 aaaaaaa bbbbbbb R100",
      "src/name-old.ts",
      "src/name-new.ts",
      ":100644 100644 aaaaaaa bbbbbbb M",
      "src/large.ts",
      ":100644 100644 aaaaaaa bbbbbbb M",
      "src/blob.dat",
      ":160000 160000 aaaaaaa bbbbbbb M",
      "vendor/lib"
    );
  }

  if (args.join(" ") === `diff --numstat -z ${baseSha} ${headSha}`) {
    return [
      `3\t1\tsrc/alpha.ts\0`,
      `4\t0\t${tabbedPath}\0`,
      "-\t-\tassets/logo.png\0",
      "0\t8\tsrc/old.ts\0",
      "1\t1\t\0src/name-old.ts\0src/name-new.ts\0",
      "200\t0\tsrc/large.ts\0",
      "2\t0\tsrc/blob.dat\0",
      "1\t1\tvendor/lib\0"
    ].join("");
  }

  if (args.join(" ") === `diff --name-status -z ${baseSha} ${headSha}`) {
    return nul(
      "M",
      "src/alpha.ts",
      "M",
      tabbedPath,
      "M",
      "assets/logo.png",
      "D",
      "src/old.ts",
      "R100",
      "src/name-old.ts",
      "src/name-new.ts",
      "M",
      "src/large.ts",
      "M",
      "src/blob.dat",
      "M",
      "vendor/lib"
    );
  }

  if (args.join(" ") === `diff ${baseSha} ${headSha} -- src/alpha.ts`) {
    return "diff --git a/src/alpha.ts b/src/alpha.ts\n+alpha line one\n+alpha line two\n";
  }

  if (
    args.length === 5 &&
    args[0] === "diff" &&
    args[1] === baseSha &&
    args[2] === headSha &&
    args[3] === "--" &&
    args[4] === tabbedPath
  ) {
    return "diff --git a/src/tab\tpath.ts b/src/tab\tpath.ts\n+tabbed path\n";
  }

  if (args.join(" ") === `diff ${baseSha} ${headSha} -- src/name-new.ts`) {
    return "diff --git a/src/name-old.ts b/src/name-new.ts\nrename from src/name-old.ts\nrename to src/name-new.ts\n";
  }

  if (args.join(" ") === `diff ${baseSha} ${headSha} -- src/large.ts`) {
    return "diff --git a/src/large.ts b/src/large.ts\n+" + "x".repeat(80) + "\n";
  }

  if (args.join(" ") === `diff ${baseSha} ${headSha} -- src/blob.dat`) {
    return "diff --git a/src/blob.dat b/src/blob.dat\n+lfs pointer\n";
  }

  if (args.join(" ") === `show ${headSha}:src/alpha.ts`) {
    return [
      "alpha line one is intentionally long",
      "alpha line two is intentionally long",
      "alpha line three is intentionally long"
    ].join("\n");
  }

  if (args.length === 2 && args[0] === "show" && args[1] === `${headSha}:${tabbedPath}`) {
    return "tabbed path\n";
  }

  if (args.join(" ") === `show ${headSha}:src/name-new.ts`) {
    return "renamed content\n";
  }

  if (args.join(" ") === `show ${headSha}:src/large.ts`) {
    return [
      "large-1 is intentionally long",
      "large-2 is intentionally long",
      "large-3 is intentionally long",
      "large-4 is intentionally long"
    ].join("\n");
  }

  if (args.join(" ") === `show ${headSha}:src/blob.dat`) {
    return "version https://git-lfs.github.com/spec/v1\n";
  }

  throw new Error(`Unexpected git command: ${args.join(" ")}`);
}

describe("repo context collector", () => {
  it("collects changed file metadata with pinned diffs and truncation metadata", async () => {
    const calls: FakeGitCall[] = [];

    const context = await collectRepoContext({
      repository: gitRepository,
      baseSha,
      headSha,
      maxChangedFiles: 7,
      maxDiffBytes: 150,
      maxExcerptBytes: 60,
      runGit: async (cwd, args) => {
        calls.push({ cwd, args });

        return gitOutputFor(args);
      }
    });

    expect(context.changed_files_truncated).toBe(true);
    expect(context.total_changed_files).toBe(8);
    expect(context.changed_file_limit).toBe(7);
    expect(context.files).toHaveLength(7);
    expect(context.file_excerpts_truncated).toEqual(["src/alpha.ts", "src/large.ts"]);
    expect(context.git).toEqual({
      merge_base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status_short: [" M local-change.ts", "?? scratch.txt"]
    });

    expect(context.files.map((file) => file.path)).toEqual([
      "src/alpha.ts",
      tabbedPath,
      "assets/logo.png",
      "src/old.ts",
      "src/name-new.ts",
      "src/large.ts",
      "src/blob.dat"
    ]);

    expect(context.files.find((file) => file.path === tabbedPath)).toMatchObject({
      additions: 4,
      deletions: 0
    });

    expect(context.files.find((file) => file.path === "assets/logo.png")).toMatchObject({
      status: "modified",
      binary: true,
      patch: null,
      excerpt: null
    });

    expect(context.files.find((file) => file.path === "src/old.ts")).toMatchObject({
      status: "deleted",
      additions: 0,
      deletions: 8,
      excerpt: null
    });

    expect(context.files.find((file) => file.path === "src/name-new.ts")).toMatchObject({
      status: "renamed",
      previous_path: "src/name-old.ts"
    });

    expect(context.files.find((file) => file.path === "src/large.ts")).toMatchObject({
      is_large: true,
      excerpt: {
        start_line: 1,
        end_line: 3,
        truncated: true
      }
    });

    expect(context.files.find((file) => file.path === "src/blob.dat")).toMatchObject({
      is_lfs_pointer: true
    });

    expect(context.files.reduce((bytes, file) => bytes + (file.patch?.length ?? 0), 0)).toBeLessThanOrEqual(
      150
    );
    expect(context.files.at(-1)?.patch).toBeNull();

    expect(
      calls.filter((call) => call.args[0] === "diff" && call.args[3] === "--")
    ).toEqual([
      {
        cwd: gitRepository.path,
        args: ["diff", baseSha, headSha, "--", "src/alpha.ts"]
      },
      {
        cwd: gitRepository.path,
        args: ["diff", baseSha, headSha, "--", tabbedPath]
      },
      {
        cwd: gitRepository.path,
        args: ["diff", baseSha, headSha, "--", "src/name-new.ts"]
      }
    ]);
    expect(
      calls.some(
        (call) =>
          call.args[0] === "diff" &&
          call.args.length === 3 &&
          call.args[1] === "--" &&
          call.args[2].startsWith("src/")
      )
    ).toBe(false);
    expect(calls.map((call) => call.args)).toContainEqual([
      "diff",
      "--raw",
      "-z",
      baseSha,
      headSha
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "diff",
      "--numstat",
      "-z",
      baseSha,
      headSha
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "diff",
      "--name-status",
      "-z",
      baseSha,
      headSha
    ]);
    expect(calls.map((call) => call.args)).not.toContainEqual([
      "show",
      `${headSha}:assets/logo.png`
    ]);
    expect(calls.map((call) => call.args)).not.toContainEqual([
      "show",
      `${headSha}:src/old.ts`
    ]);
    expect(calls.map((call) => call.args)).not.toContainEqual([
      "show",
      `${headSha}:vendor/lib`
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "show",
      `${headSha}:${tabbedPath}`
    ]);
  });

  it("marks raw mode 160000 entries as submodules", async () => {
    const context = await collectRepoContext({
      repository: gitRepository,
      baseSha,
      headSha,
      maxChangedFiles: 8,
      runGit: async (_cwd, args) => gitOutputFor(args)
    });

    expect(context.changed_files_truncated).toBe(false);
    expect(context.files.find((file) => file.path === "vendor/lib")).toMatchObject({
      is_submodule: true,
      patch: null,
      excerpt: null
    });
  });

  it("enforces UTF-8 byte budgets for patches and excerpts", async () => {
    const context = await collectRepoContext({
      repository: gitRepository,
      baseSha,
      headSha,
      maxDiffBytes: 5,
      maxExcerptBytes: 5,
      runGit: async (_cwd, args) => {
        if (args.join(" ") === `merge-base ${baseSha} ${headSha}`) {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
        }

        if (args.join(" ") === "status --short") {
          return "";
        }

        if (args.join(" ") === `diff --raw -z ${baseSha} ${headSha}`) {
          return nul(":100644 100644 aaaaaaa bbbbbbb M", "src/unicode.ts");
        }

        if (args.join(" ") === `diff --numstat -z ${baseSha} ${headSha}`) {
          return "1\t0\tsrc/unicode.ts\0";
        }

        if (args.join(" ") === `diff --name-status -z ${baseSha} ${headSha}`) {
          return nul("M", "src/unicode.ts");
        }

        if (args.join(" ") === `diff ${baseSha} ${headSha} -- src/unicode.ts`) {
          return "界".repeat(10);
        }

        if (args.join(" ") === `show ${headSha}:src/unicode.ts`) {
          return "界".repeat(10);
        }

        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      }
    });

    const file = context.files[0];
    const patchBytes = Buffer.byteLength(file.patch ?? "", "utf8");
    const excerptContent = file.excerpt?.content ?? "";
    const excerptBytes = Buffer.byteLength(excerptContent, "utf8");

    expect(patchBytes).toBeLessThanOrEqual(5);
    expect(excerptBytes).toBeLessThanOrEqual(5);
    expect(file.excerpt).toMatchObject({ truncated: true });
    expect(excerptContent).not.toContain("\uFFFD");
  });

  it("records patch omission reasons and partial truncation metadata", async () => {
    const context = await collectRepoContext({
      repository: gitRepository,
      baseSha,
      headSha,
      maxChangedFiles: 8,
      maxDiffBytes: 150,
      runGit: async (_cwd, args) => gitOutputFor(args)
    });

    expect(context.files.find((file) => file.path === "assets/logo.png")).toMatchObject({
      patch: null,
      patch_omitted_reason: "binary"
    });
    expect(context.files.find((file) => file.path === "src/old.ts")).toMatchObject({
      patch: null,
      patch_omitted_reason: "deleted"
    });
    expect(context.files.find((file) => file.path === "vendor/lib")).toMatchObject({
      patch: null,
      patch_omitted_reason: "submodule"
    });
    expect(context.files.find((file) => file.path === "src/name-new.ts")).toMatchObject({
      additions: 1,
      deletions: 1,
      patch_truncated: true
    });
    expect(context.files.find((file) => file.path === "src/large.ts")).toMatchObject({
      patch: null,
      patch_omitted_reason: "diff_budget_exhausted"
    });
  });
});
