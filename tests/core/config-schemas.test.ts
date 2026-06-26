import { describe, expect, it } from "vitest";
import {
  AppConfigSchema,
  ModelsConfigSchema,
  RepositoriesConfigSchema
} from "../../src/core/config/schemas.js";

const validModelsConfig = {
  model_profiles: {
    deep: {
      model: "openai/gpt-5",
      reasoning_effort: "high"
    }
  }
};

const plannedRepositoriesConfig = {
  repositories: [
    {
      id: "example",
      provider: "github",
      owner: "org",
      name: "repo",
      path: "/tmp/luna-example-repo",
      remote: "origin"
    }
  ]
};

const repositoryConfigWithContext = {
  repositories: [
    {
      id: "example",
      provider: "github",
      owner: "org",
      name: "repo",
      path: "/tmp/luna-example-repo",
      remote: "origin",
      context: {
        files: ["AGENTS.md", "README.md"]
      }
    }
  ]
};

const plannedAppConfig = {
  workspace: {
    strategy: "git_worktree",
    root: ".runs/workspaces",
    preserve_on_success: false,
    preserve_on_failure: true
  },
  artifacts: {
    root: ".runs"
  }
};

describe("config zod schemas", () => {
  it("accepts a ModelsConfig profile with model and reasoning_effort", () => {
    expect(ModelsConfigSchema.parse(validModelsConfig)).toEqual(validModelsConfig);
  });

  it("accepts an optional model transport strategy", () => {
    const config = {
      model_profiles: {
        deep: {
          provider: "openai-codex",
          model: "openai-codex/gpt-5.4",
          reasoning_effort: "high",
          transport: "sse"
        }
      }
    };

    expect(ModelsConfigSchema.parse(config)).toEqual(config);
  });

  it("rejects unsupported model transport strategies", () => {
    expect(() =>
      ModelsConfigSchema.parse({
        model_profiles: {
          deep: {
            model: "openai-codex/gpt-5.4",
            reasoning_effort: "high",
            transport: "http2"
          }
        }
      })
    ).toThrow();
  });

  it("accepts the planned repositories config shape", () => {
    expect(RepositoriesConfigSchema.parse(plannedRepositoriesConfig)).toEqual(
      plannedRepositoriesConfig
    );
  });

  it("accepts repository context files", () => {
    expect(RepositoriesConfigSchema.parse(repositoryConfigWithContext)).toEqual(
      repositoryConfigWithContext
    );
  });

  it("accepts the planned models config shape and rejects profiles", () => {
    expect(ModelsConfigSchema.parse(validModelsConfig)).toEqual(validModelsConfig);

    const invalidConfig = {
      profiles: {
        deep: {
          model: "openai/gpt-5",
          reasoning_effort: "high"
        }
      }
    };

    expect(() => ModelsConfigSchema.parse(invalidConfig)).toThrow();
  });

  it("accepts the planned app workspace config shape", () => {
    expect(AppConfigSchema.parse(plannedAppConfig)).toEqual(plannedAppConfig);
  });

  it("accepts an explicit agent runtime selection", () => {
    const config = {
      ...plannedAppConfig,
      agent_runtime: {
        id: "pi",
        options: {}
      }
    };

    expect(AppConfigSchema.parse(config)).toEqual(config);
  });

  it("accepts optional local lock config", () => {
    expect(
      AppConfigSchema.parse({
        workspace: {
          strategy: "git_worktree",
          root: ".workspaces",
          preserve_on_success: false,
          preserve_on_failure: true
        },
        artifacts: { root: ".runs" },
        locks: {
          root: ".luna/locks",
          timeout_ms: 120000,
          stale_after_ms: 600000
        }
      })
    ).toMatchObject({
      locks: {
        root: ".luna/locks",
        timeout_ms: 120000,
        stale_after_ms: 600000
      }
    });
  });

  it("rejects invalid lock timing", () => {
    const result = AppConfigSchema.safeParse({
      workspace: {
        strategy: "git_worktree",
        root: ".workspaces",
        preserve_on_success: false,
        preserve_on_failure: true
      },
      artifacts: { root: ".runs" },
      locks: {
        root: ".luna/locks",
        timeout_ms: 120000,
        stale_after_ms: 500
      }
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected lock config validation to fail");
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "locks.stale_after_ms must allow heartbeat >= 1000ms",
          path: ["locks", "stale_after_ms"]
        })
      ])
    );
  });

  it("rejects a ModelsConfig profile that uses env", () => {
    const invalidConfig = {
      model_profiles: {
        deep: {
          env: "OPENAI_MODEL",
          reasoning_effort: "high"
        }
      }
    };

    expect(() => ModelsConfigSchema.parse(invalidConfig)).toThrow();
  });
});
