# Examples

Use these examples when you want a runnable recipe or a copyable starting
point. Use `../docs/` when you need the deeper architecture behind the recipe.

## Start Here

| Goal | Start With | Why |
| --- | --- | --- |
| Run the smallest read-only workflow | `workflows/example-minimal-agent/` | Shows workflow, context intake, one agent, and artifacts without advanced capabilities. |
| See every currently runnable agent capability in one place | `agents/example-complete-agent/` and `workflows/example-complete-agent/` | Shows skills, tools, subagents, trusted repository change, validation, and optional artifacts. |
| Review a GitHub PR | [review-pr.md](review-pr.md) | End-to-end user recipe for the bundled code review workflow. |
| Implement a Jira task | [implementation-jira-task.md](implementation-jira-task.md) | End-to-end repository-change recipe with validation and optional publishing gates. |
| Add a new reusable role | [new-agent.md](new-agent.md) | Agent file layout, output schema, context, skills, tools, MCP, and subagents. |
| Add a new orchestration shape | [new-workflow.md](new-workflow.md) | Workflow YAML, node types, state references, artifacts, and gates. |
| Accept a new external input | [new-adapter.md](new-adapter.md) | Input adapter boundary and normalized invocation shape. |
| Add deterministic workflow behavior | [new-built-in.md](new-built-in.md) | Built-in contracts, metadata, registration, and tests. |
| Add an agent-local function | [new-tool.md](new-tool.md) | Local tool contract, catalog registration, and runtime materialization boundary. |

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

## Files

- `github-pr-opened.invocation.json`: normalized GitHub PR invocation example.
- `luna-generic.invocation.json`: generic routed invocation example.
- `review-pr.md`: GitHub PR review recipe.
- `implementation-jira-task.md`: Jira task implementation recipe.
- `new-agent.md`: create or modify agents.
- `new-workflow.md`: create or modify workflows.
- `new-adapter.md`: create input adapters.
- `new-built-in.md`: create built-ins.
- `new-tool.md`: create local tools.
