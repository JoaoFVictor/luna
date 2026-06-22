import { describe, expect, it } from "vitest";
import { githubPullRequestContextFrom } from "../../src/core/providers/github/pull-request-context.js";
import { runPreflight } from "../../src/core/preflight/runner.js";
import type { Invocation } from "../../src/core/invocation/types.js";
import type { ImplementationConfig } from "../../src/core/write-mode/types.js";
import { gitInvocation, gitRepository } from "../fixtures/git-repo.js";

const pullRequest = githubPullRequestContextFrom(gitInvocation);
const baseRef = pullRequest.base_ref;
const baseSha = pullRequest.references.base_sha;
const headSha = pullRequest.references.head_sha;

type FakeGitCall = {
  cwd: string;
  args: readonly string[];
};

function codedError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;

  return error;
}

const jiraInvocation: Invocation = {
  version: "2026-06",
  source: "jira",
  event: "issue",
  action: "selected",
  repository: {
    provider: "github",
    owner: "octo-org",
    name: "hello-world"
  },
  subject: {
    type: "jira_issue",
    id: "ABC-123",
    url: "https://company.atlassian.net/browse/ABC-123",
    title: "Fix checkout validation"
  },
  payload: {
    jira: {
      instance_id: "company",
      description: "Reject invalid checkout payloads.",
      acceptance_criteria: "Invalid payloads fail validation.",
      status: "To Do",
      issue_type: "Task"
    }
  }
};

