import { describe, expect, it } from "vitest";
import {
  buildImplementationReportJson,
  buildImplementationReportMarkdown
} from "../../src/core/implementation-report-builder.js";
import type {
  CommitChangesArtifact,
  Invocation,
  PullRequestArtifact,
  PushBranchArtifact,
  ValidationResult
} from "../../src/core/types.js";

const invocation: Invocation = {
  version: "2026-06",
  source: "jira",
  event: "issue",
  action: "selected",
  repository: {
    provider: "github",
    owner: "swinggo-dev",
    name: "swg-front-nuxt"
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

const validation: ValidationResult = {
  passed: true,
  commands: [
    {
      cmd: "npm",
      args: ["test"],
      exit_code: 0,
      stdout: "",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      duration_ms: 50,
      timed_out: false
    }
  ]
};

const commit: CommitChangesArtifact = {
  enabled: true,
  skipped: false,
  branch: "feature/abc-123-fix-checkout-validation",
  commit_sha: "2222222222222222222222222222222222222222"
};

const push: PushBranchArtifact = {
  enabled: true,
  skipped: false,
  remote: "origin",
  branch: "feature/abc-123-fix-checkout-validation"
};

const pullRequest: PullRequestArtifact = {
  enabled: true,
  skipped: false,
  provider: "github",
  url: "https://github.com/swinggo-dev/swg-front-nuxt/pull/42"
};

const reportInput = {
  invocation,
  status: "ready_for_pr",
  branch: "feature/abc-123-fix-checkout-validation",
  worktree: {
    path: "/tmp/luna/swg-front-nuxt/run-1",
    preserved: true,
    reason: "pull_request_created"
  },
  validation,
  commit,
  push,
  pullRequest,
  trustedHostLocal: true
} as const;

describe("implementation report builder", () => {
  it("builds structured JSON with Jira, workspace, validation, and release action status", () => {
    expect(buildImplementationReportJson(reportInput)).toEqual({
      jira: {
        key: "ABC-123",
        url: "https://company.atlassian.net/browse/ABC-123",
        summary: "Fix checkout validation",
        status: "To Do"
      },
      repository: {
        provider: "github",
        owner: "swinggo-dev",
        name: "swg-front-nuxt"
      },
      status: "ready_for_pr",
      branch: "feature/abc-123-fix-checkout-validation",
      worktree: {
        path: "/tmp/luna/swg-front-nuxt/run-1",
        preserved: true,
        reason: "pull_request_created"
      },
      validation: {
        passed: true,
        command_count: 1
      },
      commit: {
        enabled: true,
        skipped: false,
        status: "created",
        reason: undefined,
        branch: "feature/abc-123-fix-checkout-validation",
        commit_sha: "2222222222222222222222222222222222222222"
      },
      push: {
        enabled: true,
        skipped: false,
        status: "pushed",
        reason: undefined,
        remote: "origin",
        branch: "feature/abc-123-fix-checkout-validation"
      },
      pull_request: {
        enabled: true,
        skipped: false,
        status: "opened",
        reason: undefined,
        provider: "github",
        url: "https://github.com/swinggo-dev/swg-front-nuxt/pull/42"
      },
      warnings: [
        "trusted_host_local execution can access host filesystem, credentials, network, and local CLIs."
      ]
    });
  });

  it("builds Markdown with Jira key, status, branch, workspace reason, action status, and trusted-host warning", () => {
    const markdown = buildImplementationReportMarkdown(reportInput);

    expect(markdown).toContain("# Luna Implementation Report");
    expect(markdown).toContain("Jira: ABC-123");
    expect(markdown).toContain("Status: ready_for_pr");
    expect(markdown).toContain("Branch: feature/abc-123-fix-checkout-validation");
    expect(markdown).toContain("Worktree: /tmp/luna/swg-front-nuxt/run-1");
    expect(markdown).toContain("Worktree state: preserved (pull_request_created)");
    expect(markdown).toContain("Validation: passed");
    expect(markdown).toContain("Commit: created");
    expect(markdown).toContain("Push: pushed");
    expect(markdown).toContain("Pull request: opened");
    expect(markdown).toContain(
      "trusted_host_local execution can access host filesystem, credentials, network, and local CLIs."
    );
    expect(markdown.endsWith("\n")).toBe(true);
  });
});
