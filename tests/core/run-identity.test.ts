import { describe, expect, it } from "vitest";
import { createRunIdentity, slugTimestamp } from "../../src/core/run-identity.js";
import type { Invocation } from "../../src/core/types.js";

const fixedDate = new Date("2026-06-18T15:04:05.000Z");

const invocation: Invocation = {
  target: "github_pr",
  owner: "Octo Org",
  repo: "Hello/World",
  pull_number: 123,
  base_ref: "main",
  base_repository: {
    owner: "Octo Org",
    name: "Hello/World",
    full_name: "Octo Org/Hello/World"
  },
  head_repository: {
    owner: "Contributor",
    name: "Hello World",
    full_name: "Contributor/Hello World",
    fork: true
  },
  references: {
    base_sha: "abc123",
    head_sha: "def456"
  }
};

describe("run identity", () => {
  it("formats timestamps as compact UTC slugs", () => {
    expect(slugTimestamp(fixedDate)).toBe("20260618t150405z");
  });

  it("creates a run_id from timestamp, derived invocation slug, and attempt", () => {
    const identity = createRunIdentity(invocation, 1, fixedDate);

    expect(identity).toEqual({
      run_id: "20260618t150405z-octo-org-hello-world-pr-123-a1",
      target: "github_pr",
      started_at: fixedDate.toISOString()
    });
    expect(identity.run_id).toMatch(/^[a-z0-9._-]+$/);
  });

  it("creates stable run identity for jira_task invocations", () => {
    const identity = createRunIdentity(
      {
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
      },
      1,
      fixedDate
    );

    expect(identity.run_id).toBe(
      "20260618t150405z-github-swinggo-dev-swg-front-nuxt-jira-abc-123-a1"
    );
    expect(identity.target).toBe("jira_task");
    expect(identity.started_at).toBe(fixedDate.toISOString());
  });

  it("uses invocation_id when present and sanitizes provider-derived text", () => {
    const unsafeInvocation = {
      ...invocation,
      invocation_id: "gh/../Repo Name/ユニコード/$(touch pwned);!"
    };

    const identity = createRunIdentity(unsafeInvocation, 1, fixedDate);

    expect(identity.run_id).toBe(
      "20260618t150405z-gh-repo-name-touch-pwned-a1"
    );
    expect(identity.run_id).toMatch(/^[a-z0-9._-]+$/);
    expect(identity.run_id).not.toMatch(/[A-Z]/);
    expect(identity.run_id).not.toContain("/");
    expect(identity.run_id).not.toContain("..");
    expect(identity.run_id).not.toContain(" ");
    expect(identity.run_id).not.toContain("ユニコード");
    expect(identity.run_id).not.toContain("$");
    expect(identity.run_id).not.toContain(";");
    expect(identity.run_id).not.toContain("!");
  });

  it("represents incrementing attempts as a1, a2, and later values", () => {
    expect(createRunIdentity(invocation, 1, fixedDate).run_id).toMatch(/-a1$/);
    expect(createRunIdentity(invocation, 2, fixedDate).run_id).toMatch(/-a2$/);
    expect(createRunIdentity(invocation, 12, fixedDate).run_id).toMatch(/-a12$/);
  });

  it("rejects non-positive and non-integer attempts", () => {
    for (const attempt of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createRunIdentity(invocation, attempt, fixedDate)).toThrow(
        expect.objectContaining({ code: "invalid_run_id" })
      );
    }
  });

  it("keeps the exact run_id shape and relies on attempt increments for same-second uniqueness", () => {
    const first = createRunIdentity(invocation, 1, fixedDate);
    const sameAttempt = createRunIdentity(invocation, 1, fixedDate);
    const retry = createRunIdentity(invocation, 2, fixedDate);

    expect(first.run_id).toBe(sameAttempt.run_id);
    expect(retry.run_id).toBe("20260618t150405z-octo-org-hello-world-pr-123-a2");
    expect(retry.run_id).not.toBe(first.run_id);
  });
});
