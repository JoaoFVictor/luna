import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { capabilityManifest } from "../../../src/core/capabilities/manifest.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import type { AgentRuntimePort } from "../../../src/core/agent-runtime/contracts.js";
import type { WorkflowDefinition } from "../../../src/core/workflow/definition-types.js";
import { compileWorkflow } from "../../../src/core/workflow/compiler.js";
import {
  runCompiledWorkflow,
  type WorkflowAgentDefaults
} from "../../../src/runtime/langgraph/workflow-runner.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reviewed"],
  properties: { reviewed: { type: "boolean" } }
};

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "agents",
    kind: "execution",
    version: "1.0.0",
    schemas: {
      "agents.output": {
        id: "agents.output",
        schema: outputSchema
      }
    }
  })
]);

const collectContext = {
  kind: "luna.collect_context.v1",
  repository: {
    root: "/repo",
    configured: ["AGENTS.md"],
    read: [{ path: "AGENTS.md", bytes: 24, content: "Repository guidance.\n" }],
    missing: [],
    skipped: []
  },
  agents: [
    {
      id: "reviewer",
      root: "/agents/reviewer",
      configured: ["rubric.md"],
      read: [{ path: "rubric.md", bytes: 15, content: "Review rubric.\n" }],
      missing: [],
      skipped: []
    }
  ]
};

function workflow(): WorkflowDefinition {
  return {
    id: "runner-agent-envelope-test",
    type: "workflow",
    mode: "read_only",
    directory: "/tmp/runner-test",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    input_schema_content: { type: "object" },
    output_schema_content: { type: "object" },
    capabilities: ["agents"],
    graph: {
      nodes: [
        {
          id: "review",
          type: "agent",
          agent: "reviewer",
          output_schema: "agents.output",
          input: {
            context: { expression: "$.invocation.context" },
            issue: { expression: "$.invocation.issue" }
          }
        }
      ]
    },
    revision: "revision-1",
    external_definition_digests: {},
    execution: { max_concurrency: 1 },
    requires: { repository: false },
    observability: { exporters: { runtime_log: { enabled: true, required: false } } },
    subagent_policy: { allow_write: false }
  };
}

function backends() {
  return {
    artifacts: createMemoryArtifactManifestStore(),
    events: createMemoryEventStore(),
    interrupts: createMemoryInterruptStore(),
    checkpoints: createMemoryCheckpointStore(),
    runtimeLogs: createMemoryRuntimeLogStore()
  };
}

function agentRuntime(): AgentRuntimePort {
  return {
    describe: () => ({
      id: "test-agent-runtime",
      display_name: "Test",
      supported_tool_protocols: ["local"],
      supported_runtime_requirements: ["tool_calling", "mcp_tools"]
    }),
    validate: vi.fn(),
    runAgent: vi.fn(async () => ({ output: { reviewed: true } }))
  };
}

