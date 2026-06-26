import { describe, expect, it, vi } from "vitest";
import type { RunHandle } from "../../../src/core/runtime/run-handle.js";
import type {
  AgentRuntimePort,
  RunAgentInput
} from "../../../src/core/agent-runtime/contracts.js";
import type { ResolvedToolCatalog } from "../../../src/core/tools/resolved-catalog.js";
import { runAgentNode } from "../../../src/capabilities/agents/agent-node.js";

const run = { run_id: "run-1" } as RunHandle;
const modelProfile = { model: "gpt-5", reasoning_effort: "medium" } as const;
const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { enum: ["done"] } }
} as const;

function emptyTools(): ResolvedToolCatalog {
  return { tools: [], runtime_requirements: [] };
}

function localToolCatalog(id: string): ResolvedToolCatalog {
  return {
    tools: [
      {
        id,
        protocol: "local",
        input_schema: {},
        output_schema: {},
        runtime_requirements: ["tool_calling"],
        source: "local_contract"
      }
    ],
    runtime_requirements: ["tool_calling"]
  };
}

function runtime(output: unknown): AgentRuntimePort {
  return {
    describe: () => ({
      id: "test-runtime",
      display_name: "Test Runtime",
      supported_tool_protocols: ["local", "mcp"],
      supported_runtime_requirements: ["tool_calling", "mcp_tools"]
    }),
    validate: vi.fn(),
    runAgent: vi.fn(async () => ({ output }))
  };
}

