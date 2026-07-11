import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { createNativeStudioServices } from "../../../src/studio/server/native-services.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("native Studio service composition", () => {
  it("loads the platform once and exposes live catalogs plus canonical routing", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-native-project-");
    const configRoot = await temporaryDirectory("luna-studio-native-config-");
    await Promise.all([
      mkdir(path.join(projectRoot, "workflows")),
      mkdir(path.join(projectRoot, "agents"))
    ]);
    await writeFile(
      path.join(configRoot, "routing.yaml"),
      [
        "type: router",
        'version: "2026-06"',
        "rules:",
        "  - id: github",
        "    when:",
        '      expression: $.invocation.source = "github"',
        "    target: workflow:code-review",
        ""
      ].join("\n"),
      "utf8"
    );
    const services = await createNativeStudioServices({
      projectRoot,
      configRoot,
      app: {
        workspace: {
          strategy: "git_worktree",
          root: ".worktrees",
          preserve_on_success: false,
          preserve_on_failure: true
        },
        artifacts: { root: ".runs" }
      },
      platform: nativeLunaPlatformRegistrations
    });
    const principal = {
      id: "local-user",
      authentication: "local-session"
    } as const;

    const signal = new AbortController().signal;
    const [
      library,
      agents,
      workflows,
      adapters,
      routing,
      simulation,
      expression,
      schema,
      runs
    ] =
      await Promise.all([
        services.queries.capabilities(principal),
        services.queries.agents(principal),
        services.queries.workflows(principal),
        services.inputRouting.listInputAdapters(principal),
        services.inputRouting.routingDefinition(principal),
        services.inputRouting.simulateRouting(principal, {
          invocation: {
            version: "2026-06",
            source: "github",
            event: "pull_request"
          }
        }),
        services.expressions?.evaluateExpression(
          principal,
          { expression: "$.value + 1", fixture: { value: 1 } },
          signal
        ),
        services.schemas?.validateSchemaInstance(
          principal,
          { schema: { type: "string" }, instance: "valid" },
          signal
        ),
        services.runs?.catalog.list()
      ]);
    await services.dispose?.();

    expect(library.registrations.length).toBeGreaterThan(0);
    expect(agents).toMatchObject({ status: "complete", agents: [] });
    expect(workflows).toMatchObject({ status: "complete", workflows: [] });
    expect(adapters.adapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "github-pr-url",
          source: "github",
          preview: { enabled: false }
        })
      ])
    );
    expect(routing.rules[0]?.id).toBe("github");
    expect(simulation).toMatchObject({
      status: "matched",
      target: { type: "workflow", id: "code-review" }
    });
    expect(expression).toEqual({
      status: "evaluated",
      result: { kind: "json", value: 2 },
      diagnostics: []
    });
    expect(schema).toEqual({ status: "valid", diagnostics: [] });
    expect(runs).toMatchObject({ items: [], next_cursor: null });
  });
});
