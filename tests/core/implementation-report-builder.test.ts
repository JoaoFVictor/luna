import { describe, expect, it } from "vitest";
import {
  buildImplementationReportJson as buildJiraImplementationReportJson,
  buildImplementationReportMarkdown as buildJiraImplementationReportMarkdown
} from "../../src/core/providers/jira/report-builder.js";
import {
  buildImplementationReportJson as buildPlaneImplementationReportJson,
  buildImplementationReportMarkdown as buildPlaneImplementationReportMarkdown
} from "../../src/core/providers/plane/report-builder.js";
import type { Invocation } from "../../src/core/router/invocation.js";
import type { ValidationResult } from "../../src/core/validation/runner.js";
import type {
  CommitChangesArtifact,
  PushBranchArtifact
} from "../../src/core/write-mode/types.js";
import type { ChangeRequestArtifact } from "../../src/core/change-request/contracts.js";
import { createObservabilitySummary } from "../../src/core/observability/summary.js";

const invocation: Invocation = {
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

const planeInvocation: Invocation = {
  version: "2026-06",
  source: "plane",
  event: "issue",
  action: "selected",
  repository: {
    provider: "github",
    owner: "octo-org",
    name: "hello-world"
  },
  subject: {
    type: "plane_issue",
    id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
    url: "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
    title: "Fix checkout validation"
  },
  payload: {
    plane: {
      instance_id: "company",
      workspace_slug: "company",
      project_id: "24f9b7",
      issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
      sequence_id: 42,
      description: "Reject invalid checkout payloads.",
      status: "Backlog",
      priority: "high",
      labels: ["bug"]
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

const changeRequest: ChangeRequestArtifact = {
  enabled: true,
  skipped: false,
  provider: "github",
  url: "https://github.com/octo-org/hello-world/pull/42"
};

const reportInput = {
  invocation,
  status: "ready_for_change_request",
  branch: "feature/abc-123-fix-checkout-validation",
  worktree: {
    path: "/tmp/luna/hello-world/run-1",
    preserved: true,
    reason: "change_request_created"
  },
  validation,
  commit,
  push,
  changeRequest,
  trustedHostLocal: true
} as const;

const planeReportInput = {
  ...reportInput,
  invocation: planeInvocation
} as const;

describe("implementation report builder", () => {
  it("builds structured JSON with Jira, workspace, validation, and release action status", () => {
    expect(buildJiraImplementationReportJson(reportInput)).toEqual({
      task: {
        provider: "jira",
        key: "ABC-123",
        id: "ABC-123",
        url: "https://company.atlassian.net/browse/ABC-123",
        title: "Fix checkout validation",
        status: "To Do"
      },
      jira: {
        key: "ABC-123",
        url: "https://company.atlassian.net/browse/ABC-123",
        summary: "Fix checkout validation",
        status: "To Do"
      },
      repository: {
        provider: "github",
        owner: "octo-org",
        name: "hello-world"
      },
      status: "ready_for_change_request",
      branch: "feature/abc-123-fix-checkout-validation",
      worktree: {
        path: "/tmp/luna/hello-world/run-1",
        preserved: true,
        reason: "change_request_created"
      },
      validation: {
        passed: true,
        command_count: 1
      },
      commit: {
        enabled: true,
        skipped: false,
        status: "created",
        branch: "feature/abc-123-fix-checkout-validation",
        commit_sha: "2222222222222222222222222222222222222222"
      },
      push: {
        enabled: true,
        skipped: false,
        status: "pushed",
        remote: "origin",
        branch: "feature/abc-123-fix-checkout-validation"
      },
      change_request: {
        enabled: true,
        skipped: false,
        status: "opened",
        provider: "github",
        url: "https://github.com/octo-org/hello-world/pull/42"
      },
      warnings: [
        "trusted_host_local execution can access host filesystem, credentials, network, and local CLIs."
      ]
    });
  });

  it("builds Markdown with Jira key, status, branch, workspace reason, action status, and trusted-host warning", () => {
    const markdown = buildJiraImplementationReportMarkdown(reportInput);

    expect(markdown).toContain("# Luna Implementation Report");
    expect(markdown).toContain("Jira: ABC-123");
    expect(markdown).toContain("Status: ready_for_change_request");
    expect(markdown).toContain("Branch: feature/abc-123-fix-checkout-validation");
    expect(markdown).toContain("Worktree: /tmp/luna/hello-world/run-1");
    expect(markdown).toContain("Worktree state: preserved (change_request_created)");
    expect(markdown).toContain("Validation: passed");
    expect(markdown).toContain("Commit: created");
    expect(markdown).toContain("Push: pushed");
    expect(markdown).toContain("Change request: opened");
    expect(markdown).toContain(
      "trusted_host_local execution can access host filesystem, credentials, network, and local CLIs."
    );
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("includes execution metrics when an observability summary is provided", () => {
    const summary = createObservabilitySummary({
      runId: "run-1",
      workflowId: "implementation"
    });
    summary.prompt_operations = 4;
    summary.prompt_duration_ms = 2500;
    summary.tokens.input = 200;
    summary.tokens.output = 30;
    summary.tokens.cache_read = 500;
    summary.tokens.total = 730;
    summary.cost.total = 1.25;

    const input = {
      ...reportInput,
      summary
    };
    const json = buildJiraImplementationReportJson(input);
    const markdown = buildJiraImplementationReportMarkdown(input);

    expect(json.execution).toMatchObject({
      prompt_operations: 4,
      prompt_duration_ms: 2500,
      usage_missing_count: 0,
      tokens: {
        input: 200,
        output: 30,
        cache_read: 500,
        cache_write: 0,
        total: 730
      }
    });
    expect(markdown).toContain("## Execution Summary");
    expect(markdown).toContain("Prompt operations: 4");
    expect(markdown).toContain("Cost: 1.25 provider_cost_unit");
  });

  it("builds structured JSON and Markdown for Plane issues", () => {
    expect(buildPlaneImplementationReportJson(planeReportInput)).toEqual({
      task: {
        provider: "plane",
        key: "42",
        id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
        url: "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
        title: "Fix checkout validation",
        status: "Backlog"
      },
      plane: {
        issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
        sequence_id: 42,
        workspace_slug: "company",
        project_id: "24f9b7",
        priority: "high",
        labels: ["bug"]
      },
      repository: {
        provider: "github",
        owner: "octo-org",
        name: "hello-world"
      },
      status: "ready_for_change_request",
      branch: "feature/abc-123-fix-checkout-validation",
      worktree: {
        path: "/tmp/luna/hello-world/run-1",
        preserved: true,
        reason: "change_request_created"
      },
      validation: {
        passed: true,
        command_count: 1
      },
      commit: {
        enabled: true,
        skipped: false,
        status: "created",
        branch: "feature/abc-123-fix-checkout-validation",
        commit_sha: "2222222222222222222222222222222222222222"
      },
      push: {
        enabled: true,
        skipped: false,
        status: "pushed",
        remote: "origin",
        branch: "feature/abc-123-fix-checkout-validation"
      },
      change_request: {
        enabled: true,
        skipped: false,
        status: "opened",
        provider: "github",
        url: "https://github.com/octo-org/hello-world/pull/42"
      },
      warnings: [
        "trusted_host_local execution can access host filesystem, credentials, network, and local CLIs."
      ]
    });

    const markdown = buildPlaneImplementationReportMarkdown(planeReportInput);

    expect(markdown).toContain("# Luna Implementation Report");
    expect(markdown).toContain("Task: Plane #42");
    expect(markdown).toContain("Status: ready_for_change_request");
    expect(markdown).toContain("Branch: feature/abc-123-fix-checkout-validation");
    expect(markdown).toContain("Worktree: /tmp/luna/hello-world/run-1");
    expect(markdown).toContain("Validation: passed");
    expect(markdown).toContain("Commit: created");
    expect(markdown).toContain("Push: pushed");
    expect(markdown).toContain("Change request: opened");
    expect(markdown.endsWith("\n")).toBe(true);
  });
});