describe("agents capability agent node", () => {
  it("projects a loaded agent definition to RunAgentInput and invokes only AgentRuntimePort", async () => {
    const port = runtime({ status: "done" });

    await expect(
      runAgentNode({
        runtime: port,
        run,
        node_id: "implement",
        agent: {
          id: "implementer",
          description: "Implements",
          model_profile: "deep",
          mode: "read_only",
          instructions: "Implement the task.\n",
          outputSchema,
          runtime_requirements: ["tool_calling"]
        },
        model_profile: modelProfile,
        input: { issue: "LUNA-1" },
        output_schema: outputSchema,
        tools: emptyTools()
      })
    ).resolves.toEqual({ output: { status: "done" } });

    expect(port.validate).toHaveBeenCalledTimes(1);
    expect(port.runAgent).toHaveBeenCalledTimes(1);
    const projected = vi.mocked(port.runAgent).mock.calls[0]?.[0] as RunAgentInput;
    expect(projected).toMatchObject({
      run,
      node_id: "implement",
      agent_id: "implementer",
      input: { issue: "LUNA-1" },
      output_schema: outputSchema,
      model_profile: modelProfile,
      runtime_requirements: ["tool_calling"],
      tools: { tools: [] }
    });
    expect(projected.instructions).toContain("# Luna Runtime Instructions");
    expect(projected.instructions).toContain("Implement the task.");
  });

  it("validates runtime output against the node output schema before returning it", async () => {
    await expect(
      runAgentNode({
        runtime: runtime({ status: "wrong" }),
        run,
        node_id: "implement",
        agent: {
          id: "implementer",
          description: "Implements",
          model_profile: "deep",
          mode: "read_only",
          instructions: "Implement the task.\n",
          outputSchema
        },
        model_profile: modelProfile,
        input: {},
        output_schema: outputSchema,
        tools: emptyTools()
      })
    ).rejects.toMatchObject({ code: "runtime_output_schema_invalid" });
  });

  it("enforces string constraints from the node output schema", async () => {
    await expect(
      runAgentNode({
        runtime: runtime({ summary: "" }),
        run,
        node_id: "plan",
        agent: {
          id: "planner",
          description: "Plans",
          model_profile: "deep",
          mode: "read_only",
          instructions: "Plan the task.\n",
          outputSchema: {
            type: "object",
            required: ["summary"],
            properties: { summary: { type: "string", minLength: 1 } }
          }
        },
        model_profile: modelProfile,
        input: {},
        output_schema: {
          type: "object",
          required: ["summary"],
          properties: { summary: { type: "string", minLength: 1 } }
        },
        tools: emptyTools()
      })
    ).rejects.toMatchObject({ code: "runtime_output_schema_invalid" });
  });

  it("rejects unresolved tool catalogs before calling the runtime", async () => {
    const port = runtime({ status: "done" });

    await expect(
      runAgentNode({
        runtime: port,
        run,
        node_id: "implement",
        agent: {
          id: "implementer",
          description: "Implements",
          model_profile: "deep",
          mode: "read_only",
          instructions: "Implement the task.\n",
          outputSchema
        },
        model_profile: modelProfile,
        input: {},
        output_schema: outputSchema,
        tools: undefined
      })
    ).rejects.toMatchObject({ code: "agent_tool_catalog_unresolved" });
    expect(port.validate).not.toHaveBeenCalled();
    expect(port.runAgent).not.toHaveBeenCalled();
  });

  it("rejects catalog entries that do not satisfy declared local tools", async () => {
    const port = runtime({ status: "done" });

    await expect(
      runAgentNode({
        runtime: port,
        run,
        node_id: "implement",
        agent: {
          id: "implementer",
          description: "Implements",
          model_profile: "deep",
          mode: "read_only",
          instructions: "Implement the task.\n",
          outputSchema,
          tools: ["repository.status"]
        },
        model_profile: modelProfile,
        input: {},
        output_schema: outputSchema,
        tools: emptyTools()
      })
    ).rejects.toMatchObject({ code: "agent_tool_catalog_missing_tool" });
    expect(port.validate).not.toHaveBeenCalled();
    expect(port.runAgent).not.toHaveBeenCalled();

    await expect(
      runAgentNode({
        runtime: port,
        run,
        node_id: "implement",
        agent: {
          id: "implementer",
          description: "Implements",
          model_profile: "deep",
          mode: "read_only",
          instructions: "Implement the task.\n",
          outputSchema,
          tools: ["repository.status"]
        },
        model_profile: modelProfile,
        input: {},
        output_schema: outputSchema,
        tools: localToolCatalog("repository.status")
      })
    ).resolves.toEqual({ output: { status: "done" } });
  });

  it("rejects catalog entries that do not satisfy declared MCP servers", async () => {
    const port = runtime({ status: "done" });

    await expect(
      runAgentNode({
        runtime: port,
        run,
        node_id: "review",
        agent: {
          id: "reviewer",
          description: "Reviews",
          model_profile: "deep",
          mode: "read_only",
          instructions: "Review the task.\n",
          outputSchema,
          mcp_servers: ["github"]
        },
        model_profile: modelProfile,
        input: {},
        output_schema: outputSchema,
        tools: emptyTools()
      })
    ).rejects.toMatchObject({ code: "agent_tool_catalog_missing_mcp_server" });
    expect(port.validate).not.toHaveBeenCalled();
    expect(port.runAgent).not.toHaveBeenCalled();
  });

  it("rejects declared skills that were not resolved before execution", async () => {
    const port = runtime({ status: "done" });

    await expect(
      runAgentNode({
        runtime: port,
        run,
        node_id: "review",
        agent: {
          id: "reviewer",
          description: "Reviews",
          model_profile: "deep",
          mode: "read_only",
          instructions: "Review the task.\n",
          outputSchema,
          skills: ["review/SKILL.md"]
        },
        model_profile: modelProfile,
        input: {},
        output_schema: outputSchema,
        tools: emptyTools()
      })
    ).rejects.toMatchObject({ code: "agent_skills_unresolved" });
    expect(port.validate).not.toHaveBeenCalled();
    expect(port.runAgent).not.toHaveBeenCalled();

    await expect(
      runAgentNode({
        runtime: port,
        run,
        node_id: "review",
        agent: {
          id: "reviewer",
          description: "Reviews",
          model_profile: "deep",
          mode: "read_only",
          instructions: "Review the task.\n",
          outputSchema,
          skills: ["review/SKILL.md"]
        },
        model_profile: modelProfile,
        input: {},
        output_schema: outputSchema,
        tools: emptyTools(),
        skills: [
          {
            directory: "/repo/skills/review",
            skillMdPath: "/repo/skills/review/SKILL.md",
            requestedPath: "other/SKILL.md",
            name: "other",
            description: "Other skill",
            content: "---\nname: other\ndescription: Other skill\n---\n"
          }
        ]
      })
    ).rejects.toMatchObject({ code: "agent_skills_missing_skill" });
  });

  it("rejects invalid node runtime requirements before calling the runtime", async () => {
    const port = runtime({ status: "done" });

    await expect(
      runAgentNode({
        runtime: port,
        run,
        node_id: "implement",
        agent: {
          id: "implementer",
          description: "Implements",
          model_profile: "deep",
          mode: "read_only",
          instructions: "Implement the task.\n",
          outputSchema
        },
        model_profile: modelProfile,
        input: {},
        output_schema: outputSchema,
        tools: emptyTools(),
        runtime_requirements: ["provider_magic"] as never
      })
    ).rejects.toMatchObject({ code: "agent_runtime_requirements_invalid" });
    expect(port.validate).not.toHaveBeenCalled();
    expect(port.runAgent).not.toHaveBeenCalled();
  });
});
