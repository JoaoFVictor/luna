import { describe, expect, it } from "vitest"

import {
  ImplementationChangeRequestViewSchema,
  ImplementationCommitViewSchema,
  ImplementationDiffViewSchema,
  ImplementationGatesViewSchema,
  ImplementationPlanViewSchema,
  ImplementationPushViewSchema,
  ImplementationValidationViewSchema,
  ImplementationWorktreeViewSchema,
} from "./implementation-schemas"
import {
  ReviewAcceptanceViewSchema,
  ReviewCoverageCheckViewSchema,
  ReviewCoveragePlanViewSchema,
  ReviewFindingsViewSchema,
  ReviewProviderPublishViewSchema,
} from "./review-schemas"

const validation = {
  passed: true,
  commands: [
    {
      cmd: "npm",
      args: ["test"],
      exit_code: 0,
      stdout: "raw stdout",
      stderr: "raw stderr",
      stdout_truncated: false,
      stderr_truncated: false,
      duration_ms: 12,
      timed_out: false,
    },
  ],
}

const worktree = {
  operation_id: "repository-workspace.capture",
  run_id: "run-1",
  workspace_id: "repo:run-1",
  path: "/home/private/worktree",
  preserved: true,
  reason: "created",
  lifecycle: "active",
  captured_at: "2026-07-11T12:00:00.000Z",
  repository_id: "repo",
  remote: "origin",
  base_ref: "main",
  base_sha: "a".repeat(40),
  branch: "feature/task",
}

const diff = {
  files: [],
  untracked_files: [],
  untracked_summaries: [],
  staged_diff: "private raw patch",
  unstaged_diff: "",
  staged_diff_truncated: false,
  unstaged_diff_truncated: false,
  max_diff_bytes: 200_000,
}

describe("specialized artifact schemas", () => {
  it("accepts representative current contracts for every specialized family", () => {
    const fixtures = [
      [
        ReviewCoveragePlanViewSchema,
        {
          summary: "ready",
          status: "ready",
          expected_review_ranges: [],
          blocked_ranges: [],
          totals: { changed_files: 0, expected_review_ranges: 0, blocked_ranges: 0 },
        },
      ],
      [
        ReviewCoverageCheckViewSchema,
        {
          summary: "complete",
          status: "complete",
          expected_review_ranges: [],
          reviewed_ranges: [],
          missing_review_ranges: [],
          blocked_ranges: [],
          totals: {
            expected_review_ranges: 0,
            reviewed_ranges: 0,
            missing_review_ranges: 0,
            blocked_ranges: 0,
          },
        },
      ],
      [
        ReviewAcceptanceViewSchema,
        {
          status: "accepted",
          summary: "accepted",
          blocking_reasons: [],
          recommended_action: "approve",
        },
      ],
      [
        ReviewProviderPublishViewSchema,
        {
          operation_id: "pull-request-review.publish",
          enabled: false,
          skipped: true,
          reason: "disabled",
        },
      ],
      [
        ReviewProviderPublishViewSchema,
        {
          operation_id: "pull-request-review.publish",
          enabled: true,
          skipped: false,
          provider: "github",
          provider_id: "github-main",
          external_id: "review-1",
          url: "https://example.test/review/1",
          event: "comment",
          inline_comments: 1,
          fallback_comments: 0,
        },
      ],
      [
        ImplementationPlanViewSchema,
        { summary: "plan", steps: ["edit"], files: ["src/a.ts"], risks: [] },
      ],
      [ImplementationValidationViewSchema, validation],
      [ImplementationDiffViewSchema, diff],
      [
        ImplementationGatesViewSchema,
        {
          status: "passed",
          attempts_exhausted: false,
          attempts: [],
          validation: { passed: true },
          final_validation: { passed: true },
          gates: [],
          result: { status: "passed" },
        },
      ],
      [ImplementationWorktreeViewSchema, worktree],
      [
        ImplementationCommitViewSchema,
        {
          enabled: true,
          skipped: false,
          branch: "feature/task",
          commit_sha: "b".repeat(40),
        },
      ],
      [
        ImplementationCommitViewSchema,
        {
          operation_id: "git.commit",
          workspace_id: "repo:run-1",
          branch: "feature/task",
          head_sha: "a".repeat(40),
          commit_sha: "b".repeat(40),
          message: "Implement task",
          paths: ["src/a.ts"],
          adopted: false,
        },
      ],
      [
        ImplementationCommitViewSchema,
        {
          operation_id: "git.commit",
          enabled: false,
          skipped: true,
          reason: "disabled",
        },
      ],
      [
        ImplementationPushViewSchema,
        {
          enabled: true,
          skipped: false,
          remote: "origin",
          branch: "feature/task",
        },
      ],
      [
        ImplementationPushViewSchema,
        {
          operation_id: "git.push_branch",
          workspace_id: "repo:run-1",
          branch: "feature/task",
          remote: "origin",
          commit_sha: "b".repeat(40),
          pushed: true,
        },
      ],
      [
        ImplementationPushViewSchema,
        {
          operation_id: "git.push_branch",
          enabled: false,
          skipped: true,
          reason: "disabled",
        },
      ],
      [
        ImplementationChangeRequestViewSchema,
        {
          operation_id: "change-request.create",
          enabled: false,
          skipped: true,
          reason: "disabled",
          adopted: false,
        },
      ],
      [
        ImplementationChangeRequestViewSchema,
        {
          operation_id: "change-request.create",
          enabled: true,
          skipped: false,
          provider: "github",
          provider_id: "github-main",
          external_id: "42",
          url: "https://example.test/pull/42",
          title: "Implement task",
          source_branch: "feature/task",
          target_branch: "main",
          adopted: false,
        },
      ],
    ] as const

    for (const [schema, value] of fixtures) {
      expect(schema.safeParse(value).success).toBe(true)
    }
  })

  it("drops raw command output, patches, and physical worktree paths from projections", () => {
    const validationProjection = ImplementationValidationViewSchema.parse(validation)
    const diffProjection = ImplementationDiffViewSchema.parse(diff)
    const worktreeProjection = ImplementationWorktreeViewSchema.parse(worktree)

    expect(JSON.stringify(validationProjection)).not.toContain("raw stdout")
    expect(JSON.stringify(validationProjection)).not.toContain("raw stderr")
    expect(JSON.stringify(diffProjection)).not.toContain("private raw patch")
    expect(JSON.stringify(worktreeProjection)).not.toContain("/home/private")
  })

  it("rejects unknown fields instead of silently presenting schema drift", () => {
    expect(
      ReviewAcceptanceViewSchema.safeParse({
        status: "accepted",
        summary: "ok",
        blocking_reasons: [],
        recommended_action: "approve",
        unexpected: true,
      }).success,
    ).toBe(false)
  })

  it.each(["/home/private.ts", "C:private.ts", "~/private.ts", "../private.ts"])(
    "rejects non-repository evidence path %s",
    (path) => {
      expect(
        ReviewFindingsViewSchema.safeParse({
          findings: [
            {
              title: "finding",
              severity: "high",
              confidence: "high",
              description: "description",
              evidence: [{ path, line_start: 1, line_end: 1 }],
              recommendation: "fix",
            },
          ],
        }).success,
      ).toBe(false)
    },
  )
})
