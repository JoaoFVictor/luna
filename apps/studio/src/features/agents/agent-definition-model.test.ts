import { describe, expect, it } from "vitest"

import {
  agentDefinitionView,
  agentGeneralOperations,
  agentResourcesOperations,
  optionalListOperation,
  optionalStringOperation,
  parseSubagents,
  uniqueTrimmedLines,
} from "@/features/agents/agent-definition-model"

describe("agent definition model", () => {
  it("projects only supported structured fields without mutating unknown content", () => {
    expect(agentDefinitionView({
      id: "reviewer",
      description: "Reviews code",
      model_profile: "deep",
      mode: "trusted_local_write",
      instructions_file: "instructions.md",
      output_schema: "output.schema.json",
      context: { files: ["context.md", 42] },
      skills: ["../../skills/review/SKILL.md"],
      tools: ["repository.status"],
      mcp_servers: ["issues"],
      subagents: ["security", { id: "acceptance" }],
      runtime_requirements: ["tool_calling"],
      runtime_preferences: {
        preferred_runtime: "pi",
        runtime_order: ["pi", "fallback"],
      },
      metadata: { owner: "platform" },
    })).toMatchObject({
      sourceIsObject: true,
      id: "reviewer",
      mode: "trusted_local_write",
      contextFiles: ["context.md"],
      tools: ["repository.status"],
      subagents: ["security", { id: "acceptance" }],
      preferredRuntime: "pi",
      runtimeOrder: ["pi", "fallback"],
    })
  })

  it("fails closed to an unavailable structured projection", () => {
    expect(agentDefinitionView(["not", "an", "object"])).toMatchObject({
      sourceIsObject: false,
      mode: "read_only",
      tools: [],
    })
  })

  it("requires an explicit repair instead of presenting an unknown mode as valid", () => {
    const current = agentDefinitionView({
      id: "reviewer",
      description: "Reviews",
      model_profile: "default",
      mode: "future_mode",
      instructions_file: "instructions.md",
      output_schema: "output.schema.json",
    })

    expect(current).toMatchObject({ mode: "read_only", modeIsKnown: false })
    expect(agentGeneralOperations(current, {
      description: "Reviews",
      modelProfile: "default",
      mode: "",
    })).toEqual([])
    expect(agentGeneralOperations(current, {
      description: "Reviews",
      modelProfile: "default",
      mode: "read_only",
    })).toEqual([{ op: "set", path: ["mode"], value: "read_only" }])
  })

  it("normalizes unique line lists and creates explicit set/delete operations", () => {
    expect(uniqueTrimmedLines(" one \n\ntwo\none\n")).toEqual(["one", "two"])
    expect(optionalListOperation(["tools"], ["one"])).toEqual({
      op: "set",
      path: ["tools"],
      value: ["one"],
    })
    expect(optionalListOperation(["tools"], [])).toEqual({
      op: "delete",
      path: ["tools"],
    })
    expect(optionalStringOperation(["runtime_preferences", "preferred_runtime"], "  ")).toEqual({
      op: "delete",
      path: ["runtime_preferences", "preferred_runtime"],
    })
  })

  it("accepts bounded subagent shapes and rejects other JSON roots", () => {
    expect(parseSubagents('["reviewer", {"id":"writer","policy":{"mode":"read_only"}}]'))
      .toMatchObject({ ok: true })
    expect(parseSubagents("{}")).toEqual({
      ok: false,
      message: "Subagents deve ser um array JSON.",
    })
    expect(parseSubagents("[1]")).toEqual({
      ok: false,
      message: "Cada subagent deve ser um id ou objeto de policy.",
    })
  })

  it("builds one reviewable batch for general fields", () => {
    const current = agentDefinitionView({
      id: "reviewer",
      description: "Old",
      model_profile: "fast",
      mode: "read_only",
      instructions_file: "instructions.md",
      output_schema: "output.schema.json",
      runtime_requirements: ["tool_calling"],
      runtime_preferences: { preferred_runtime: "pi" },
    })
    expect(agentGeneralOperations(current, {
      description: "New",
      modelProfile: "deep",
      mode: "trusted_local_write",
    })).toEqual([
      { op: "set", path: ["description"], value: "New" },
      { op: "set", path: ["model_profile"], value: "deep" },
      { op: "set", path: ["mode"], value: "trusted_local_write" },
    ])
  })

  it("builds scoped resource operations while preserving unrelated YAML", () => {
    const current = agentDefinitionView({
      id: "reviewer",
      description: "Reviews",
      model_profile: "fast",
      mode: "read_only",
      instructions_file: "instructions.md",
      output_schema: "output.schema.json",
      context: { files: ["old.md"] },
      skills: ["old/SKILL.md"],
      tools: ["repository.status"],
      subagents: ["security"],
      runtime_requirements: ["tool_calling"],
      runtime_preferences: { preferred_runtime: "pi" },
      metadata: { owner: "platform" },
    })
    expect(agentResourcesOperations(current, {
      contextFiles: [],
      skills: [],
      tools: ["repository.read-file"],
      mcpServers: ["issues"],
      subagents: [{ id: "security", policy: { mode: "read_only" } }],
      runtimeRequirements: [],
      preferredRuntime: "",
      runtimeOrder: ["pi"],
    })).toEqual([
      { op: "delete", path: ["context"] },
      { op: "delete", path: ["skills"] },
      { op: "set", path: ["tools"], value: ["repository.read-file"] },
      { op: "set", path: ["mcp_servers"], value: ["issues"] },
      { op: "delete", path: ["runtime_requirements"] },
      {
        op: "set",
        path: ["subagents"],
        value: [{ id: "security", policy: { mode: "read_only" } }],
      },
      { op: "delete", path: ["runtime_preferences", "preferred_runtime"] },
      { op: "set", path: ["runtime_preferences", "runtime_order"], value: ["pi"] },
    ])
  })

  it("preserves unknown context fields when removing owned file references", () => {
    const current = agentDefinitionView({
      id: "reviewer",
      description: "Reviews",
      model_profile: "fast",
      mode: "read_only",
      instructions_file: "instructions.md",
      output_schema: "output.schema.json",
      context: { files: ["old.md"], future_setting: true },
    })
    expect(agentResourcesOperations(current, {
      contextFiles: [],
      skills: [],
      tools: [],
      mcpServers: [],
      subagents: [],
      runtimeRequirements: [],
      preferredRuntime: "",
      runtimeOrder: [],
    })[0]).toEqual({ op: "delete", path: ["context", "files"] })
  })
})
