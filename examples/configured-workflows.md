# Configured Workflows

This is the compact extension map for Luna. It shows what exists, where to add
new pieces, and which recipe to follow. For deeper explanations of ownership,
runtime flow, context hierarchy, skill hierarchy, providers, and the Flue
runtime adapter, read [Architecture docs](../docs/README.md).

## Choose A Starting Point

| Intent | Start With |
| --- | --- |
| Run the smallest read-only example | `workflow:example-minimal-agent` |
| Inspect every currently runnable agent capability | `workflow:example-complete-agent` |
| Review a GitHub PR | [review-pr.md](review-pr.md) |
| Implement a Jira task | [implementation-jira-task.md](implementation-jira-task.md) |
| Create a reusable agent role | [new-agent.md](new-agent.md) |
| Create a workflow graph | [new-workflow.md](new-workflow.md) |
| Create an input adapter | [new-adapter.md](new-adapter.md) |
| Create a built-in step | [new-built-in.md](new-built-in.md) |
| Create a local tool | [new-tool.md](new-tool.md) |

## Runtime Model

Luna exposes one generic workflow entrypoint named `luna` through the current
Flue runtime adapter.

```text
adapter or JSON input -> invocation -> route -> workflow graph -> built-ins/agents/gated_agent_loop -> artifacts
```

Workflow selection is deterministic. The workflow id comes from:

1. CLI target override.
2. The normalized invocation `target`.
3. `config/routing.yaml`.

Use this command shape for adapter input:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:<workflow-id> --from <adapter> <value>
```

Use this command shape for normalized JSON:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:<workflow-id> --input path/to/invocation.json
```

There is one TypeScript workflow entrypoint: `src/workflows/luna.ts`. New
workflow behavior belongs in `workflows/<id>/`, agents, built-ins, providers,
tools, adapters, or configuration.

## Common Runs

Smallest read-only example:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:example-minimal-agent --from github-pr-url https://github.com/org/repo/pull/123
```

Complete capability example:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:example-complete-agent --from github-pr-url https://github.com/org/repo/pull/123
```

Bundled PR review:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:code-review --from github-pr-url https://github.com/org/repo/pull/123
```

Bundled implementation workflow:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:implementation --from jira-task-url https://company.atlassian.net/browse/ABC-123
```

Plane can also drive the implementation workflow:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:implementation --from plane-task-url https://app.plane.so/company/browse/PROJ-42/
```

## Current Inventory

Input adapters:

- `github-pr-url`
- `jira-task-url`
- `plane-task-url`

Workflows:

- `code-review`
- `example-complete-agent`
- `example-minimal-agent`
- `implementation`

Agents:

- `example-minimal-agent`
- `example-complete-agent`
- `review-planner`
- `change-reviewer`
- `change-acceptance-reviewer`
- `implementation-planner`
- `code-implementer`

Built-in steps:

- `change-request.create`
- `context.collect_context`
- `git.commit`
- `git.push_branch`
- `git.status`
- `local-exec.command.read`
- `local-exec.command.write`
- `reports.final_report`
- `repository-workspace.capture`
- `runtime.collect_repo_context`
- `runtime.collect_task_context`
- `runtime.collect_worktree_diff`
- `runtime.commit_changes`
- `runtime.final_code_review_report`
- `runtime.final_implementation_report`
- `runtime.preflight`
- `runtime.prepare_implementation_worktree`
- `runtime.prepare_worktree`
- `runtime.push_branch`
- `runtime.record_implementation_validation`
- `runtime.validate_code_review_findings`

Local tools:

- `repository.status`
- `repository.diff-summary`

Project skills:

- `luna-project-map`
- `luna-create-agent`
- `luna-create-workflow`
- `luna-create-adapter`
- `luna-create-built-in`
- `luna-create-tool`
- `luna-review-change`
- `implementation-safe-git`

Model profiles:

- `default`
- `deep`
- `fast`
- `balanced`

## Extension Map

| Need | Edit | Guide | Deep Dive |
| --- | --- | --- | --- |
| New model role | `agents/<id>/` | [new-agent.md](new-agent.md) | [Agents, context, and skills](../docs/agents-context-and-skills.md) |
| New orchestration | `workflows/<id>/` | [new-workflow.md](new-workflow.md) | [Workflows and artifacts](../docs/workflows-and-artifacts.md) |
| New external input | `src/adapters/<id>/` | [new-adapter.md](new-adapter.md) | [Adapters and providers](../docs/adapters-and-providers.md) |
| New deterministic workflow step | `src/core/built-ins/` or provider built-ins | [new-built-in.md](new-built-in.md) | [Built-ins, tools, and runtime](../docs/built-ins-tools-and-runtime.md) |
| New agent-local function | `src/core/tools/` | [new-tool.md](new-tool.md) | [Built-ins, tools, and runtime](../docs/built-ins-tools-and-runtime.md) |
| Provider-specific auth, config, context, reports, or publishing | `src/providers/<provider>/` | [new-adapter.md](new-adapter.md) plus provider tests | [Adapters and providers](../docs/adapters-and-providers.md) |

## Context And Skills

Context is explicit. A workflow must run `collect_context`, list the agents
that consume context, and pass `context: { expression: "$.steps.context" }` to
those model nodes. Luna renders agent context before repository context and
leaves a `context_audit` summary in task input.

Skills are separate runtime capabilities. Repository skills live in
`config/repositories.yaml`; agent skills live in `agents/<id>/agent.yaml`.
Luna resolves repository skills first, then agent skills, dedupes the same
resolved `SKILL.md`, and rejects duplicate skill names from different files.

## Write-Mode Notes

The `implementation` and `example-complete-agent` workflows are trusted write
workflows. They require a configured repository with `expected_remote_urls`.
Commit, push, and change-request creation are deterministic built-in gates, not
agent responsibilities.

Use `example-minimal-agent` when you want a first read-only shape. Use
`example-complete-agent` when you need to inspect skills, tools, subagents,
trusted write mode, and validation.

## Testing Checklist

For docs and inventory changes:

```bash
npm test -- tests/core/refactor-guardrails.test.ts
```

For a new or changed agent:

```bash
npm test -- tests/core/agent-definition.test.ts tests/core/flue-agent-capabilities.test.ts
```

For a new or changed workflow:

```bash
npm test -- tests/core/workflow/definition.test.ts tests/core/workflow/graph-analysis.test.ts tests/core/configured-workflow-runner.test.ts
```

For adapter, built-in, or tool changes, use the focused guide for that area.
Before opening a broad PR, run:

```bash
npm test
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```
