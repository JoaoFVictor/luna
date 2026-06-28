---
name: luna-create-agent
description: Use when creating or modifying Luna agents under agents/, including agent.yaml, instructions, output schemas, model profiles, skills, local tools, MCP declarations, subagents, read-only agents, and trusted local write agents.
---

# Luna Create Agent

Agents are reusable model roles. Workflows decide when they run and what input
they receive.

## Files

```text
agents/<agent-id>/
  agent.yaml
  instructions.md
  output.schema.json
```

`agent.yaml` rules:

- `id` must match the directory name.
- `model_profile` must exist in `config/models.yaml`.
- `mode` is `read_only` or `trusted_local_write`.
- `instructions_file` and `output_schema` stay inside the agent directory.
- `tools`, `skills`, `mcp_servers`, and `subagents` must not contain duplicate
  ids.

## Reuse First

Reuse an agent when the role, output schema, mode, and allowed capabilities fit.
Create a new one when the responsibility or contract differs.

Keep orchestration, gates, retries, and artifact plans in workflow YAML.

## Capabilities

- `skills`: relative paths to `SKILL.md`.
- `tools`: capability-registered local tool ids.
- `mcp_servers`: ids from `config/mcp.yaml`.
- `subagents`: referenced Luna agent ids.
- `context.files`: agent-owned context files.

Repository skills live in `config/repositories.yaml`; agent skills live in
`agent.yaml`. Repository skills load first, then agent skills.

Repository tools are mode-gated. Write/delete repository tools require
`trusted_local_write`.

MCP configuration can resolve policy, but the current Pi runtime does not
execute MCP tools. Do not assume MCP works unless the selected runtime supports
it.

## Context

Agents receive context only when the workflow runs `context.collect_context`
and passes `context: { expression: "$.steps.context" }`.

## Testing

Run focused agent tests and any workflow that uses the agent, then:

```bash
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```
