import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemStudioLockManager } from "../../../src/studio/adapters/filesystem/studio-lock-manager.js";
import { StudioRoutingEditorService } from "../../../src/studio/application/routing/routing-editor.js";
import { loadStudioRoutingDefinition } from "../../../src/studio/application/routing/router-definition-loader.js";

const temporaryDirectories: string[] = [];

async function fixture() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-routing-project-"));
  const configRoot = await mkdtemp(path.join(tmpdir(), "luna-routing-config-"));
  temporaryDirectories.push(projectRoot, configRoot);
  await mkdir(path.join(projectRoot, ".luna"), { recursive: true });
  await writeFile(path.join(configRoot, "routing.yaml"), [
    "type: router",
    'version: "2026-06"',
    "rules:",
    "  - id: initial",
    "    when:",
    "      expression: 'true'",
    "    target: workflow:first",
    ""
  ].join("\n"));
  const load = async () => await loadStudioRoutingDefinition({
    configRoot,
    app: {
      workspace: { strategy: "git_worktree", root: ".runs/workspaces", preserve_on_success: true, preserve_on_failure: true },
      artifacts: { root: ".runs" },
      workflow_runtime: { id: "langgraph", options: {} },
      agent_runtime: { id: "pi", options: {} }
    }
  });
  return {
    configRoot,
    service: new StudioRoutingEditorService({
      configRoot,
      load,
      locks: new FileSystemStudioLockManager({ projectRoot })
    })
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("Studio routing editor", () => {
  it("validates, saves atomically and advances the CAS revision", async () => {
    const { configRoot, service } = await fixture();
    const initial = await service.get();
    const result = await service.save({
      expected_revision: initial.revision,
      definition: {
        ...initial.definition,
        rules: [{ id: "updated", when: { expression: "true" }, target: "workflow:second" }]
      }
    });

    expect(result.status).toBe("saved");
    if (result.status !== "saved") throw new Error("Expected saved routing");
    expect(result.editor.revision).not.toBe(initial.revision);
    expect(await readFile(path.join(configRoot, "routing.yaml"), "utf8"))
      .toContain("workflow:second");
  });

  it("returns the current definition instead of overwriting a stale revision", async () => {
    const { service } = await fixture();
    const initial = await service.get();
    const first = await service.save({
      expected_revision: initial.revision,
      definition: {
        ...initial.definition,
        rules: [{ id: "winner", when: { expression: "true" }, target: "workflow:first" }]
      }
    });
    expect(first.status).toBe("saved");

    const stale = await service.save({
      expected_revision: initial.revision,
      definition: initial.definition
    });
    expect(stale).toMatchObject({
      status: "conflict",
      current: { definition: { rules: [{ id: "winner" }] } }
    });
  });
});
