import { access, readdir, readFile, stat } from "node:fs/promises";
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
  nodes: Array<{
    id: string;
    type: "agent" | "built_in" | "agent_loop";
    uses?: string;
    agent?: string;
    after?: string[];
    input?: Record<string, unknown>;
  }>;
};

const yamlRoots = ["agents", "workflows", "config"];
const jsonSchemaRoots = ["agents", "workflows"];
const legacyReferenceScanRoots = [
  "src",
  "tests",
  "agents",
  "workflows",
  "examples",
  "skills",
  "README.md",
  "AGENTS.md"
];
const intentionalLegacyReferenceFiles = new Set([
  "tests/core/invocation-helpers.test.ts",
  "tests/core/cli.test.ts"
]);

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

async function listTextFiles(roots: string[]): Promise<string[]> {
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

        if (!entry.isFile()) {
          return;
        }

        const contents = await readFile(entryPath);
        if (!contents.includes(0)) {
          files.push(entryPath);
        }
      })
    );
  }

  for (const root of roots) {
    if (!(await pathExists(root))) {
      continue;
    }

    const rootStat = await stat(root);
    if (rootStat.isFile()) {
      const contents = await readFile(root);
      if (!contents.includes(0)) {
        files.push(root);
      }
      continue;
    }

    if (rootStat.isDirectory()) {
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

function agentsWithContextInput(graph: WorkflowGraph): string[] {
  return graph.nodes
    .filter((node) => node.type === "agent" || node.type === "agent_loop")
    .filter((node) => node.input?.context === "$.steps.context")
    .map((node) => node.agent)
    .filter((agent): agent is string => agent !== undefined);
}

function collectContextAgents(graph: WorkflowGraph): string[] {
  const contextNode = graph.nodes.find(
    (node) => node.type === "built_in" && node.uses === "collect_context"
  );
  const agents = contextNode?.input?.agents;

  return Array.isArray(agents) ? agents.filter((agent): agent is string =>
    typeof agent === "string"
  ) : [];
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
  it("does not reintroduce legacy invocation target references", async () => {
    const legacyTargets = ["github" + "_pr", "jira" + "_task"];
    const bannedReferences = legacyTargets.flatMap((target) => [
      `target: "${target}"`,
      `"target": "${target}"`,
      `z.literal("${target}")`
    ]);
    bannedReferences.push(
      "Github" + "PrInvocation",
      "Jira" + "TaskInvocation",
      "Github" + "PrInvocationSchema",
      "Jira" + "TaskInvocationSchema",
      "git" + "_managed_read_only",
      "git" + "_managed_write",
      "trusted" + "_host_local_write"
    );

    const files = await listTextFiles(legacyReferenceScanRoots);
    const matches: string[] = [];

    for (const file of files) {
      if (intentionalLegacyReferenceFiles.has(file)) {
        continue;
      }

      const contents = await readFile(file, "utf8");
      for (const bannedReference of bannedReferences) {
        if (contents.includes(bannedReference)) {
          matches.push(`${file}: ${bannedReference}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });

  it("parses every YAML file under agents, workflows, and config", async () => {
    const files = await listFiles(yamlRoots, [".yaml", ".yml"]);

    expect(files).toEqual(
      expect.arrayContaining([
        "agents/change-acceptance-reviewer/agent.yaml",
        "agents/change-reviewer/agent.yaml",
        "agents/code-implementer/agent.yaml",
        "agents/example-complete-agent/agent.yaml",
        "agents/implementation-planner/agent.yaml",
        "agents/review-planner/agent.yaml",
        "config/implementation.yaml",
        "config/jira.yaml",
        "workflows/code-review/graph.yaml",
        "workflows/code-review/workflow.yaml",
        "workflows/example-complete-agent/graph.yaml",
        "workflows/example-complete-agent/workflow.yaml",
        "workflows/implementation/graph.yaml",
        "workflows/implementation/workflow.yaml"
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
        "agents/change-acceptance-reviewer/output.schema.json",
        "agents/change-reviewer/output.schema.json",
        "agents/code-implementer/output.schema.json",
        "agents/example-complete-agent/output.schema.json",
        "agents/implementation-planner/output.schema.json",
        "agents/review-planner/output.schema.json",
        "workflows/code-review/input.schema.json",
        "workflows/code-review/output.schema.json",
        "workflows/example-complete-agent/input.schema.json",
        "workflows/example-complete-agent/output.schema.json",
        "workflows/implementation/input.schema.json",
        "workflows/implementation/output.schema.json"
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
      "agents/change-acceptance-reviewer/agent.yaml",
      "agents/change-reviewer/agent.yaml",
      "agents/code-implementer/agent.yaml",
      "agents/example-complete-agent/agent.yaml",
      "agents/implementation-planner/agent.yaml",
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

  it("configures reusable skills and local tools for the code implementer", async () => {
    const config = (await parseYamlFile(
      "agents/code-implementer/agent.yaml"
    )) as {
      skills?: string[];
      tools?: string[];
    };

    expect(config.skills).toEqual([
      "../../skills/implementation-safe-git/SKILL.md"
    ]);
    expect(config.tools).toEqual([
      "repository.status",
      "repository.diff-summary"
    ]);
  });

  it("configures the shared change reviewer as a code implementer subagent", async () => {
    const config = (await parseYamlFile(
      "agents/code-implementer/agent.yaml"
    )) as { subagents?: string[] };

    expect(config.subagents).toEqual(["change-reviewer"]);
  });

  it("defines the shared change reviewer agent", async () => {
    const config = (await parseYamlFile(
      "agents/change-reviewer/agent.yaml"
    )) as {
      id?: string;
      mode?: string;
      model_profile?: string;
      instructions_file?: string;
      output_schema?: string;
    };

    expect(config).toMatchObject({
      id: "change-reviewer",
      mode: "read_only",
      model_profile: "deep",
      instructions_file: "instructions.md",
      output_schema: "output.schema.json"
    });
  });

  it("keeps code review schemas compatible with strict draft-07 consumers", async () => {
    const files = [
      "agents/change-reviewer/output.schema.json",
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

  it("keeps implementation workflow output schema aligned with the final report contract", async () => {
    const ajv = createSchemaAjv();
    const schema = await parseJsonFile("workflows/implementation/output.schema.json");
    const validate = ajv.compile(schema as AnySchema);
    const output = {
      status: "success",
      run: {
        run_id: "run-1",
        attempt: 1,
        source: "jira",
        event: "issue",
        action: "selected",
        route_target: { type: "workflow", id: "implementation" },
        subject: { type: "jira_issue", id: "ABC-123" }
      },
      workflow_id: "implementation",
      steps: {
        final_report: {}
      },
      report: {
        jira: {
          key: "ABC-123",
          url: "https://company.atlassian.net/browse/ABC-123",
          summary: "Fix checkout validation",
          status: "To Do"
        },
        repository: {
          provider: "github",
          owner: "swinggo-dev",
          name: "swg-front-nuxt"
        },
        status: "validation_failed",
        branch: "feature/abc-123-fix-checkout-validation",
        worktree: {
          path: "/tmp/luna/swg-front-nuxt/run-1",
          preserved: true,
          reason: "commit_disabled"
        },
        validation: {
          passed: false,
          command_count: 1
        },
        commit: {
          enabled: false,
          skipped: true,
          status: "disabled",
          reason: "disabled"
        },
        push: {
          enabled: false,
          skipped: true,
          status: "disabled",
          reason: "disabled"
        },
        change_request: {
          enabled: false,
          skipped: true,
          status: "disabled",
          reason: "disabled"
        },
        warnings: [
          "trusted_host_local execution can access host filesystem, credentials, network, and local CLIs."
        ]
      },
      workspace: {
        run_id: "run-1",
        path: "/tmp/luna/swg-front-nuxt/run-1",
        preserved: true,
        reason: "commit_disabled",
        repository_id: "swg-front-nuxt",
        remote: "origin",
        base_ref: "main",
        base_sha: "base-sha",
        branch: "feature/abc-123-fix-checkout-validation"
      }
    };

    expect(validate(output), formatAjvErrors(validate.errors)).toBe(true);

    expect(
      validate({
        ...output,
        report: {
          ...output.report,
          unexpected: true
        }
      }),
      "report should reject additional properties"
    ).toBe(false);

    expect(
      validate({
        ...output,
        workspace: {
          ...output.workspace,
          unexpected: true
        }
      }),
      "workspace should reject additional properties"
    ).toBe(false);
  });

  it("accepts normalized code review workflow input with pull request metadata", async () => {
    const ajv = createSchemaAjv();
    const schema = await parseJsonFile("workflows/code-review/input.schema.json");
    const validate = ajv.compile(schema as AnySchema);

    const input = {
      version: "2026-06",
      source: "github",
      event: "pull_request",
      action: "selected",
      target: {
        type: "workflow",
        id: "code-review"
      },
      repository: {
        provider: "github",
        owner: "octo-org",
        name: "hello-world"
      },
      subject: {
        type: "pull_request",
        id: "42",
        url: "https://github.com/octo-org/hello-world/pull/42"
      },
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
          owner: "contributor",
          name: "hello-world",
          full_name: "contributor/hello-world",
          fork: true
        }
      }
    };

    expect(validate(input), formatAjvErrors(validate.errors)).toBe(true);
  });

  it("references existing agents from the code review workflow graph", async () => {
    const graph = (await parseYamlFile(
      "workflows/code-review/graph.yaml"
    )) as WorkflowGraph;

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "preflight",
      "workspace",
      "repo_context",
      "context",
      "review_plan",
      "code_review",
      "validate_findings",
      "acceptance",
      "final_report"
    ]);
    expect(graph.nodes.find((node) => node.id === "code_review")?.after).toEqual([
      "review_plan"
    ]);
    for (const id of ["review_plan", "code_review", "acceptance"]) {
      expect(graph.nodes.find((node) => node.id === id)?.input).toMatchObject({
        context: "$.steps.context"
      });
    }
    expect(collectContextAgents(graph)).toEqual(agentsWithContextInput(graph));

    for (const node of graph.nodes.filter((node) => node.type === "agent")) {
      expect(node.agent, node.id).toBeDefined();
      await expect(access(join("agents", node.agent ?? ""))).resolves.toBe(
        undefined
      );
    }
  });

  it("references existing agents from the implementation workflow graph", async () => {
    const graph = (await parseYamlFile(
      "workflows/implementation/graph.yaml"
    )) as WorkflowGraph;

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "preflight",
      "task_context",
      "workspace",
      "context",
      "implementation_plan",
      "implementation",
      "implementation_validation",
      "worktree_diff",
      "implementation_review",
      "acceptance",
      "acceptance_decision",
      "commit",
      "push",
      "change_request",
      "final_report"
    ]);
    expect(graph.nodes.find((node) => node.id === "implementation")).toEqual(
      expect.objectContaining({
        type: "agent_loop",
        agent: "code-implementer",
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: "implementation-attempts.json",
            source: "$.steps.implementation.attempts",
            format: "json"
          }),
          expect.objectContaining({
            path: "validation.json",
            source: "$.steps.implementation.validation",
            format: "json"
          }),
          expect.objectContaining({
            path: "implementation-result.json",
            source: "$.steps.implementation.result",
            format: "json"
          })
        ])
      })
    );
    for (const id of [
      "implementation_plan",
      "implementation",
      "implementation_review",
      "acceptance"
    ]) {
      expect(graph.nodes.find((node) => node.id === id)?.input).toMatchObject({
        context: "$.steps.context"
      });
    }
    expect(collectContextAgents(graph)).toEqual(agentsWithContextInput(graph));

    for (const node of graph.nodes.filter(
      (candidate) => candidate.type === "agent" || candidate.type === "agent_loop"
    )) {
      expect(node.agent, node.id).toBeDefined();
      await expect(access(join("agents", node.agent ?? ""))).resolves.toBe(
        undefined
      );
    }
  });
});
