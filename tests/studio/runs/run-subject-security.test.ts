import { describe, expect, it } from "vitest";
import { InvocationSubjectSchema } from "../../../src/core/router/invocation.js";
import { RunSubjectSchema } from "../../../src/studio/contracts/runs.js";

describe("run subject URL security", () => {
  it.each([
    "https://alice:PAT@example.com/task",
    "https://example.com/task?access_token=secret",
    "https://example.com/task?api_key=secret"
  ])("rejects credential-bearing subject URL %s", (url) => {
    expect(InvocationSubjectSchema.safeParse({
      type: "task",
      id: "TASK-1",
      url
    }).success).toBe(false);
    expect(RunSubjectSchema.safeParse({ id: "TASK-1", url }).success).toBe(false);
  });

  it("accepts a credential-free HTTPS subject", () => {
    const url = "https://example.com/tasks/TASK-1?view=summary";
    expect(InvocationSubjectSchema.safeParse({
      type: "task",
      id: "TASK-1",
      url
    }).success).toBe(true);
    expect(RunSubjectSchema.safeParse({ id: "TASK-1", url }).success).toBe(true);
  });
});
