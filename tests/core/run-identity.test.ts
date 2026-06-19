import { describe, expect, it } from "vitest";
import { createRunIdentity, slugTimestamp } from "../../src/core/run-identity.js";
import type { Invocation } from "../../src/core/types.js";

const fixedDate = new Date("2026-06-18T15:04:05.000Z");

const invocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  action: "selected",
  target: { type: "workflow", id: "code-review" },
  repository: { provider: "github", owner: "swinggo-dev", name: "swg-front-nuxt" },
  subject: { type: "pull_request", id: "313" }
} as const satisfies Invocation;

describe("run identity", () => {
  it("formats timestamps as compact UTC slugs", () => {
    expect(slugTimestamp(fixedDate)).toBe("20260618t150405z");
  });

  it("creates a run identity from normalized invocation fields", () => {
    const identity = createRunIdentity(invocation, 1, fixedDate);

    expect(identity).toEqual({
      run_id: "20260618t150405z-github-pull-request-swinggo-dev-swg-front-nuxt-pull-request-313-a1",
      attempt: 1,
      source: "github",
      event: "pull_request",
      action: "selected",
      route_target: { type: "workflow", id: "code-review" },
      subject: { type: "pull_request", id: "313" }
    });
    expect(identity.run_id).toMatch(/^[a-z0-9._-]+$/);
  });

  it("creates stable run identity for jira normalized invocations", () => {
    const identity = createRunIdentity(
      {
        version: "2026-06",
        source: "jira",
        event: "issue",
        action: "selected",
        target: { type: "workflow", id: "implementation" },
        repository: {
          provider: "github",
          owner: "swinggo-dev",
          name: "swg-front-nuxt"
        },
        subject: { type: "issue", id: "ABC-123" }
      },
      1,
      fixedDate
    );

    expect(identity.run_id).toBe(
      "20260618t150405z-jira-issue-swinggo-dev-swg-front-nuxt-issue-abc-123-a1"
    );
    expect(identity.route_target).toEqual({
      type: "workflow",
      id: "implementation"
    });
  });

  it("sanitizes provider-derived normalized text", () => {
    const unsafeInvocation = {
      version: "2026-06",
      source: "Git Hub",
      event: "pull/request",
      repository: {
        provider: "github",
        owner: "Octo Org/../ユニコード",
        name: "Repo Name/$(touch pwned);!"
      },
      subject: { type: "Pull Request", id: "313/../../Main" }
    } as const satisfies Invocation;

    const identity = createRunIdentity(unsafeInvocation, 1, fixedDate);

    expect(identity.run_id).toBe(
      "20260618t150405z-git-hub-pull-request-octo-org-repo-name-touch-pwned-pull-request-313-main-a1"
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
    expect(retry.run_id).toBe(
      "20260618t150405z-github-pull-request-swinggo-dev-swg-front-nuxt-pull-request-313-a2"
    );
    expect(retry.run_id).not.toBe(first.run_id);
  });
});
