import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RouterDefinition } from "../../../src/core/router/router-definition.js";
import {
  loadStudioRoutingDefinition,
  StudioRoutingDefinitionLoadError
} from "../../../src/studio/application/routing/router-definition-loader.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const injectedDefinition = {
  type: "router",
  version: "2026-06",
  rules: [
    {
      id: "all",
      when: { expression: "true" },
      target: "workflow:implementation"
    }
  ]
} satisfies RouterDefinition;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Studio router definition loader", () => {
  it("accepts an injected definition without reading configuration files", async () => {
    await expect(
      loadStudioRoutingDefinition({ definition: injectedDefinition })
    ).resolves.toEqual(injectedDefinition);
  });

  it("normalizes dot and repeated separators below config root", async () => {
    const configRoot = await temporaryDirectory("luna-studio-routing-");
    await mkdir(path.join(configRoot, "routing"));
    await writeFile(
      path.join(configRoot, "app.yaml"),
      [
        "workspace:",
        "  strategy: git_worktree",
        `  root: ${JSON.stringify(path.join(configRoot, "worktrees"))}`,
        "  preserve_on_success: true",
        "  preserve_on_failure: true",
        "artifacts:",
        `  root: ${JSON.stringify(path.join(configRoot, "artifacts"))}`,
        "routing:",
        "  path: ./routing//studio.yaml",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(configRoot, "routing", "studio.yaml"),
      [
        "type: router",
        'version: "2026-06"',
        "rules:",
        "  - id: all",
        "    when:",
        '      expression: "true"',
        "    target: workflow:implementation",
        ""
      ].join("\n")
    );

    await expect(
      loadStudioRoutingDefinition({ configRoot })
    ).resolves.toEqual(injectedDefinition);
  });

  it("rejects traversal in configured paths", async () => {
    const configRoot = await temporaryDirectory("luna-studio-routing-");

    await expect(
      loadStudioRoutingDefinition({
        configRoot,
        app: {
          workspace: {
            strategy: "git_worktree",
            root: path.join(configRoot, "worktrees"),
            preserve_on_success: true,
            preserve_on_failure: true
          },
          artifacts: { root: path.join(configRoot, "artifacts") },
          routing: { path: "../outside.yaml" }
        }
      })
    ).rejects.toBeInstanceOf(StudioRoutingDefinitionLoadError);

    await expect(
      loadStudioRoutingDefinition({
        configRoot,
        app: {
          workspace: {
            strategy: "git_worktree",
            root: path.join(configRoot, "worktrees"),
            preserve_on_success: true,
            preserve_on_failure: true
          },
          artifacts: { root: path.join(configRoot, "artifacts") },
          routing: { path: "./C:/outside.yaml" }
        }
      })
    ).rejects.toMatchObject({ code: "studio_routing_path_invalid" });
  });

  it("rejects a canonical path whose symlink escapes config root", async () => {
    const configRoot = await temporaryDirectory("luna-studio-routing-");
    const outsideRoot = await temporaryDirectory("luna-studio-routing-outside-");
    await writeFile(path.join(outsideRoot, "routing.yaml"), "ignored\n");
    await symlink(
      path.join(outsideRoot, "routing.yaml"),
      path.join(configRoot, "routing.yaml")
    );

    const error = await loadStudioRoutingDefinition({
      configRoot,
      app: {
        workspace: {
          strategy: "git_worktree",
          root: path.join(configRoot, "worktrees"),
          preserve_on_success: true,
          preserve_on_failure: true
        },
        artifacts: { root: path.join(configRoot, "artifacts") }
      }
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "studio_routing_path_escape" });
    expect(String(error)).not.toContain(configRoot);
    expect(String(error)).not.toContain(outsideRoot);
  });

  it("confines app.yaml itself and keeps public errors path-safe", async () => {
    const configRoot = await temporaryDirectory("luna-studio-routing-");
    const outsideRoot = await temporaryDirectory("luna-studio-routing-outside-");
    await writeFile(path.join(outsideRoot, "app.yaml"), "private: value\n");
    await symlink(
      path.join(outsideRoot, "app.yaml"),
      path.join(configRoot, "app.yaml")
    );

    const error = await loadStudioRoutingDefinition({ configRoot }).catch(
      (cause: unknown) => cause
    );

    expect(error).toMatchObject({ code: "studio_routing_path_escape" });
    expect(String(error)).not.toContain(configRoot);
    expect(String(error)).not.toContain(outsideRoot);
  });

  it("bounds invalid configured paths without echoing their content", async () => {
    const configRoot = await temporaryDirectory("luna-studio-routing-");
    const secretPath = `secret-${"x".repeat(2_000)}.yaml`;
    const error = await loadStudioRoutingDefinition({
      configRoot,
      app: {
        workspace: {
          strategy: "git_worktree",
          root: path.join(configRoot, "worktrees"),
          preserve_on_success: true,
          preserve_on_failure: true
        },
        artifacts: { root: path.join(configRoot, "artifacts") },
        routing: { path: secretPath }
      }
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "studio_routing_path_invalid" });
    expect(String(error)).not.toContain("secret-");
    expect(String(error).length).toBeLessThan(128);
    expect(error).not.toHaveProperty("cause");
  });

  it("rejects a missing file below a directory symlink that escapes config root", async () => {
    const configRoot = await temporaryDirectory("luna-studio-routing-");
    const outsideRoot = await temporaryDirectory("luna-studio-routing-outside-");
    await symlink(outsideRoot, path.join(configRoot, "linked"), "dir");

    await expect(
      loadStudioRoutingDefinition({
        configRoot,
        app: {
          workspace: {
            strategy: "git_worktree",
            root: path.join(configRoot, "worktrees"),
            preserve_on_success: true,
            preserve_on_failure: true
          },
          artifacts: { root: path.join(configRoot, "artifacts") },
          routing: { path: "linked/missing.yaml" }
        }
      })
    ).rejects.toMatchObject({ code: "studio_routing_path_escape" });
  });
});
