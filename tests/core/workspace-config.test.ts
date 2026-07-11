import { describe, expect, it } from "vitest";
import { WorkspaceConfigSchema } from "../../src/core/config/schemas.js";

const retainedWorkspaceConfig = {
  strategy: "git_worktree",
  root: ".runs/workspaces",
  preserve_on_success: true,
  preserve_on_failure: true
} as const;

describe("workspace retention configuration", () => {
  it("accepts the explicit always-retain contract", () => {
    expect(WorkspaceConfigSchema.parse(retainedWorkspaceConfig)).toEqual(
      retainedWorkspaceConfig
    );
  });

  it.each(["preserve_on_success", "preserve_on_failure"] as const)(
    "rejects false for %s instead of treating it as an ignored cleanup request",
    (field) => {
      const result = WorkspaceConfigSchema.safeParse({
        ...retainedWorkspaceConfig,
        [field]: false
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("expected workspace retention config to be rejected");
      }
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: [field] })
      );
    }
  );
});
