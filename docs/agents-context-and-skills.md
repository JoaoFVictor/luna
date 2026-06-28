# Agents, Context, And Skills

Agents are reusable model roles. Workflows decide when an agent runs and what
state it receives; the agent decides how to perform its role and what structured
output it must return.

## Agent Files

```text
agents/<id>/
  agent.yaml
  instructions.md
  output.schema.json
```

`agent.yaml` is strict and includes:

- `id`
- `description`
- `model_profile`
- `mode`: `read_only` or `trusted_local_write`
- `instructions_file`
- `output_schema`
- optional `context.files`
- optional `skills`
- optional `tools`
- optional `mcp_servers`
- optional `subagents`
- optional `runtime_requirements`
- optional `runtime_preferences`

`runtime_preferences` is accepted by the metadata schema, but current runtime
selection is global through runtime composition. Do not assume per-agent runtime
routing exists unless code adds it.

## Execution Path

An `agent` workflow node loads the agent definition, resolves the model
profile, resolves tools/skills/MCP policy, builds an instruction envelope, and
calls the selected agent runtime through the `AgentRuntimePort`.

The runner validates:

- agent id and paths.
- output schema.
- resolved tool catalog.
- runtime requirements supported by the selected runtime.
- final model output as JSON matching the output schema.

The bundled Pi runtime currently supports local tools and `tool_calling`.

## Instruction Order

Luna renders agent instructions in this order:

1. Runtime safety instructions for the agent mode.
2. Resolved skills, with repository skills before agent skills.
3. The agent's `instructions.md`.
4. Agent-owned context for the current agent.
5. Repository context.

Collected context file bodies are rendered into instructions. The JSON task
input is passed as runtime input alongside the instructions, not appended as
instruction prose. Task input keeps only `context_audit` metadata. A task input
that already contains `context_audit` is rejected.

## Context

Context is explicit and auditable. A workflow must run
`context.collect_context` and pass its output to model nodes:

```yaml
input:
  context:
    expression: "$.steps.context"
```

Repository context is configured in `config/repositories.yaml` and read from
the prepared repository/workspace root. Agent context is configured in
`agents/<id>/agent.yaml` and read from the agent directory.

Each collection records configured, read, missing, skipped path escapes,
non-files, and files skipped for size.

## Skills

Skills are reusable instructions described by `SKILL.md`. They are not context
files.

Repository skills live in `config/repositories.yaml` and resolve relative to
the prepared repository root. Agent skills live in `agents/<id>/agent.yaml` and
resolve relative to the agent directory.

Luna resolves repository skills first, then agent skills. The same resolved
file path is deduped. Two different files cannot declare the same skill name.

Use skills for reusable procedures. Use context for project facts that should
be injected into a specific run.

## Tools

Agent tools are capability-registered local tool contracts resolved through
`src/core/tools/**` and implemented by capability modules. Repository tools live
under `src/capabilities/repository/**`.

Mode matters:

- `repository.status`, `repository.diff-summary`, and `repository.read-file`
  can run in read-only and trusted write modes.
- `repository.write-file` and `repository.delete-file` require
  `trusted_local_write`.

The Pi adapter materializes local tools only. It converts ids such as
`repository.read-file` into model-facing names and validates JSON arguments.

## MCP

MCP server policy can be configured and resolved, but the current Pi adapter
does not support MCP tool execution. Docs and agents should not assume MCP
tools work until the runtime adapter advertises and implements that protocol.

## Subagents

Agent metadata can declare subagent references and policy overrides. Workflow
policy controls whether trusted write subagents may be materialized.

In the current codebase, the main implemented multi-agent orchestration path is
workflow/pattern projection: agent nodes and `quality-gates.gated_agent_loop`
worker/gate agents. Use workflow nodes when delegated work needs artifacts,
gates, MCP, or its own lifecycle.

## Source Map

- Agent metadata and instruction assembly:
  `src/capabilities/agents/agent-definition.ts`
- Agent loading: `src/capabilities/agents/agent-loader.ts`
- Agent node execution: `src/capabilities/agents/agent-node.ts`
- Agent runtime port: `src/core/agent-runtime/contracts.ts`
- Runtime validation: `src/core/agent-runtime/validation.ts`
- Context collection: `src/capabilities/context/collect-context.ts`
- Context contracts: `src/core/context/collect-context-contracts.ts`
- Skill loading: `src/core/skills/**`
- Tool resolution: `src/core/tools/resolved-catalog.ts`
- MCP policy: `src/core/tools/mcp-policy.ts`
- Pi adapter: `src/agent-runtimes/pi/adapter.ts`
