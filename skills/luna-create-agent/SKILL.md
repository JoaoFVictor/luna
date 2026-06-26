---
name: luna-create-agent
description: Use when creating or modifying Luna agents under agents/, including agent.yaml, instructions.md, output schemas, model profiles, skills, local tools, MCP servers, subagents, read-only agents, and trusted local write agents.
---

# Luna Create Agent

Read `examples/new-agent.md` first. Agents are reusable workers; workflows decide
when they run and what input they receive.

## Files

Agent definitions are owned by `agents/<agent-id>/`; do not add TypeScript
workflow or runtime files for a new reusable agent.

```text
agents/<agent-id>/
  agent.yaml
  instructions.md
  output.schema.json
```

`agent.yaml` rules:

- `id` must match the directory name.
- `model_profile` must exist in `config/models.yaml`.
- Use capability profile names like `default`, `deep`, `fast`, `balanced`.
- `mode` is `read_only` or `trusted_local_write`.
- `instructions_file` and `output_schema` must stay inside the agent directory.
- Optional `context.files` lists agent-owned reference files relative to
  `agents/<agent-id>/`. Workflows must run `collect_context` and pass
  `context: $.steps.context` for agents to receive them as runtime
  instructions.

## Reuse First

Reuse an existing agent when the role, output schema, and allowed capabilities
still fit. Create a new agent when the responsibility, mode, tools, MCP access,
or schema differs.

Keep orchestration in `workflows/<id>/workflow.yaml` `nodes:`, not in agent
instructions.

## Capabilities

- `skills`: relative paths to `SKILL.md`.
- `tools`: IDs from `src/core/tools/catalog.ts`.
- `mcp_servers`: IDs from `config/mcp.yaml`.
- `subagents`: referenced Luna agent IDs.
- `context.files`: audited reference files injected into runtime instructions.

Repository-wide skills belong in `config/repositories.yaml`, resolved relative
to the prepared repository root. Agent skills belong in `agent.yaml`, resolved
relative to the agent directory. Luna loads repository skills first, then agent
skills, dedupes the same resolved `SKILL.md`, and rejects duplicate skill
`name` values from different files. Do not copy repository procedures into each
agent just to share them.

The concrete agent runtime materializes runtime capabilities under
`src/agent-runtimes/<runtime>/`; do not import runtime SDKs from generic agent
definition or policy modules. The current Pi adapter supports local tools and
rejects MCP tools explicitly until native MCP materialization exists.

When context is collected, Luna renders instructions in this order: Luna
runtime instructions, the current agent's `instructions.md`, matching
agent-owned context, repository context, then normal workflow input. Raw context
file contents must not remain in task JSON; use `context_audit` for metadata.

Subagents are lightweight internal delegation. A referenced read-only subagent
may use skills as instructions, but must not declare local tools, MCP servers,
or nested subagents. Trusted write subagents may use local tools only when the
parent workflow allows write subagents and the subagent reference includes an
explicit `policy.allow_tools` allowlist. Use a workflow graph node when the
delegated work needs artifacts, gates, MCP, or another delegation tree.

## Testing

Run:

```sh
npm test -- tests/core/agent-definition.test.ts
npm test -- tests/capabilities/agents/agent-node.test.ts tests/agent-runtimes/pi/adapter.test.ts
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```

If the agent is wired into a workflow, also run
`tests/core/workflow/runner.test.ts`.
