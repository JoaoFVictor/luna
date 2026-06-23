# Agents, Context, And Skills

This document explains what an agent owns, how Luna assembles runtime
instructions, and how context and skills differ.

## What An Agent Is

An agent is a reusable model role under `agents/<id>/`. The workflow graph
decides when the agent runs; the agent defines how that role behaves.

An agent owns:

- `agent.yaml`: id, description, model profile, mode, instruction file, output
  schema, and optional capabilities.
- `instructions.md`: role-specific instructions.
- `output.schema.json`: the structured output contract.
- optional configured context files.
- optional skills, local tools, MCP servers, and subagents.

The agent id must match its directory name. Paths referenced from `agent.yaml`
are validated and must stay inside the allowed capability area for that agent.
Duplicate skill, tool, MCP, and subagent references are rejected.

Agents do not own orchestration. A workflow graph owns dependencies, retries,
gates, artifact plans, and how outputs feed later steps.

## Runtime Handoff

The normal handoff is:

```text
workflow node -> runWorkflowNode -> Flue agent runner -> instruction envelope -> model session -> structured output
```

The workflow node chooses the agent by id. The node runner loads the agent
definition, resolves the model profile, resolves capabilities, prepares the
instruction envelope, runs the model through the current runtime adapter, and
validates the result against the agent output schema.

`agent` nodes are single model calls with structured output. `gated_agent_loop`
nodes are trusted local write loops that can run a writer, validation commands,
read-only gate agents, diff collection, and repair attempts.

## Instruction Hierarchy

For a model prompt, Luna renders instructions in this order:

1. Luna runtime instructions for the agent mode.
2. The agent's `instructions.md`.
3. Agent-owned context that matches the running agent.
4. Repository context.
5. The JSON task input.

This ordering is intentional. Runtime safety and mode rules come first. The
agent's role comes next. Context is added after the role so it informs the task
without replacing the agent contract. The task input is last and contains the
current workflow state selected by the graph.

Luna strips raw context from the task input and replaces it with
`context_audit`. That keeps prompts inspectable without duplicating large
context blobs. `context_audit` is a reserved task input key; a workflow input
that already contains it is rejected.

## Context Hierarchy

Context is explicit and auditable. It exists only when a workflow runs the
`collect_context` built-in and then passes `context: $.steps.context` into a
model node.

Repository context is configured in `config/repositories.yaml`:

```yaml
repositories:
  - id: repo
    context:
      files:
        - AGENTS.md
        - README.md
```

Agent context is configured in `agents/<id>/agent.yaml`:

```yaml
context:
  files:
    - notes.md
```

`collect_context` reads repository files from the prepared repository root or
workspace root, and agent files from the matching agent directory. It records
which files were configured, read, missing, skipped for path escape, skipped
because they were not files, or skipped because they were too large.

Use context for project facts that should be rendered directly into runtime
instructions: repository rules, local architecture notes, agent-specific
operating notes, and task guidance that should not become a reusable skill.

Do not rely on agents or Flue to discover context implicitly. If the graph does
not pass context into a model node, that node does not receive repository or
agent context.

## Skill Hierarchy

Skills are not context. A skill is a reusable capability described by a
`SKILL.md` file and materialized for the runtime agent.

Repository skills live in `config/repositories.yaml` and resolve relative to
the prepared repository root:

```yaml
repositories:
  - id: repo
    skills:
      - .luna/skills/repository-guidance/SKILL.md
```

Agent skills live in `agents/<id>/agent.yaml` and resolve relative to the agent
directory:

```yaml
skills:
  - ../../skills/luna-create-workflow/SKILL.md
```

Luna resolves repository skills first, then agent skills. The same resolved
`SKILL.md` path is deduped. Two different files cannot declare the same skill
name.

Use skills for reusable operating procedures: how to create a Luna workflow,
how to create a local tool, how to review a Luna change, or how to perform
safe implementation git operations.

Use context for project data that should be read as instructions for the
current run. Do not put large repository facts into a skill just to make them
available to one workflow run.

## Capabilities

Local tools are Luna-native TypeScript contracts registered in
`src/core/tools/catalog.ts`. The current Flue adapter materializes them in
`src/core/agent-runtime/flue/tool-registry.ts`. Tool ids can contain dots, but
their model-facing Flue names replace dots and dashes with underscores.

MCP servers are configured centrally in `config/mcp.yaml`. Agent config chooses
which MCP servers it may use. Luna enforces allowed agent modes and allowed MCP
tool names, then exposes adapted names such as `mcp__server__tool`.

Subagents are agent capabilities, not workflow nodes. They are lightweight Flue
profiles built from another agent's description, instructions, model profile,
skills, and selected context. Read-only subagents cannot use local tools, MCP,
or nested subagents. Trusted write subagents require workflow
`subagent_policy.allow_write: true` plus a per-reference tool allowlist.

Use a workflow node instead of a subagent when the delegated work needs its own
artifacts, gates, MCP access, or delegation tree.

## What This Layer Does

- Keeps agent roles reusable across workflows.
- Enforces agent output schemas.
- Separates role instructions from workflow orchestration.
- Makes context explicit and auditable.
- Resolves skills in a deterministic repository-then-agent order.
- Limits tools, MCP, and subagents through declared capability policy.

## What This Layer Does Not Do

- It does not choose which workflow to run.
- It does not collect context unless the workflow asks for it.
- It does not put gate policy in `agent.yaml`.
- It does not commit, push, or open change requests.
- It does not let read-only subagents mutate local repositories.

## Source Map

- Agent contracts: `src/core/agents/definition.ts`
- Capability schema: `src/core/agents/capabilities.ts`
- Instruction envelope: `src/core/agents/instruction-stack.ts`
- Context intake: `src/core/context/intake.ts`
- Context built-in: `src/core/built-ins/context.ts`
- Skill resolution: `src/core/skills/definition.ts`
- Tool catalog: `src/core/tools/catalog.ts`
- Flue capabilities: `src/core/agent-runtime/flue/capabilities.ts`
- Flue tools: `src/core/agent-runtime/flue/tool-registry.ts`
- MCP materialization: `src/core/agent-runtime/flue/mcp-capabilities.ts`
- Subagents: `src/core/agent-runtime/flue/subagent-profiles.ts`

Useful tests include `tests/core/agent-definition.test.ts`,
`tests/core/agent-instruction-stack.test.ts`,
`tests/core/built-ins-context.test.ts`, `tests/core/skill-definition.test.ts`,
`tests/core/flue-agent-capabilities.test.ts`,
`tests/core/flue-tool-registry.test.ts`,
`tests/core/flue-mcp-capabilities.test.ts`, and
`tests/core/flue-subagent-profiles.test.ts`.

