import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Ajv, type AnySchema, type ErrorObject } from "ajv/dist/ajv.js";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

type AgentConfig = {
  id: string;
  instructions_file: string;
  output_schema: string;
};

type WorkflowGraph = {
  nodes: Array<{ id: string; agent?: string }>;
  edges: Array<{ from: string; to: string }>;
};

const yamlRoots = ["agents", "workflows", "config"];
const jsonSchemaRoots = ["agents", "workflows"];

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(roots: string[], extensions: string[]): Promise<string[]> {
  const files: string[] = [];

  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(path, entry.name);

        if (entry.isDirectory()) {
          await visit(entryPath);
          return;
        }

        if (
          entry.isFile() &&
          extensions.some((extension) => entry.name.endsWith(extension))
        ) {
          files.push(entryPath);
        }
      })
    );
  }

  for (const root of roots) {
    if (await pathExists(root)) {
      await visit(root);
    }
  }

  return files.sort();
}

async function parseYamlFile(path: string): Promise<unknown> {
  return YAML.parse(await readFile(path, "utf8"));
}

async function parseJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`)
    .join(", ");
}

function createSchemaAjv(): Ajv {
  return new Ajv({ allErrors: true, strict: true });
}

function assertLineFieldsUseIntegers(
  schema: unknown,
  path = "#"
): void {
  if (schema === null || typeof schema !== "object") {
    return;
  }

  if (Array.isArray(schema)) {
    schema.forEach((item, index) =>
      assertLineFieldsUseIntegers(item, `${path}[${index}]`)
    );
    return;
  }

  const objectSchema = schema as Record<string, unknown>;
  const properties = objectSchema.properties;

  if (
    properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    for (const [propertyName, propertySchema] of Object.entries(
      properties as Record<string, unknown>
    )) {
      if (propertyName.includes("line")) {
        expect(propertySchema, `${path}/properties/${propertyName}`).toEqual(
          expect.objectContaining({ type: "integer", minimum: 1 })
        );
      }
    }
  }

  for (const [key, value] of Object.entries(objectSchema)) {
    assertLineFieldsUseIntegers(value, `${path}/${key}`);
  }
}

describe("config definition files", () => {
  it("parses every YAML file under agents, workflows, and config", async () => {
    const files = await listFiles(yamlRoots, [".yaml", ".yml"]);

    expect(files).toEqual(
      expect.arrayContaining([
        "agents/acceptance-reviewer/agent.yaml",
        "agents/code-reviewer/agent.yaml",
        "agents/review-planner/agent.yaml",
        "workflows/code-review/graph.yaml",
        "workflows/code-review/workflow.yaml"
      ])
    );

    for (const file of files) {
      await expect(parseYamlFile(file), file).resolves.toBeDefined();
    }
  });

  it("parses and validates every JSON Schema under agents and workflows", async () => {
    const files = await listFiles(jsonSchemaRoots, [".schema.json"]);
    const ajv = createSchemaAjv();

    expect(files).toEqual(
      expect.arrayContaining([
        "agents/acceptance-reviewer/output.schema.json",
        "agents/code-reviewer/output.schema.json",
        "agents/review-planner/output.schema.json",
        "workflows/code-review/input.schema.json",
        "workflows/code-review/output.schema.json"
      ])
    );

    for (const file of files) {
      const schema = await parseJsonFile(file);
      const isValidSchema = ajv.validateSchema(schema as AnySchema);

      expect(
        isValidSchema,
        `${file}: ${formatAjvErrors(ajv.errors)}`
      ).toBe(true);
      assertLineFieldsUseIntegers(schema, file);
    }
  });

  it("keeps each agent YAML wired to existing instructions and JSON Schema files", async () => {
    const agentFiles = await listFiles(["agents"], ["agent.yaml"]);
    const ajv = createSchemaAjv();

    expect(agentFiles).toEqual([
      "agents/acceptance-reviewer/agent.yaml",
      "agents/code-reviewer/agent.yaml",
      "agents/review-planner/agent.yaml"
    ]);

    for (const file of agentFiles) {
      const config = (await parseYamlFile(file)) as AgentConfig;
      const agentDir = file.replace(/\/agent\.yaml$/, "");
      const instructionsPath = join(agentDir, config.instructions_file);
      const schemaPath = join(agentDir, config.output_schema);
      const schema = await parseJsonFile(schemaPath);

      expect(config.id, file).toBe(relative("agents", agentDir));
      await expect(access(instructionsPath), instructionsPath).resolves.toBe(
        undefined
      );
      expect(
        ajv.validateSchema(schema as AnySchema),
        `${schemaPath}: ${formatAjvErrors(ajv.errors)}`
      ).toBe(true);
    }
  });

  it("keeps code review schemas compatible with strict draft-07 consumers", async () => {
    const files = [
      "agents/code-reviewer/output.schema.json",
      "workflows/code-review/output.schema.json"
    ];

    for (const file of files) {
      const ajv = new Ajv({ allErrors: true, strict: true });
      const schema = await parseJsonFile(file);
      const isValidSchema = ajv.validateSchema(schema as AnySchema);

      expect(
        isValidSchema,
        `${file}: ${formatAjvErrors(ajv.errors)}`
      ).toBe(true);
    }
  });

  it("accepts fork metadata in code review workflow input head repository", async () => {
    const ajv = createSchemaAjv();
    const schema = await parseJsonFile("workflows/code-review/input.schema.json");
    const validate = ajv.compile(schema as AnySchema);

    const input = {
      target: "github_pr",
      owner: "octo-org",
      repo: "hello-world",
      pull_number: 42,
      base_ref: "main",
      base_repository: {
        owner: "octo-org",
        name: "hello-world",
        full_name: "octo-org/hello-world"
      },
      head_repository: {
        owner: "contributor",
        name: "hello-world",
        full_name: "contributor/hello-world",
        fork: true
      },
      references: {
        base_sha: "base-sha",
        head_sha: "head-sha"
      }
    };

    expect(validate(input), formatAjvErrors(validate.errors)).toBe(true);
  });

  it("references existing agents from the code review workflow graph", async () => {
    const graph = (await parseYamlFile(
      "workflows/code-review/graph.yaml"
    )) as WorkflowGraph;

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "review-planner",
      "code-reviewer",
      "acceptance-reviewer"
    ]);
    expect(graph.edges).toEqual([
      { from: "review-planner", to: "code-reviewer" },
      { from: "code-reviewer", to: "acceptance-reviewer" }
    ]);

    for (const node of graph.nodes) {
      expect(node.agent, node.id).toBeDefined();
      await expect(access(join("agents", node.agent ?? ""))).resolves.toBe(
        undefined
      );
    }
  });
});
