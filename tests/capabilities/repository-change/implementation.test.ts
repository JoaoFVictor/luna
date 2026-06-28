import { describe, expect, it } from "vitest";
import { manifest as taskContextManifest } from "../../../src/capabilities/task-context/manifest.js";
import { manifest as validationManifest } from "../../../src/capabilities/validation/manifest.js";
import { manifest as repositoryChangeManifest } from "../../../src/capabilities/repository-change/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";

describe("repository-change, validation, and task-context capabilities", () => {
  it("keeps repository-change lifecycle separate from validation, task context, and git side effects", () => {
    const registry = createCapabilityRegistry([
      repositoryChangeManifest,
      validationManifest,
      taskContextManifest
    ]);
    const repositoryChange = registry.get("repository-change");
    const validation = registry.get("validation");
    const taskContext = registry.get("task-context");

    expect(repositoryChange.built_ins?.["repository-change.prepare_commit"]).toMatchObject({
      id: "repository-change.prepare_commit"
    });
    expect(repositoryChange.built_ins?.["repository-change.record_commit_lifecycle"]).toMatchObject({
      id: "repository-change.record_commit_lifecycle"
    });
    expect(repositoryChange.built_ins?.["repository-change.prepare_push"]).toMatchObject({
      id: "repository-change.prepare_push"
    });
    expect(repositoryChange.built_ins?.["repository-change.record_push_lifecycle"]).toMatchObject({
      id: "repository-change.record_push_lifecycle"
    });
    expect(validation.built_ins?.["validation.run_commands"]).toMatchObject({
      id: "validation.run_commands",
      required_ports: ["validation.runner"]
    });
    expect(validation.ports?.["validation.runner"]).toMatchObject({
      id: "validation.runner",
      capability: "validation"
    });
    expect(taskContext.built_ins?.["task-context.collect"]).toMatchObject({
      id: "task-context.collect"
    });
    expect(taskContext.built_ins?.["task-context.final_report"]).toMatchObject({
      id: "task-context.final_report"
    });
    expect(repositoryChange.built_ins?.["repository-change.prepare_commit"]).not.toHaveProperty(
      "side_effect_policy"
    );
    expect(repositoryChange.built_ins?.["repository-change.prepare_push"]).not.toHaveProperty(
      "side_effect_policy"
    );
    expect(repositoryChange.policies).toBeUndefined();
  });
});
