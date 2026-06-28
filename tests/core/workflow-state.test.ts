import { describe, expect, it } from "vitest";
import { repositoryConfigFromState } from "../../src/core/workflow/state.js";

describe("workflow state", () => {
  it("validates repository config from generic workflow state", () => {
    expect(
      repositoryConfigFromState({
        repository: {
          id: "repo",
          provider: "github",
          owner: "octo-org",
          name: "hello-world",
          path: "/repo",
          remote: "origin",
          skills: [".luna/skills/repository-guidance/SKILL.md"]
        }
      })
    ).toEqual({
      id: "repo",
      provider: "github",
      owner: "octo-org",
      name: "hello-world",
      path: "/repo",
      remote: "origin",
      skills: [".luna/skills/repository-guidance/SKILL.md"]
    });
  });
});
