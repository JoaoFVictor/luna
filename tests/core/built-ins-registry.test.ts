import { describe, expect, it, vi } from "vitest";
import {
  defaultBuiltInSteps,
  builtInStepNames,
  defaultProviderBuiltInStepRegistry,
  isBuiltInStepName,
  runBuiltInStep
} from "../../src/core/providers/built-ins.js";
import { builtInStepNames as metadataBuiltInStepNames } from "../../src/core/built-ins/catalog.js";
import {
  defineBuiltInRegistry,
  defineBuiltInStep
} from "../../src/core/built-ins/registry.js";
import type { BuiltInStepRunOptions } from "../../src/core/built-ins/types.js";

describe("built-in step registry", () => {
  it("resolves registered built-ins by name", async () => {
    const sampleBuiltIn = defineBuiltInStep({
      name: "sample_step",
      run: async () => ({ status: "ok" })
    });
    const registry = defineBuiltInRegistry([sampleBuiltIn]);

    expect(registry.names).toEqual(["sample_step"]);
    expect(registry.has("sample_step")).toBe(true);
    expect(registry.has("missing_step")).toBe(false);
    await expect(
      registry.require("sample_step").run({ state: {} } as BuiltInStepRunOptions)
    ).resolves.toEqual({ status: "ok" });
  });

  it("throws built_in_unsupported for unknown built-ins", () => {
    const registry = defineBuiltInRegistry([]);

    expect(() => registry.require("missing_step")).toThrow(
      "Unsupported built-in step: missing_step"
    );
    expect(() => registry.require("missing_step")).toThrowError(
      expect.objectContaining({ code: "built_in_unsupported" })
    );
  });

  it("throws when duplicate built-in names are registered", () => {
    const first = defineBuiltInStep({ name: "duplicate_step", run: async () => null });
    const second = defineBuiltInStep({ name: "duplicate_step", run: async () => null });

    expect(() => defineBuiltInRegistry([first, second])).toThrow(
      "Duplicate built-in step: duplicate_step"
    );
    expect(() => defineBuiltInRegistry([first, second])).toThrowError(
      expect.objectContaining({ code: "built_in_duplicate" })
    );
  });

  it("exports default built-in names from the catalog", () => {
    expect(builtInStepNames).toEqual([
      "preflight",
      "prepare_worktree",
      "collect_repo_context",
      "validate_code_review_findings",
      "final_code_review_report",
      "prepare_implementation_worktree",
      "collect_task_context",
      "run_validation_commands",
      "record_implementation_validation",
      "collect_worktree_diff",
      "record_acceptance_decision",
      "commit_changes",
      "push_branch",
      "open_change_request",
      "final_implementation_report"
    ]);
    expect(isBuiltInStepName("preflight")).toBe(true);
    expect(isBuiltInStepName("missing_step")).toBe(false);
    expect(defaultProviderBuiltInStepRegistry.names).toEqual(builtInStepNames);
    expect(Object.isFrozen(defaultBuiltInSteps)).toBe(true);
    expect(Object.isFrozen(builtInStepNames)).toBe(true);
  });

  it("keeps provider runtime names aligned with workflow validation metadata", () => {
    expect(metadataBuiltInStepNames).toEqual(builtInStepNames);
    expect(defaultProviderBuiltInStepRegistry.names).toEqual(
      metadataBuiltInStepNames
    );
  });

  it("keeps built-in metadata immutable in the default catalog", () => {
    const prepareWorktree =
      defaultProviderBuiltInStepRegistry.require("prepare_worktree");
    const finalReport = defaultProviderBuiltInStepRegistry.require(
      "final_code_review_report"
    );

    expect(prepareWorktree.metadata).toEqual({
      capturesWorkspace: true,
      locks: [{ resource: "repository", mode: "exclusive" }]
    });
    expect(finalReport.metadata).toEqual({
      deferredLifecycle: "final_report"
    });
    expect(Object.isFrozen(prepareWorktree)).toBe(true);
    expect(Object.isFrozen(prepareWorktree.metadata)).toBe(true);
    expect(Object.isFrozen(prepareWorktree.metadata?.locks)).toBe(true);
    expect(Object.isFrozen(finalReport)).toBe(true);
    expect(Object.isFrozen(finalReport.metadata)).toBe(true);
  });

  it("marks repository-sensitive built-ins with repository exclusive locks", () => {
    const lockedNames = defaultProviderBuiltInStepRegistry.names.filter((name) =>
      defaultProviderBuiltInStepRegistry.require(name).metadata?.locks?.some((lock) =>
        lock.resource === "repository" && lock.mode === "exclusive"
      ) === true
    );

    expect(lockedNames).toEqual([
      "prepare_worktree",
      "prepare_implementation_worktree",
      "commit_changes",
      "push_branch",
      "open_change_request"
    ]);

    for (const name of lockedNames) {
      expect(defaultProviderBuiltInStepRegistry.require(name).metadata?.locks).toContainEqual({
        resource: "repository",
        mode: "exclusive"
      });
    }
  });

  it("runs default built-ins through the generic entrypoint", async () => {
    const runPreflight = vi.fn(async () => ({ status: "ok" }));

    await expect(
      runBuiltInStep({
        uses: "preflight",
        state: {
          invocation: {
            version: "2026-06",
            source: "github",
            event: "pull_request",
            action: "selected",
            repository: {
              provider: "github",
              owner: "octo-org",
              name: "hello-world"
            },
            subject: { type: "pull_request", id: "42" },
            references: {
              base_ref: "main",
              base_sha: "base-sha",
              head_sha: "head-sha"
            },
            payload: {
              pull_request: { number: 42 },
              base_repository: {
                owner: "octo-org",
                name: "hello-world",
                full_name: "octo-org/hello-world"
              },
              head_repository: {
                owner: "octo-org",
                name: "hello-world",
                full_name: "octo-org/hello-world"
              }
            }
          },
          repository: {
            id: "repo",
            provider: "github",
            owner: "octo-org",
            name: "hello-world",
            path: "/repo",
            remote: "origin",
            expected_remote_urls: []
          },
          steps: {}
        },
        dependencies: { runPreflight }
      })
    ).resolves.toEqual({ status: "ok" });
  });
});
