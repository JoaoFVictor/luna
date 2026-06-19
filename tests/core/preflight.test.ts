import { describe, expect, it } from "vitest";
import { runPreflight } from "../../src/core/preflight.js";
import type { GithubPrInvocation } from "../../src/core/types.js";
import { gitInvocation, gitRepository } from "../fixtures/git-repo.js";

type FakeGitCall = {
  cwd: string;
  args: readonly string[];
};

function codedError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;

  return error;
}

describe("preflight", () => {
  it("throws repository_path_missing when the repository path does not exist", async () => {
    await expect(
      runPreflight({
        invocation: gitInvocation,
        repository: gitRepository,
        runGit: async () => "",
        stat: async () => {
          throw codedError("ENOENT");
        }
      })
    ).rejects.toMatchObject({ code: "repository_path_missing" });
  });

  it("throws not_git_repository when the path is not inside a Git work tree", async () => {
    await expect(
      runPreflight({
        invocation: gitInvocation,
        repository: gitRepository,
        runGit: async (_cwd, args) => {
          if (args[0] === "rev-parse") {
            throw codedError("not_git_repository");
          }

          return "";
        },
        stat: async () => ({ isDirectory: () => true })
      })
    ).rejects.toMatchObject({ code: "not_git_repository" });
  });

  it("throws git_remote_missing when the configured remote is missing", async () => {
    await expect(
      runPreflight({
        invocation: gitInvocation,
        repository: gitRepository,
        runGit: async (_cwd, args) => {
          if (args[0] === "remote") {
            throw codedError("git_remote_missing");
          }

          return "true\n";
        },
        stat: async () => ({ isDirectory: () => true })
      })
    ).rejects.toMatchObject({ code: "git_remote_missing" });
  });

  it("throws invalid_invocation when required PR metadata is missing", async () => {
    await expect(
      runPreflight({
        invocation: {
          ...gitInvocation,
          references: {
            ...gitInvocation.references,
            head_sha: ""
          }
        },
        repository: gitRepository,
        runGit: async () => "",
        stat: async () => ({ isDirectory: () => true })
      })
    ).rejects.toMatchObject({ code: "invalid_invocation" });
  });

  it("throws invalid_invocation when base_ref is missing", async () => {
    const { base_ref: _baseRef, ...invalidInvocation } = gitInvocation;

    await expect(
      runPreflight({
        invocation: invalidInvocation as GithubPrInvocation,
        repository: gitRepository,
        runGit: async () => "",
        stat: async () => ({ isDirectory: () => true })
      })
    ).rejects.toMatchObject({ code: "invalid_invocation" });
  });

  it("returns a preflight.json shaped object for a valid repository", async () => {
    const calls: FakeGitCall[] = [];

    const result = await runPreflight({
      invocation: gitInvocation,
      repository: gitRepository,
      runGit: async (cwd, args) => {
        calls.push({ cwd, args });

        if (args[0] === "remote") {
          return "git@github.com:octo-org/hello-world.git\n";
        }

        return "true\n";
      },
      stat: async () => ({ isDirectory: () => true })
    });

    expect(calls).toEqual([
      {
        cwd: gitRepository.path,
        args: ["rev-parse", "--is-inside-work-tree"]
      },
      {
        cwd: gitRepository.path,
        args: ["remote", "get-url", gitRepository.remote]
      }
    ]);
    expect(result).toEqual({
      repository: {
        id: gitRepository.id,
        path: gitRepository.path,
        remote: gitRepository.remote,
        remote_url: "git@github.com:octo-org/hello-world.git"
      },
      expected: {
        base_sha: gitInvocation.references.base_sha,
        head_sha: gitInvocation.references.head_sha,
        base_ref: gitInvocation.base_ref
      }
    });
  });
});
