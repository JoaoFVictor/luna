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
- `mode` is `read_only` or `trusted_host_local_write`.
- `instructions_file` and `output_schema` must stay inside the agent directory.
- Optional `context.files` lists agent-owned reference files relative to
  `agents/<agent-id>/`. Workflows must run `collect_context` and pass
  `context: $.steps.context` for agents to receive them.

## Reuse First

Reuse an existing agent when the role, output schema, and allowed capabilities
still fit. Create a new agent when the responsibility, mode, tools, MCP access,
or schema differs.

Keep orchestration in `workflows/<id>/graph.yaml`, not in agent instructions.

## Capabilities

- `skills`: relative paths to `SKILL.md`.
- `tools`: IDs from `src/core/tools/catalog.ts`.
- `mcp_servers`: IDs from `config/mcp.yaml`.
- `subagents`: referenced Luna agent IDs.
- `context.files`: audited reference files passed through workflow input.

Flue materializes skills, tools, MCP servers, and subagent profiles through
`src/core/agent-runtime/flue/capabilities.ts`; do not import Flue runtime APIs
from generic agent definition or policy modules.

Subagents are lightweight internal delegation. A referenced subagent may use
skills as instructions, but must not declare local tools, MCP servers, or nested
subagents; use a workflow graph node when the delegated work needs artifacts,
gates, tools, MCP, or another delegation tree.

## Testing

Run:

```sh
rtk npm test -- tests/core/agent-definition.test.ts
rtk npm test -- tests/core/flue-agent-capabilities.test.ts tests/core/flue-subagent-profiles.test.ts
rtk npm run typecheck
rtk npm run typecheck:unused-src
rtk npm run lint:unused
```

If the agent is wired into a workflow, also run
`tests/core/configured-workflow-runner.test.ts`.
