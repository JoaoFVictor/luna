import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunIdentity, slugTimestamp } from "../../src/core/invocation/run-identity.js";
import type { Invocation } from "../../src/core/router/invocation.js";
import { RunLockManager } from "../../src/core/workflow/lock-manager.js";

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
    expect(identity.run_id).toMatch(/^[a-z0-9._-]+$/);
  });

  it("includes workflow id, millisecond timestamp, runtime id suffix, and nonce", () => {
    const identity = createRunIdentity(invocation, {
      attempt: 1,
      date: new Date("2026-06-18T15:04:05.123Z"),
      workflowId: "code-review",
      runtimeRunId: "runtime-run-abcdef123456",
      nonce: "n9x8"
    });

    expect(identity).toEqual({
      run_id:
        "20260618t150405123z-code-review-github-pull-request-octo-org-hello-world-pull-request-313-a1-abcdef123456-n9x8",
      runtime_run_id: "runtime-run-abcdef123456",
      workflow_id: "code-review",
      attempt: 1,
      source: "github",
      event: "pull_request",
      action: "selected",
      route_target: { type: "workflow", id: "code-review" },
      subject: { type: "pull_request", id: "313" },
      started_at: "2026-06-18T15:04:05.123Z"
    });
  });

  it("keeps run identity, artifact paths, locks, and runtime ids stable", async () => {
    const previousRunId =
      "20260618t150405123z-code-review-github-pull-request-octo-org-hello-world-pull-request-313-a1-abcdef123456-n9x8";
    const previousArtifactDirectory = path.join(
      "/tmp/luna-artifacts",
      "code-review",
      previousRunId
    );
    const repositoryLockResource = "repository:octo-org/hello-world";
    const previousLockKey = path.join(
      "/tmp/luna-locks",
      "repository_octo-org-hello-world.lock"
    );
    const previousRuntimeRunId = "runtime-run-abcdef123456";
    const locksRoot = await mkdtemp(path.join(tmpdir(), "luna-lock-compat-"));
    let releaseLock: (() => Promise<void>) | undefined;

    try {
      const runIdentity = createRunIdentity(invocation, {
        attempt: 1,
        date: new Date("2026-06-18T15:04:05.123Z"),
        workflowId: "code-review",
        runtimeRunId: previousRuntimeRunId,
        nonce: "n9x8"
      });
      const artifactDirectory = path.join(
        "/tmp/luna-artifacts",
        runIdentity.workflow_id,
        runIdentity.run_id
      );
      const lockManager = new RunLockManager({
        root: locksRoot,
        runId: runIdentity.run_id,
        runtimeRunId: runIdentity.runtime_run_id,
        timeoutMs: 1000,
        staleAfterMs: 6000
      });
      releaseLock = await lockManager.acquire(
        repositoryLockResource,
        "exclusive"
      );
      const [actualLockDirectoryName] = await readdir(locksRoot);
      const lockKey = path.join(
        "/tmp/luna-locks",
        actualLockDirectoryName
      );
      const actualLockDirectory = path.join(
        locksRoot,
        actualLockDirectoryName
      );
      const owner = JSON.parse(
        await readFile(path.join(actualLockDirectory, "owner.json"), "utf8")
      ) as { run_id?: string; runtime_run_id?: string };
      const serializedPublicEvent = JSON.parse(JSON.stringify(runIdentity)) as {
        runtime_run_id?: string;
      };

      expect(runIdentity.run_id).toBe(previousRunId);
      expect(artifactDirectory).toBe(previousArtifactDirectory);
      expect(lockKey).toBe(previousLockKey);
      expect((await stat(actualLockDirectory)).isDirectory()).toBe(true);
      expect(owner).toMatchObject({
        run_id: previousRunId,
        runtime_run_id: previousRuntimeRunId
      });
      expect(owner).not.toHaveProperty("flue_run_id");
      expect(serializedPublicEvent.runtime_run_id).toBe(previousRuntimeRunId);
    } finally {
      await releaseLock?.();
      await rm(locksRoot, { recursive: true, force: true });
    }
  });

  it("omits runtime_run_id outside runtime and still creates unique path-safe ids", () => {
    const identity = createRunIdentity(invocation, {
      attempt: 1,
      date: new Date("2026-06-18T15:04:05.123Z"),
      workflowId: "code-review",
      nonce: "local-1"
    });

    expect(identity.runtime_run_id).toBeUndefined();
    expect(identity.run_id).toContain("code-review");
    expect(identity.run_id).toContain("local-1");
    expect(identity.run_id).toMatch(/^[a-z0-9._-]+$/);
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
          owner: "octo-org",
          name: "hello-world"
        },
        subject: { type: "issue", id: "ABC-123" }
      },
      {
        attempt: 1,
        date: fixedDate,
        workflowId: "implementation",
        nonce: "one"
      }
    );

    expect(identity.run_id).toBe(
      "20260618t150405000z-implementation-jira-issue-octo-org-hello-world-issue-abc-123-a1-one"
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
    expect(
      createRunIdentity(invocation, {
        attempt: 1,
        date: fixedDate,
        workflowId: "code-review",
        nonce: "one"
      }).run_id
    ).toMatch(/-a1-one$/);
    expect(
      createRunIdentity(invocation, {
        attempt: 2,
        date: fixedDate,
        workflowId: "code-review",
        nonce: "one"
      }).run_id
    ).toMatch(/-a2-one$/);
    expect(
      createRunIdentity(invocation, {
        attempt: 12,
        date: fixedDate,
        workflowId: "code-review",
        nonce: "one"
      }).run_id
    ).toMatch(/-a12-one$/);
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

  it("keeps the exact run_id shape and relies on attempt increments for same-second uniqueness", () => {
    const first = createRunIdentity(invocation, {
      attempt: 1,
      date: fixedDate,
      workflowId: "code-review",
      nonce: "one"
    });
    const second = createRunIdentity(invocation, {
      attempt: 1,
      date: fixedDate,
      workflowId: "code-review",
      nonce: "two"
    });

    expect(first.run_id).not.toBe(second.run_id);
  });
});
