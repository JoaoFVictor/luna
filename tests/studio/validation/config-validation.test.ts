import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkflowDefinitionWithAgentDigests } from "../../../src/capabilities/agents/workflow-definition-loader.js";
import { loadWorkflowRuntimeConfig } from "../../../src/platform/native/native-run-context.js";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { NativeStudioDefinitionValidation } from "../../../src/studio/adapters/native/definition-validation.js";
import type { StudioValidationSnapshot } from "../../../src/studio/application/validation/snapshot.js";

const fixtureRoot = path.join(process.cwd(), "tests/fixtures/workflows/minimum");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function configuredFixture(
  schema: unknown,
  configFile = "workflows/minimum.yaml"
): Promise<{
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly configPath: string;
}> {
  const projectRoot = await temporaryDirectory("luna-studio-config-project-");
  const configRoot = await temporaryDirectory("luna-studio-config-root-");
  const workflowRoot = path.join(projectRoot, "workflows", "minimum");
  await mkdir(path.dirname(workflowRoot), { recursive: true });
  await cp(fixtureRoot, workflowRoot, { recursive: true });
  const workflowPath = path.join(workflowRoot, "workflow.yaml");
  const original = await readFile(workflowPath, "utf8");
  await writeFile(
    workflowPath,
    original.replace(
      "capabilities:",
      [
        "config:",
        `  file: ${configFile}`,
        "  schema: config.schema.json",
        "capabilities:"
      ].join("\n")
    ),
    "utf8"
  );
  await writeFile(
    path.join(workflowRoot, "config.schema.json"),
    `${JSON.stringify(schema)}\n`,
    "utf8"
  );
  await mkdir(path.join(configRoot, "workflows"), { recursive: true });
  return {
    projectRoot,
    configRoot,
    configPath: path.join(configRoot, "workflows", "minimum.yaml")
  };
}

function snapshotFor(
  projectRoot: string,
  configRoot: string
): StudioValidationSnapshot {
  return {
    projectRoot,
    configRoot,
    verifiedFiles: [],
    async dispose(): Promise<void> {}
  };
}

async function studioConfigFailure(
  projectRoot: string,
  configRoot: string
): Promise<unknown> {
  try {
    await new NativeStudioDefinitionValidation().validate({
      snapshot: snapshotFor(projectRoot, configRoot),
      resource: { kind: "config", id: "minimum" },
      compile: false
    });
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected Studio config validation to fail");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Studio canonical config validation", () => {
  it.each([
    "./workflows/minimum.yaml",
    "workflows//minimum.yaml"
  ])("matches runtime config path normalization for %s", async (configFile) => {
    const fixture = await configuredFixture(
      {
        type: "object",
        additionalProperties: false,
        required: ["enabled"],
        properties: { enabled: { type: "boolean" } }
      },
      configFile
    );
    await writeFile(fixture.configPath, "enabled: true\n", "utf8");
    const workflow = await loadWorkflowDefinitionWithAgentDigests(
      path.join(fixture.projectRoot, "workflows"),
      "minimum",
      {
        agentsRoot: path.join(fixture.projectRoot, "agents"),
        capabilityRegistry:
          nativeLunaPlatformRegistrations.capabilityRegistry
      }
    );

    await expect(
      loadWorkflowRuntimeConfig({
        workflow,
        configRoot: fixture.configRoot
      })
    ).resolves.toEqual({ enabled: true });
    await expect(
      new NativeStudioDefinitionValidation().validate({
        snapshot: snapshotFor(fixture.projectRoot, fixture.configRoot),
        resource: { kind: "config", id: "minimum" },
        compile: false
      })
    ).resolves.toMatchObject({ revision: expect.stringMatching(/^sha256:/) });
  });

  it.each([
    {
      label: "missing",
      content: undefined,
      code: "config_read_failed"
    },
    {
      label: "malformed",
      content: "enabled: [unterminated\n",
      code: "config_parse_failed"
    },
    {
      label: "schema-invalid",
      content: "enabled: nope\n",
      code: "config_schema_invalid"
    }
  ])("projects a safe semantic path for $label config", async ({ content, code }) => {
    const fixture = await configuredFixture({
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: { enabled: { type: "boolean" } }
    });
    if (content !== undefined) {
      await writeFile(fixture.configPath, content, "utf8");
    }

    const failure = await studioConfigFailure(
      fixture.projectRoot,
      fixture.configRoot
    );

    expect(failure).toMatchObject({ code, fieldPath: "$" });
    const publicFailure = JSON.stringify({
      code: (failure as { code: string }).code,
      fieldPath: (failure as { fieldPath: string }).fieldPath,
      message: (failure as Error).message
    });
    expect(publicFailure).not.toContain(fixture.projectRoot);
    expect(publicFailure).not.toContain(fixture.configRoot);
  });

  it.each([
    ["YAML set", "value: !!set { one: null }\n"],
    ["YAML ordered map", "value: !!omap [one: 1]\n"],
    ["cyclic alias", "value: &self\n  child: *self\n"]
  ])("matches runtime JSON semantics for %s", async (_label, content) => {
    const fixture = await configuredFixture({});
    await writeFile(fixture.configPath, content, "utf8");
    const workflow = await loadWorkflowDefinitionWithAgentDigests(
      path.join(fixture.projectRoot, "workflows"),
      "minimum",
      {
        agentsRoot: path.join(fixture.projectRoot, "agents"),
        capabilityRegistry:
          nativeLunaPlatformRegistrations.capabilityRegistry
      }
    );

    await expect(
      loadWorkflowRuntimeConfig({
        workflow,
        configRoot: fixture.configRoot
      })
    ).rejects.toMatchObject({ code: "runtime_invalid_json" });
    await expect(
      studioConfigFailure(fixture.projectRoot, fixture.configRoot)
    ).resolves.toMatchObject({
      code: "runtime_invalid_json",
      fieldPath: "$"
    });
  });
});
