import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit } from "../../src/core/git.js";
import type {
  GithubPrInvocation,
  RepositoryConfig
} from "../../src/core/types.js";

export const gitRepository: RepositoryConfig = {
  id: "octo-hello",
  provider: "github",
  owner: "octo-org",
  name: "hello-world",
  path: "/repos/octo/hello-world",
  remote: "origin"
};

export const gitInvocation: GithubPrInvocation = {
  target: "github_pr",
  owner: "octo-org",
  repo: "hello-world",
  pull_number: 42,
  base_ref: "main",
  base_repository: {
    owner: "octo-org",
    name: "hello-world",
    full_name: "octo-org/hello-world"
  },
  head_repository: {
    owner: "contributor",
    name: "hello-world",
    full_name: "contributor/hello-world",
    fork: true
  },
  references: {
    base_sha: "1111111111111111111111111111111111111111",
    head_sha: "2222222222222222222222222222222222222222"
  }
};

export type RealGitReviewFixture = {
  root: string;
  remotePath: string;
  sourcePath: string;
  base_sha: string;
  head_sha: string;
  repository: RepositoryConfig;
  invocation: GithubPrInvocation;
  headMismatchInvocation: GithubPrInvocation;
  cleanup: () => Promise<void>;
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return await runGit(cwd, args);
}

async function commitAll(sourcePath: string, message: string): Promise<string> {
  await git(sourcePath, ["add", "-A"]);
  await git(sourcePath, ["commit", "-m", message]);

  return (await git(sourcePath, ["rev-parse", "HEAD"])).trim();
}

export async function createRealGitReviewFixture(): Promise<RealGitReviewFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-real-git-"));
  const remotePath = path.join(root, "base-remote.git");
  const sourcePath = path.join(root, "source");

  await git(root, ["init", "--bare", remotePath]);
  await git(root, ["init", "-b", "main", sourcePath]);
  await git(sourcePath, ["config", "user.name", "Luna Test"]);
  await git(sourcePath, ["config", "user.email", "luna@example.test"]);
  await git(sourcePath, ["config", "diff.renames", "true"]);
  await git(sourcePath, ["remote", "add", "origin", remotePath]);

  await writeFile(path.join(sourcePath, "README.md"), "# hello\n", "utf8");
  await writeFile(path.join(sourcePath, "renamed-old.txt"), "rename me\n", "utf8");
  await writeFile(path.join(sourcePath, "deleted.txt"), "delete me\n", "utf8");
  await writeFile(path.join(sourcePath, "review-target.ts"), "export const answer = 41;\n", "utf8");
  const baseSha = await commitAll(sourcePath, "base");
  await git(sourcePath, ["push", "origin", "main"]);

  await git(sourcePath, ["mv", "renamed-old.txt", "renamed-new.txt"]);
  await git(sourcePath, ["rm", "deleted.txt"]);
  await writeFile(path.join(sourcePath, "review-target.ts"), "export const answer = 42;\n", "utf8");
  await writeFile(path.join(sourcePath, "binary.dat"), Buffer.from([0, 1, 2, 3, 255]));
  await writeFile(path.join(sourcePath, "large.txt"), `${"large line\n".repeat(128)}`, "utf8");
  await writeFile(
    path.join(sourcePath, "asset.bin"),
    [
      "version https://git-lfs.github.com/spec/v1",
      "oid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "size 12345",
      ""
    ].join("\n"),
    "utf8"
  );
  await git(sourcePath, ["add", "-A"]);
  await git(sourcePath, [
    "update-index",
    "--add",
    "--cacheinfo",
    "160000",
    "1234567890abcdef1234567890abcdef12345678",
    "vendor/lib"
  ]);
  await git(sourcePath, ["commit", "-m", "pr head"]);
  const headSha = (await git(sourcePath, ["rev-parse", "HEAD"])).trim();
  await git(sourcePath, ["push", "origin", "HEAD:refs/pull/123/head"]);

  const repository: RepositoryConfig = {
    ...gitRepository,
    path: sourcePath,
    remote: "origin"
  };
  const invocation: GithubPrInvocation = {
    ...gitInvocation,
    pull_number: 123,
    references: {
      base_sha: baseSha,
      head_sha: headSha
    }
  };

  return {
    root,
    remotePath,
    sourcePath,
    base_sha: baseSha,
    head_sha: headSha,
    repository,
    invocation,
    headMismatchInvocation: {
      ...invocation,
      references: {
        base_sha: baseSha,
        head_sha: baseSha
      }
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };
}
