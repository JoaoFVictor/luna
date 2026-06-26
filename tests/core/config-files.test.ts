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
    type: "agent" | "built_in" | "pattern" | "human_gate";
    uses?: string;
    agent?: string;
    worker?: string;
    gates?: Array<{
      type: string;
      input?: Record<string, unknown>;
    }>;
    after?: string[];
    input?: Record<string, unknown>;
  }>;
};

const yamlRoots = ["agents", "workflows", "config"];
const jsonSchemaRoots = ["agents", "workflows"];
const invocationReferenceScanRoots = [
  "src",
  "tests",
  "agents",
  "workflows",
  "examples",
  "skills",
  "README.md",
  "AGENTS.md"
];
const intentionalInvocationReferenceFiles = new Set([
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
  const nodeAgents = graph.nodes
    .filter((node) => node.type === "agent" || node.type === "pattern")
    .filter((node) => expressionValue(node.input?.context) === "$.steps.context")
    .map((node) => node.agent ?? node.worker)
    .filter((agent): agent is string => agent !== undefined);
  const gateAgents = graph.nodes.flatMap((node) =>
    (node.gates ?? [])
      .map((gate) => gate.input?.review_agent)
      .filter((agent): agent is string => agent !== undefined)
  );

  return [...nodeAgents, ...gateAgents];
}

function collectContextAgents(graph: WorkflowGraph): string[] {
  const contextNode = graph.nodes.find(
    (node) => node.type === "built_in" && node.uses === "context.collect_context"
  );
  const agents = contextNode?.input?.agents;

  return Array.isArray(agents) ? agents.filter((agent): agent is string =>
    typeof agent === "string"
  ) : [];
}

function expressionValue(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const expression = (value as { expression?: unknown }).expression;
    return typeof expression === "string" ? expression : undefined;
  }

  return typeof value === "string" ? value : undefined;
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
  it("keeps invocation target references on the current shape", async () => {
    const unsupportedTargets = ["github" + "_pr", "jira" + "_task"];
    const bannedReferences = unsupportedTargets.flatMap((target) => [
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

    const files = await listTextFiles(invocationReferenceScanRoots);
    const matches: string[] = [];

    for (const file of files) {
      if (intentionalInvocationReferenceFiles.has(file)) {
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
        "agents/example-minimal-agent/agent.yaml",
        "agents/implementation-planner/agent.yaml",
        "agents/review-planner/agent.yaml",
        "config/implementation.yaml",
        "config/jira.yaml",
        "config/plane.yaml",
        "workflows/code-review/workflow.yaml",
        "workflows/example-complete-agent/workflow.yaml",
        "workflows/example-minimal-agent/workflow.yaml",
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
        "agents/example-minimal-agent/output.schema.json",
        "agents/implementation-planner/output.schema.json",
        "agents/review-planner/output.schema.json",
        "workflows/code-review/input.schema.json",
        "workflows/code-review/output.schema.json",
        "workflows/example-complete-agent/input.schema.json",
        "workflows/example-complete-agent/output.schema.json",
        "workflows/example-minimal-agent/input.schema.json",
        "workflows/example-minimal-agent/output.schema.json",
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
      "agents/example-minimal-agent/agent.yaml",
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
        task: {
          provider: "jira",
          key: "ABC-123",
          id: "ABC-123",
          url: "https://company.atlassian.net/browse/ABC-123",
          title: "Fix checkout validation",
          status: "To Do"
        },
        jira: {
          key: "ABC-123",
          url: "https://company.atlassian.net/browse/ABC-123",
          summary: "Fix checkout validation",
          status: "To Do"
        },
        repository: {
          provider: "github",
          owner: "octo-org",
          name: "hello-world"
        },
        status: "validation_failed",
        branch: "feature/abc-123-fix-checkout-validation",
        worktree: {
          path: "/tmp/luna/hello-world/run-1",
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
        path: "/tmp/luna/hello-world/run-1",
        preserved: true,
        reason: "commit_disabled",
        repository_id: "hello-world",
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
        run: {
          ...output.run,
          source: "plane",
          subject: {
            type: "plane_issue",
            id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984"
          }
        },
        report: {
          task: {
            provider: "plane",
            key: "42",
            id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
            url: "https://app.plane.so/company/projects/24f9b7/issues/b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
            title: "Fix checkout validation",
            status: "Backlog"
          },
          plane: {
            issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
            sequence_id: 42,
            workspace_slug: "company",
            project_id: "24f9b7",
            priority: "high",
            labels: ["bug"]
          },
          repository: output.report.repository,
          status: output.report.status,
          branch: output.report.branch,
          worktree: output.report.worktree,
          validation: output.report.validation,
          commit: output.report.commit,
          push: output.report.push,
          change_request: output.report.change_request,
          warnings: output.report.warnings
        }
      }),
      formatAjvErrors(validate.errors)
    ).toBe(true);

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

    expect(
      validate({
        ...output,
        report: {
          ...output.report,
          task: {
            ...output.report.task,
            provider: "plane"
          }
        }
      }),
      "report should reject provider-specific blocks that do not match task.provider"
    ).toBe(false);

    expect(
      validate({
        ...output,
        report: {
          ...output.report,
          task: {
            ...output.report.task,
            provider: "plane"
          },
          plane: {
            issue_id: "b5a8c2ff-0c4a-41fb-8937-e4bc62c4e984",
            workspace_slug: "company",
            project_id: "24f9b7",
            priority: "high",
            labels: []
          }
        }
      }),
      "report should reject multiple provider-specific blocks"
    ).toBe(false);

    const { jira: _jira, ...reportWithoutProviderBlock } = output.report;
    expect(
      validate({
        ...output,
        report: reportWithoutProviderBlock
      }),
      "report should require the provider-specific block for task.provider"
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
      "workflows/code-review/workflow.yaml"
    )) as WorkflowGraph;

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "preflight",
      "workspace",
      "repo_context",
      "context",
      "review_plan",
      "code_review",
      "acceptance",
      "final_report"
    ]);
    expect(graph.nodes.find((node) => node.id === "code_review")?.after).toEqual([
      "review_plan"
    ]);
    for (const id of ["review_plan", "code_review", "acceptance"]) {
      expect(
        expressionValue(graph.nodes.find((node) => node.id === id)?.input?.context)
      ).toBe("$.steps.context");
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
      "workflows/implementation/workflow.yaml"
    )) as WorkflowGraph;

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "preflight",
      "workspace",
      "task_context",
      "context",
      "implementation_plan",
      "implementation",
      "implementation_validation",
      "worktree_diff",
      "commit",
      "push",
      "change_request",
      "final_report"
    ]);
    expect(graph.nodes.find((node) => node.id === "implementation")).toEqual(
      expect.objectContaining({
        type: "pattern",
        worker: "code-implementer",
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: "implementation-result.json",
            format: "json"
          })
        ])
      })
    );
    for (const id of [
      "implementation_plan",
      "implementation"
    ]) {
      expect(
        expressionValue(graph.nodes.find((node) => node.id === id)?.input?.context)
      ).toBe("$.steps.context");
    }
    const implementationNode = graph.nodes.find(
      (node) => node.id === "implementation"
    );
    expect(
      implementationNode?.gates
        ?.filter((gate) => gate.type === "quality-gates.agent_review")
        .map((gate) => gate.input?.review_agent)
    ).toEqual(["change-reviewer", "change-acceptance-reviewer"]);
    expect(collectContextAgents(graph)).toEqual(agentsWithContextInput(graph));

    for (const node of graph.nodes.filter(
      (candidate) => candidate.type === "agent" || candidate.type === "pattern"
    )) {
      const agentId = node.agent ?? node.worker;
      expect(agentId, node.id).toBeDefined();
      await expect(access(join("agents", agentId ?? ""))).resolves.toBe(
        undefined
      );
    }
    for (const gate of implementationNode?.gates ?? []) {
      if (gate.type !== "quality-gates.agent_review") {
        continue;
      }
      const reviewAgent = gate.input?.review_agent;
      expect(reviewAgent, gate.type).toBeDefined();
      await expect(access(join("agents", String(reviewAgent)))).resolves.toBe(
        undefined
      );
    }
  });
});
