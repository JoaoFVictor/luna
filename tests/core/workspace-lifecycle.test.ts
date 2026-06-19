import { describe, expect, it } from "vitest";
import { shouldPreserveWriteWorkspace } from "../../src/core/workspace-lifecycle.js";

const successfulInput = {
  commitEnabled: true,
  validationPassed: true,
  acceptanceAccepted: true,
  commitSkippedOrFailed: false,
  pushSkippedOrFailed: false,
  pullRequestSkippedOrFailed: false
};

describe("workspace lifecycle", () => {
  it("preserves the workspace when commit is disabled", () => {
    expect(
      shouldPreserveWriteWorkspace({
        ...successfulInput,
        commitEnabled: false
      })
    ).toEqual({ preserve: true, reason: "commit_disabled" });
  });

  it("preserves the workspace when validation failed", () => {
    expect(
      shouldPreserveWriteWorkspace({
        ...successfulInput,
        validationPassed: false
      })
    ).toEqual({ preserve: true, reason: "validation_failed" });
  });

  it("preserves the workspace when acceptance failed", () => {
    expect(
      shouldPreserveWriteWorkspace({
        ...successfulInput,
        acceptanceAccepted: false
      })
    ).toEqual({ preserve: true, reason: "acceptance_failed" });
  });

  it("preserves the workspace when push failed", () => {
    expect(
      shouldPreserveWriteWorkspace({
        ...successfulInput,
        pushSkippedOrFailed: true
      })
    ).toEqual({ preserve: true, reason: "push_skipped_or_failed" });
  });

  it("preserves the workspace when PR failed", () => {
    expect(
      shouldPreserveWriteWorkspace({
        ...successfulInput,
        pullRequestSkippedOrFailed: true
      })
    ).toEqual({ preserve: true, reason: "pull_request_skipped_or_failed" });
  });

  it("allows cleanup when all enabled gates succeeded", () => {
    expect(shouldPreserveWriteWorkspace(successfulInput)).toEqual({
      preserve: false,
      reason: "success_cleanup"
    });
  });

  it("allows cleanup when commit is enabled and push and PR are disabled after acceptance", () => {
    expect(
      shouldPreserveWriteWorkspace({
        ...successfulInput,
        pushSkippedOrFailed: false,
        pullRequestSkippedOrFailed: false
      })
    ).toEqual({ preserve: false, reason: "success_cleanup" });
  });
});
