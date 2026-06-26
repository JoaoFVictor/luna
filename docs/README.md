# Luna Architecture

This directory explains Luna's runtime layers for people who need to change the
project, not just run it. For step-by-step recipes, use the files in
`examples/`. For agent-facing operating rules, use the project skills in
`skills/`.

Luna is built around one deterministic path:

```text
adapter -> invocation -> router -> workflow graph -> built-ins/agents/gated_agent_loop -> artifacts
```

The current model runtime is Pi, but Luna keeps that at the boundary. New
workflow behavior should usually be YAML, configuration, agents, built-ins, or
tools, not a new TypeScript workflow entrypoint.

## Read These First

- [Agents, context, and skills](agents-context-and-skills.md)
- [Workflows and artifacts](workflows-and-artifacts.md)
- [Adapters and providers](adapters-and-providers.md)
- [Built-ins, tools, and runtime](built-ins-tools-and-runtime.md)

## Layer Map

| Layer | Owns | Does not own |
| --- | --- | --- |
| Input adapters | Turning external input into Luna's normalized invocation shape. | Workflow orchestration, artifacts, worktrees, commits, or model calls. |
| Router | Deterministic workflow selection from target fields and `config/routing.yaml`. | Asking an LLM which workflow to run. |
| Workflows | YAML DAG orchestration, node dependencies, explicit inputs, gates, and artifact plans. | Provider auth, model runtime internals, or reusable agent role definitions. |
| Agents | Reusable model roles, instructions, output schema, and allowed capabilities. | Graph orchestration, gate policy, context discovery, commits, or publishing. |
| Context intake | Reading configured repository and agent files, then producing an auditable context bundle. | Loading skills, choosing agents, or scanning arbitrary repository files. |
| Skills | Reusable runtime guidance exposed to agents as explicit capabilities. | Inline repository context or deterministic TypeScript behavior. |
| Built-ins | Deterministic workflow steps with scheduling metadata. | Model judgment, provider-owned schema shortcuts, or hidden orchestration. |
| Local tools | Small cwd-bound functions an agent can call during a session. | Workflow steps, external input normalization, or direct Pi policy. |
| Providers | Provider-specific auth, config, schema, task context, reports, and change-request actions. | Generic workflow contracts or another provider's schema/auth/config. |
| Pi runtime adapter | Materializing agents, model profiles, local tools, MCP, subagents, retries, and usage logs for Pi. | Generic Luna contracts, provider ownership, or workflow policy. |

## Extension Decision Guide

Use `agents/<id>/` when the role, instructions, model profile, output contract,
or allowed capabilities need to change.

Use `workflows/<id>/` when the orchestration changes: order, dependencies,
gates, artifacts, or which agents and built-ins participate.

Use `src/adapters/<id>/` when Luna must accept a new external input shape and
normalize it into an invocation.

Use `src/core/built-ins/` when the workflow needs deterministic TypeScript
behavior as a graph node.

Use `src/core/tools/` when an agent needs a small deterministic local function
during its model session.

Use `src/providers/<provider>/` when the behavior is provider-specific:
auth, source API config, provider payload parsing, task context rendering,
reports, or change-request publishing.

Use `src/agent-runtimes/pi/` only when the Pi runtime adapter itself
needs to change.

## Non-Negotiable Shape

- There is one generic TypeScript workflow entrypoint: `src/workflows/luna.ts`.
- Workflow definitions live under `workflows/<id>/`.
- Routing is deterministic and model-free.
- Context is explicit. A workflow must run `collect_context` and pass
  `context: $.steps.context` to model nodes that need it.
- Skills are explicit capabilities. They are not the same system as context
  intake.
- Provider code must stay provider-owned. Generic core modules stay
  provider-agnostic except at composition roots.
- Built-in metadata, not ad hoc name checks, drives runner behavior such as
  repository locks, workspace capture, lifecycle evidence, and deferred final
  reports.