describe("workflow runner agent envelope", () => {
  it("renders collect_context and skills through the canonical agent projection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-runner-agent-envelope-"));
    const definition = workflow();
    const runtime = agentRuntime();
    const agentDirectory = path.join(root, "agents", "reviewer");
    await mkdir(path.join(agentDirectory, "review"), { recursive: true });
    await writeFile(
      path.join(agentDirectory, "review", "SKILL.md"),
      "---\nname: review-guidance\ndescription: Review guidance.\n---\n\nUse the review skill.\n",
      "utf8"
    );

    try {
      const result = await runCompiledWorkflow({
        compiled: compileWorkflow({ workflow: definition, registry }),
        workflow: definition,
        invocation: { context: collectContext, issue: "LUNA-1" },
        config: {},
        run: {
          run_id: "run-agent-envelope",
          workflow_id: "runner-agent-envelope-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        backends: backends(),
        builtIns: {},
        agentRuntime: runtime,
        agentInputs: {
          review: {
            agent: {
              id: "reviewer",
              mode: "read_only",
              instructions: "Review the workflow output.",
              skills: ["review/SKILL.md"]
            },
            model_profile: { model: "openai/gpt-5", reasoning_effort: "medium" },
            tools: { tools: [], runtime_requirements: ["mcp_tools"] },
            skill_sources: {
              agentDirectory,
              agentSkills: ["review/SKILL.md"]
            },
            cwd: "/tmp/runner-test"
          }
        }
      });

      expect(result.status).toBe("succeeded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const projected = vi.mocked(runtime.runAgent).mock.calls[0]?.[0];
    expect(projected).toMatchObject({
      node_id: "review",
      agent_id: "reviewer",
      input: {
        issue: "LUNA-1",
        context_audit: {
          agent: {
            id: "reviewer",
            configured: ["rubric.md"],
            read: [{ path: "rubric.md", bytes: 15 }],
            missing: [],
            skipped: []
          },
          repository: {
            configured: ["AGENTS.md"],
            read: [{ path: "AGENTS.md", bytes: 24 }],
            missing: [],
            skipped: []
          }
        }
      },
      context: collectContext,
      runtime_requirements: ["mcp_tools"]
    });
    expect(projected?.instructions).toContain("# Skills");
    expect(projected?.instructions).toContain("Use the review skill.");
    expect(projected?.instructions).toContain("# Agent Context");
    expect(projected?.instructions).toContain("Review rubric.");
    expect(projected?.instructions).toContain("# Repository Context");
    expect(projected?.instructions).toContain("Repository guidance.");
  });

  it("resolves repository skills from the prepared workspace at agent execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-runner-agent-skills-"));
    try {
      const repositoryRoot = path.join(root, "source");
      const workspaceRoot = path.join(root, "workspace");
      const agentsRoot = path.join(root, "agents");
      const agentDirectory = path.join(agentsRoot, "reviewer");
      await mkdir(path.join(repositoryRoot, "skills"), { recursive: true });
      await mkdir(path.join(workspaceRoot, "skills"), { recursive: true });
      await mkdir(agentDirectory, { recursive: true });
      await writeFile(
        path.join(repositoryRoot, "skills", "review.md"),
        [
          "---",
          "name: repo-review",
          "description: Source repo review skill.",
          "---",
          "",
          "SOURCE REPO SKILL SHOULD NOT BE USED."
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(workspaceRoot, "skills", "review.md"),
        [
          "---",
          "name: repo-review",
          "description: Workspace review skill.",
          "---",
          "",
          "WORKSPACE SKILL WAS USED."
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(agentDirectory, "agent-skill.md"),
        [
          "---",
          "name: agent-review",
          "description: Agent review skill.",
          "---",
          "",
          "AGENT SKILL WAS USED."
        ].join("\n"),
        "utf8"
      );

      const definition = workflow();
      const runtime = agentRuntime();

      await runCompiledWorkflow({
        compiled: compileWorkflow({ workflow: definition, registry }),
        workflow: definition,
        invocation: { context: collectContext, issue: "LUNA-2" },
        config: {},
        run: {
          run_id: "run-agent-skill-root",
          workflow_id: "runner-agent-envelope-test",
          attempt: 1,
          started_at: "2026-06-25T00:00:00.000Z"
        },
        runtimeContext: {
          repository: {
            id: "repo",
            path: repositoryRoot,
            default_branch: "main",
            skills: ["skills/review.md"]
          },
          workspace: {
            operation_id: "repository-workspace.capture",
            workspace_id: "repo:run-agent-skill-root",
            repository_id: "repo",
            run_id: "run-agent-skill-root",
            path: workspaceRoot,
            branch: "luna/test",
            base_sha: "abc123",
            remote: "origin",
            preserved: true,
            reason: "test"
          },
          workspaceRoot: root,
          agentsRoot
        },
        backends: backends(),
        builtIns: {},
        agentRuntime: runtime,
        agentInputs: {
          review: {
            agent: {
              id: "reviewer",
              mode: "read_only",
              instructions: "Review the workflow output.",
              skills: ["agent-skill.md"]
            },
            model_profile: { model: "openai/gpt-5", reasoning_effort: "medium" },
            tools: { tools: [], runtime_requirements: [] },
            cwd: workspaceRoot,
            skill_sources: {
              repository: { root: repositoryRoot, skills: ["skills/review.md"] },
              agentDirectory,
              agentSkills: ["agent-skill.md"]
            }
          } as unknown as WorkflowAgentDefaults
        }
      });

      const projected = vi.mocked(runtime.runAgent).mock.calls[0]?.[0];
      expect(projected?.instructions).toContain("WORKSPACE SKILL WAS USED.");
      expect(projected?.instructions).not.toContain("SOURCE REPO SKILL SHOULD NOT BE USED.");
      expect(projected?.instructions).toContain("AGENT SKILL WAS USED.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
