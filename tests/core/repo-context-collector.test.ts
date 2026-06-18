import { describe, expect, it } from "vitest";
import { collectRepoContext } from "../../src/core/repo-context-collector.js";
import { gitInvocation, gitRepository } from "../fixtures/git-repo.js";

type FakeGitCall = {
  cwd: string;
  args: readonly string[];
};

const baseSha = gitInvocation.references.base_sha;
const headSha = gitInvocation.references.head_sha;

function gitOutputFor(args: readonly string[]): string {
  if (args.join(" ") === `merge-base ${baseSha} ${headSha}`) {
    return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
  }

  if (args.join(" ") === "status --short") {
    return " M local-change.ts\n?? scratch.txt\n";
  }

  if (args.join(" ") === `diff --raw ${baseSha} ${headSha}`) {
    return [
      ":100644 100644 aaaaaaa bbbbbbb M\tsrc/alpha.ts",
      ":100644 100644 aaaaaaa bbbbbbb M\tsrc/beta.ts",
      ":100644 100644 aaaaaaa bbbbbbb M\tassets/logo.png",
      ":100644 000000 aaaaaaa 0000000 D\tsrc/old.ts",
      ":100644 100644 aaaaaaa bbbbbbb R100\tsrc/name-old.ts\tsrc/name-new.ts",
      ":100644 100644 aaaaaaa bbbbbbb M\tsrc/large.ts",
      ":100644 100644 aaaaaaa bbbbbbb M\tsrc/blob.dat",
      ":160000 160000 aaaaaaa bbbbbbb M\tvendor/lib"
    ].join("\n");
  }

  if (args.join(" ") === `diff --numstat ${baseSha} ${headSha}`) {
    return [
      "3\t1\tsrc/alpha.ts",
      "4\t0\tsrc/beta.ts",
      "-\t-\tassets/logo.png",
      "0\t8\tsrc/old.ts",
      "1\t1\tsrc/name-old.ts\tsrc/name-new.ts",
      "200\t0\tsrc/large.ts",
      "2\t0\tsrc/blob.dat",
      "1\t1\tvendor/lib"
    ].join("\n");
  }

  if (args.join(" ") === `diff --name-status ${baseSha} ${headSha}`) {
    return [
      "M\tsrc/alpha.ts",
      "M\tsrc/beta.ts",
      "M\tassets/logo.png",
      "D\tsrc/old.ts",
      "R100\tsrc/name-old.ts\tsrc/name-new.ts",
      "M\tsrc/large.ts",
      "M\tsrc/blob.dat",
      "M\tvendor/lib"
    ].join("\n");
  }

  if (args.join(" ") === `diff ${baseSha} ${headSha} -- src/alpha.ts`) {
    return "diff --git a/src/alpha.ts b/src/alpha.ts\n+alpha line one\n+alpha line two\n";
  }

  if (args.join(" ") === `diff ${baseSha} ${headSha} -- src/beta.ts`) {
    return "diff --git a/src/beta.ts b/src/beta.ts\n+beta line one\n+beta line two\n";
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

  if (args.join(" ") === `show ${headSha}:src/beta.ts`) {
    return "beta\n";
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
      invocation: gitInvocation,
      repository: gitRepository,
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
      "src/beta.ts",
      "assets/logo.png",
      "src/old.ts",
      "src/name-new.ts",
      "src/large.ts",
      "src/blob.dat"
    ]);

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
        args: ["diff", baseSha, headSha, "--", "src/beta.ts"]
      },
      {
        cwd: gitRepository.path,
        args: ["diff", baseSha, headSha, "--", "src/name-new.ts"]
      },
      {
        cwd: gitRepository.path,
        args: ["diff", baseSha, headSha, "--", "src/large.ts"]
      },
      {
        cwd: gitRepository.path,
        args: ["diff", baseSha, headSha, "--", "src/blob.dat"]
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
      baseSha,
      headSha
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "diff",
      "--numstat",
      baseSha,
      headSha
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "diff",
      "--name-status",
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
  });

  it("marks raw mode 160000 entries as submodules", async () => {
    const context = await collectRepoContext({
      invocation: gitInvocation,
      repository: gitRepository,
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
      invocation: gitInvocation,
      repository: gitRepository,
      maxDiffBytes: 5,
      maxExcerptBytes: 5,
      runGit: async (_cwd, args) => {
        if (args.join(" ") === `merge-base ${baseSha} ${headSha}`) {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
        }

        if (args.join(" ") === "status --short") {
          return "";
        }

        if (args.join(" ") === `diff --raw ${baseSha} ${headSha}`) {
          return ":100644 100644 aaaaaaa bbbbbbb M\tsrc/unicode.ts\n";
        }

        if (args.join(" ") === `diff --numstat ${baseSha} ${headSha}`) {
          return "1\t0\tsrc/unicode.ts\n";
        }

        if (args.join(" ") === `diff --name-status ${baseSha} ${headSha}`) {
          return "M\tsrc/unicode.ts\n";
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
});
