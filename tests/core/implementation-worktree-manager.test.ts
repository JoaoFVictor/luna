import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareImplementationWorktree
} from "../../src/core/implementation-worktree-manager.js";
import type {
  JiraTaskInvocation,
  RepositoryConfig
} from "../../src/core/types.js";

type GitCall = {
  cwd: string;
  args: readonly string[];
};

const repository: RepositoryConfig = {
  id: "swg-front-nuxt",
  provider: "github",
  owner: "swinggo-dev",
  name: "swg-front-nuxt",
  path: "/repos/swg-front-nuxt",
  remote: "origin"
};

const invocation: JiraTaskInvocation = {
  target: "jira_task",
  workflow: "implementation",
  jira: {
    instance_id: "company",
    issue_key: "ABC-123",
    url: "https://company.atlassian.net/browse/ABC-123",
    summary: "Fix checkout validation",
    description: "Reject invalid checkout payloads.",
    acceptance_criteria: "Invalid payloads fail validation.",
    status: "To Do",
    issue_type: "Task"
  },
  repository: {
    provider: "github",
    owner: "swinggo-dev",
    name: "swg-front-nuxt"
  }
};

async function tempRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "luna-implementation-worktrees-"));
}

describe("implementation worktree manager", () => {
  it("fetches the base ref with argv, creates a feature branch, and records workspace metadata", async () => {
    const workspaceRoot = await tempRoot();
    const runId = "20260619t120000z-jira-abc-123";
    const baseSha = "1111111111111111111111111111111111111111";
    const calls: GitCall[] = [];
    const expectedPath = path.join(workspaceRoot, repository.id, runId);

    try {
      const record = await prepareImplementationWorktree({
        invocation,
        repository,
        workspaceRoot,
        runId,
        baseRef: "main",
        runGit: async (cwd, args) => {
          calls.push({ cwd, args });

          if (args[0] === "rev-parse") {
            return `${baseSha}\n`;
          }

          if (args[0] === "branch" && args[1] === "--show-current") {
            return "feature/abc-123-fix-checkout-validation\n";
          }

          return "";
        }
      });

      expect(record).toEqual({
        run_id: runId,
        path: expectedPath,
        preserved: true,
        reason: "created",
        repository_id: repository.id,
        remote: "origin",
        base_ref: "main",
        base_sha: baseSha,
        branch: "feature/abc-123-fix-checkout-validation"
      });
      expect(calls).toEqual([
        {
          cwd: repository.path,
          args: ["check-ref-format", "--branch", "main"]
        },
        {
          cwd: repository.path,
          args: ["fetch", "origin", "main"]
        },
        {
          cwd: repository.path,
          args: ["rev-parse", "origin/main"]
        },
        {
          cwd: repository.path,
          args: [
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads/feature/abc-123-fix-checkout-validation",
            "refs/remotes/origin/feature/abc-123-fix-checkout-validation"
          ]
        },
        {
          cwd: repository.path,
          args: [
            "ls-remote",
            "--heads",
            "origin",
            "feature/abc-123-fix-checkout-validation"
          ]
        },
        {
          cwd: repository.path,
          args: [
            "worktree",
            "add",
            "-b",
            "feature/abc-123-fix-checkout-validation",
            expectedPath,
            "origin/main"
          ]
        },
        {
          cwd: expectedPath,
          args: ["branch", "--show-current"]
        }
      ]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it.each([
    {
      existingRef: "refs/heads/feature/abc-123-fix-checkout-validation",
      label: "local"
    },
    {
      existingRef: "refs/remotes/origin/feature/abc-123-fix-checkout-validation",
      label: "remote"
    }
  ])("appends -2 when the $label branch exists", async ({ existingRef }) => {
    const workspaceRoot = await tempRoot();
    const calls: GitCall[] = [];

    try {
      const record = await prepareImplementationWorktree({
        invocation,
        repository,
        workspaceRoot,
        runId: "run-a1",
        baseRef: "main",
        runGit: async (cwd, args) => {
          calls.push({ cwd, args });

          if (args[0] === "rev-parse") {
            return "1111111111111111111111111111111111111111\n";
          }

          if (args[0] === "ls-remote") {
            return "";
          }

          if (
            args[0] === "for-each-ref" &&
            args.includes("refs/heads/feature/abc-123-fix-checkout-validation")
          ) {
            return `${existingRef}\n`;
          }

          if (args[0] === "branch" && args[1] === "--show-current") {
            return "feature/abc-123-fix-checkout-validation-2\n";
          }

          return "";
        }
      });

      expect(record.branch).toBe("feature/abc-123-fix-checkout-validation-2");
      expect(calls).toContainEqual({
        cwd: repository.path,
        args: [
          "worktree",
          "add",
          "-b",
          "feature/abc-123-fix-checkout-validation-2",
          path.join(workspaceRoot, repository.id, "run-a1"),
          "origin/main"
        ]
      });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("appends -2 when the real remote branch exists without a local tracking ref", async () => {
    const workspaceRoot = await tempRoot();
    const calls: GitCall[] = [];

    try {
      const record = await prepareImplementationWorktree({
        invocation,
        repository,
        workspaceRoot,
        runId: "run-a1",
        baseRef: "main",
        runGit: async (cwd, args) => {
          calls.push({ cwd, args });

          if (args[0] === "rev-parse") {
            return "1111111111111111111111111111111111111111\n";
          }

          if (
            args[0] === "ls-remote" &&
            args[3] === "feature/abc-123-fix-checkout-validation"
          ) {
            return "2222222222222222222222222222222222222222\trefs/heads/feature/abc-123-fix-checkout-validation\n";
          }

          if (args[0] === "branch" && args[1] === "--show-current") {
            return "feature/abc-123-fix-checkout-validation-2\n";
          }

          return "";
        }
      });

      expect(record.branch).toBe("feature/abc-123-fix-checkout-validation-2");
      expect(calls).toContainEqual({
        cwd: repository.path,
        args: [
          "ls-remote",
          "--heads",
          "origin",
          "feature/abc-123-fix-checkout-validation"
        ]
      });
      expect(calls).toContainEqual({
        cwd: repository.path,
        args: [
          "ls-remote",
          "--heads",
          "origin",
          "feature/abc-123-fix-checkout-validation-2"
        ]
      });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("ASCII-normalizes and truncates the summary portion before adding a collision suffix", async () => {
    const workspaceRoot = await tempRoot();

    try {
      const record = await prepareImplementationWorktree({
        invocation: {
          ...invocation,
          jira: {
            ...invocation.jira,
            issue_key: "ABC-123",
            summary: "Corrigir validação de checkout com documentos extras"
          }
        },
        repository,
        workspaceRoot,
        runId: "run-a1",
        baseRef: "main",
        maxBranchLength: 35,
        runGit: async (_cwd, args) => {
          if (args[0] === "rev-parse") {
            return "1111111111111111111111111111111111111111\n";
          }

          if (args[0] === "ls-remote") {
            return "";
          }

          if (
            args[0] === "for-each-ref" &&
            args.includes("refs/heads/feature/abc-123-corrigir-validacao")
          ) {
            return "refs/remotes/origin/feature/abc-123-corrigir-validacao\n";
          }

          if (args[0] === "branch" && args[1] === "--show-current") {
            return "feature/abc-123-corrigir-validaca-2\n";
          }

          return "";
        }
      });

      expect(record.branch).toBe("feature/abc-123-corrigir-validaca-2");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("rejects an invalid base ref before fetch or worktree creation", async () => {
    const workspaceRoot = await tempRoot();
    const calls: GitCall[] = [];

    try {
      await expect(
        prepareImplementationWorktree({
          invocation,
          repository,
          workspaceRoot,
          runId: "run-a1",
          baseRef: "main:refs/heads/pwn",
          runGit: async (cwd, args) => {
            calls.push({ cwd, args });

            if (args[0] === "check-ref-format") {
              throw new Error("invalid branch");
            }

            return "";
          }
        })
      ).rejects.toMatchObject({ code: "invalid_base_ref" });

      expect(calls).toEqual([
        {
          cwd: repository.path,
          args: ["check-ref-format", "--branch", "main:refs/heads/pwn"]
        }
      ]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("rejects worktree paths outside the workspace root", async () => {
    const workspaceRoot = await tempRoot();

    try {
      await expect(
        prepareImplementationWorktree({
          invocation,
          repository: {
            ...repository,
            id: "../outside"
          },
          workspaceRoot,
          runId: "run-a1",
          baseRef: "main",
          runGit: async () => ""
        })
      ).rejects.toMatchObject({ code: "path_security_violation" });
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
