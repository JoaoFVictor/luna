import { describe, expect, it, vi } from "vitest";
import { createGitHubRepositoryWorkspacePorts } from "../../src/core/providers/github/repository-workspace.js";

describe("GitHub repository workspace ports", () => {
  it("keeps release token available when lock release fails", async () => {
    const release = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("release failed"))
      .mockResolvedValueOnce(undefined);
    const ports = createGitHubRepositoryWorkspacePorts({
      lockManager: {
        acquire: vi.fn(async () => release)
      }
    });
    const lock = await ports.lockManager.acquire({
      operation_id: "repository-workspace.capture",
      run_id: "run-1",
      repository_id: "repo-1"
    });
    const releaseInput = {
      token: lock.token,
      operation_id: "repository-workspace.capture" as const,
      run_id: "run-1",
      repository_id: "repo-1",
      reason: "failure" as const
    };

    await expect(ports.lockManager.release(releaseInput)).rejects.toThrow(
      "release failed"
    );
    await expect(ports.lockManager.release(releaseInput)).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
  });
});
