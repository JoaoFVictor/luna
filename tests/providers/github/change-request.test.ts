import { describe, expect, it, vi } from "vitest";
import { createGitHubChangeRequestProviderFactory } from "../../../src/providers/github/change-request/factory.js";

const input = {
  operation_id: "change-request.create" as const,
  enabled: true,
  provider_id: "github",
  repository_path: "/repo",
  title: "Implement feature",
  source_branch: "feature/test",
  target_branch: "main"
};

describe("GitHub change-request provider", () => {
  it("creates pull requests non-interactively when description is omitted", async () => {
    const runGh = vi.fn(async () => "https://github.com/acme/repo/pull/42\n");
    const provider = createGitHubChangeRequestProviderFactory({
      runGh
    }).createProvider();

    await expect(provider.createChangeRequest(input)).resolves.toMatchObject({
      external_id: "42",
      adopted: false
    });

    expect(runGh).toHaveBeenCalledWith("/repo", [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "feature/test",
      "--title",
      "Implement feature",
      "--body",
      ""
    ]);
  });

  it("passes the workflow description as the pull request body", async () => {
    const runGh = vi.fn(async () => "https://github.com/acme/repo/pull/43\n");
    const provider = createGitHubChangeRequestProviderFactory({
      runGh
    }).createProvider();

    await provider.createChangeRequest({
      ...input,
      description: "Implementation details"
    });

    expect(runGh).toHaveBeenCalledWith(
      "/repo",
      expect.arrayContaining(["--body", "Implementation details"])
    );
  });
});