const implementationConfig: ImplementationConfig["implementation"] = {
  branch_pattern: "feature/{slug}",
  commit: { enabled: true },
  push: { enabled: true, remote: "origin" },
  change_request: {
    enabled: true,
    provider: "github",
    draft: true,
    base_ref: "main"
  },
  sandbox: { type: "trusted_host_local", env_allowlist: [] },
  validation: {
    repair_attempts: 1,
    max_output_bytes: 200000,
    commands: [{ cmd: "npm", args: ["test"], timeout_ms: 120000 }]
  }
};

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
            base_ref: baseRef,
            base_sha: baseSha,
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
    await expect(
      runPreflight({
        invocation: {
          ...gitInvocation,
          references: {
            base_sha: baseSha,
            head_sha: headSha
          }
        },
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
        base_sha: baseSha,
        head_sha: headSha,
        base_ref: baseRef
      }
    });
  });

  it("supports Jira issue preflight for trusted_local_write when the remote URL is expected", async () => {
    const result = await runPreflight({
      invocation: jiraInvocation,
      repository: {
        ...gitRepository,
        expected_remote_urls: ["git@github.com:octo-org/hello-world.git"]
      },
      workflow: { mode: "trusted_local_write" },
      implementation: implementationConfig,
      runGit: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:octo-org/hello-world.git\n";
        }

        return "true\n";
      },
      stat: async () => ({ isDirectory: () => true })
    });

    expect(result).toMatchObject({
      repository: {
        remote_url: "git@github.com:octo-org/hello-world.git"
      }
    });
  });

  it("supports trusted_local_write when Jira acceptance criteria is empty", async () => {
    const result = await runPreflight({
      invocation: {
        ...jiraInvocation,
        payload: {
          jira: {
            ...(jiraInvocation.payload?.jira as Record<string, unknown>),
            acceptance_criteria: ""
          }
        }
      },
      repository: {
        ...gitRepository,
        expected_remote_urls: ["git@github.com:octo-org/hello-world.git"]
      },
      workflow: { mode: "trusted_local_write" },
      implementation: implementationConfig,
      runGit: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:octo-org/hello-world.git\n";
        }

        return "true\n";
      },
      stat: async () => ({ isDirectory: () => true })
    });

    expect(result.repository.remote_url).toBe(
      "git@github.com:octo-org/hello-world.git"
    );
  });

  it("matches trusted_local_write SSH actual remote against HTTPS expected remote", async () => {
    const result = await runPreflight({
      invocation: jiraInvocation,
      repository: {
        ...gitRepository,
        expected_remote_urls: ["https://github.com/octo-org/hello-world.git"]
      },
      workflow: { mode: "trusted_local_write" },
      implementation: implementationConfig,
      runGit: async (_cwd, args) => {
        if (args[0] === "remote") {
          return "git@github.com:octo-org/hello-world.git\n";
        }

        return "true\n";
      },
      stat: async () => ({ isDirectory: () => true })
    });

    expect(result.repository.remote_url).toBe(
      "git@github.com:octo-org/hello-world.git"
    );
  });

  it("rejects unsafe trusted_local_write actual remotes with userinfo, query, or hash", async () => {
    await expect(
      runPreflight({
        invocation: jiraInvocation,
        repository: {
          ...gitRepository,
          expected_remote_urls: ["https://github.com/octo-org/hello-world.git"]
        },
        workflow: { mode: "trusted_local_write" },
        implementation: implementationConfig,
        runGit: async (_cwd, args) =>
          args[0] === "remote"
            ? "https://token@github.com/octo-org/hello-world.git?x=1#frag\n"
            : "true\n",
        stat: async () => ({ isDirectory: () => true })
      })
    ).rejects.toMatchObject({ code: "remote_url_mismatch" });
  });

  it("throws expected_remote_urls_missing for trusted_local_write without expected remote URLs", async () => {
    await expect(
      runPreflight({
        invocation: jiraInvocation,
        repository: gitRepository,
        workflow: { mode: "trusted_local_write" },
        implementation: implementationConfig,
        runGit: async (_cwd, args) =>
          args[0] === "remote"
            ? "git@github.com:octo-org/hello-world.git\n"
            : "true\n",
        stat: async () => ({ isDirectory: () => true })
      })
    ).rejects.toMatchObject({ code: "expected_remote_urls_missing" });
  });

  it("throws implementation_config_missing for trusted_local_write without implementation config", async () => {
    await expect(
      runPreflight({
        invocation: jiraInvocation,
        repository: {
          ...gitRepository,
          expected_remote_urls: ["git@github.com:octo-org/hello-world.git"]
        },
        workflow: { mode: "trusted_local_write" },
        runGit: async (_cwd, args) =>
          args[0] === "remote"
            ? "git@github.com:octo-org/hello-world.git\n"
            : "true\n",
        stat: async () => ({ isDirectory: () => true })
      })
    ).rejects.toMatchObject({ code: "implementation_config_missing" });
  });

  it("throws remote_url_mismatch when trusted_local_write remote URL is not expected", async () => {
    await expect(
      runPreflight({
        invocation: jiraInvocation,
        repository: {
          ...gitRepository,
          expected_remote_urls: ["git@github.com:octo-org/other.git"]
        },
        workflow: { mode: "trusted_local_write" },
        implementation: implementationConfig,
        runGit: async (_cwd, args) =>
          args[0] === "remote"
            ? "git@github.com:octo-org/hello-world.git\n"
            : "true\n",
        stat: async () => ({ isDirectory: () => true })
      })
    ).rejects.toMatchObject({ code: "remote_url_mismatch" });
  });

  it("throws push_requires_commit when push is enabled without commit", async () => {
    await expect(
      runPreflight({
        invocation: jiraInvocation,
        repository: {
          ...gitRepository,
          expected_remote_urls: ["git@github.com:octo-org/hello-world.git"]
        },
        workflow: { mode: "trusted_local_write" },
        implementation: {
          ...implementationConfig,
          commit: { enabled: false },
          push: { enabled: true, remote: "origin" },
          change_request: { ...implementationConfig.change_request, enabled: false }
        },
        runGit: async (_cwd, args) =>
          args[0] === "remote"
            ? "git@github.com:octo-org/hello-world.git\n"
            : "true\n",
        stat: async () => ({ isDirectory: () => true })
      })
    ).rejects.toMatchObject({ code: "push_requires_commit" });
  });

  it("throws change_request_requires_push when PR is enabled without push", async () => {
    await expect(
      runPreflight({
        invocation: jiraInvocation,
        repository: {
          ...gitRepository,
          expected_remote_urls: ["git@github.com:octo-org/hello-world.git"]
        },
        workflow: { mode: "trusted_local_write" },
        implementation: {
          ...implementationConfig,
          commit: { enabled: true },
          push: { enabled: false, remote: "origin" },
          change_request: { ...implementationConfig.change_request, enabled: true }
        },
        runGit: async (_cwd, args) =>
          args[0] === "remote"
            ? "git@github.com:octo-org/hello-world.git\n"
            : "true\n",
        stat: async () => ({ isDirectory: () => true })
      })
    ).rejects.toMatchObject({ code: "change_request_requires_push" });
  });
});
