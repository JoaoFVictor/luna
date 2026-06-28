import { describe, expect, it } from "vitest";
import { createRunIdentity, slugTimestamp } from "../../src/core/invocation/run-identity.js";
import type { Invocation } from "../../src/core/router/invocation.js";

const fixedDate = new Date("2026-06-18T15:04:05.000Z");

const invocation = {
  version: "2026-06",
  source: "github",
  event: "pull_request",
  action: "selected",
  target: { type: "workflow", id: "code-review" },
  repository: { provider: "github", owner: "octo-org", name: "hello-world" },
  subject: { type: "pull_request", id: "313" }
} as const satisfies Invocation;

describe("run identity", () => {
  it("formats timestamps as compact UTC slugs", () => {
    expect(slugTimestamp(fixedDate)).toBe("20260618t150405000z");
  });

  it("creates a run identity from normalized invocation fields", () => {
    const identity = createRunIdentity(invocation, {
      attempt: 1,
      date: fixedDate,
      workflowId: "code-review",
      nonce: "one"
    });

    expect(identity).toEqual({
      run_id:
        "20260618t150405000z-code-review-github-pull-request-octo-org-hello-world-pull-request-313-a1-one",
      workflow_id: "code-review",
      attempt: 1,
      source: "github",
      event: "pull_request",
      action: "selected",
      route_target: { type: "workflow", id: "code-review" },
      subject: { type: "pull_request", id: "313" },
      started_at: "2026-06-18T15:04:05.000Z"
    });
  });

  it("includes millisecond timestamp and runtime id suffix in the run id", () => {
    const identity = createRunIdentity(invocation, {
      attempt: 1,
      date: new Date("2026-06-18T15:04:05.123Z"),
      workflowId: "code-review",
      runtimeRunId: "runtime-run-abcdef123456",
      nonce: "n9x8"
    });

    expect(identity.runtime_run_id).toBe("runtime-run-abcdef123456");
    expect(identity.run_id).toContain("20260618t150405123z");
    expect(identity.run_id).toContain("abcdef123456-n9x8");
  });

  it("rejects unsafe explicit identity parts", () => {
    const safeOptions = {
      attempt: 1,
      date: fixedDate,
      workflowId: "code-review",
      runtimeRunId: "runtime-run-abcdef123456",
      nonce: "one"
    };

    for (const options of [
      { ...safeOptions, nonce: "" },
      { ...safeOptions, nonce: "!!!" },
      { ...safeOptions, nonce: "ユニコード" },
      { ...safeOptions, nonce: "../bad" },
      { ...safeOptions, workflowId: "../code-review" },
      { ...safeOptions, runtimeRunId: "runtime-run/../abcdef123456" }
    ]) {
      expect(() => createRunIdentity(invocation, options)).toThrow(
        expect.objectContaining({ code: "invalid_run_id" })
      );
    }
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

    const identity = createRunIdentity(unsafeInvocation, {
      attempt: 1,
      date: fixedDate,
      workflowId: "Code Review",
      nonce: "nonce_one"
    });

    expect(identity.run_id).toBe(
      "20260618t150405000z-code-review-git-hub-pull-request-octo-org-repo-name-touch-pwned-pull-request-313-main-a1-nonce-one"
    );
    expect(identity.run_id).toMatch(/^[a-z0-9._-]+$/);
  });

  it("rejects non-positive and non-integer attempts", () => {
    for (const attempt of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createRunIdentity(invocation, {
          attempt,
          date: fixedDate,
          workflowId: "code-review",
          nonce: "one"
        })
      ).toThrow(expect.objectContaining({ code: "invalid_run_id" }));
    }
  });
});
