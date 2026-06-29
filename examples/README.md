# Examples

Use these examples when you want a runnable recipe or a copyable starting
point. Use `../docs/` when you need the deeper architecture behind the recipe.

## Start Here

| Goal | Start With | Why |
| --- | --- | --- |
| Run the smallest read-only workflow | `workflows/example-minimal-agent/` | Shows workflow, context intake, one agent, and artifacts without advanced capabilities. |
| See every currently runnable agent-authoring field in one place | `agents/example-complete-agent/` and `workflows/example-complete-agent/` | Shows model profile, mode, context, skills, local tools, subagents, gated loop, retry, runtime log, and artifacts. It is not the full platform workflow. |
| Review a GitHub PR | [review-pr.md](review-pr.md) | End-to-end user recipe for the bundled code review workflow. |
| Implement a Jira task | [implementation-jira-task.md](implementation-jira-task.md) | End-to-end repository-change recipe with validation and optional publishing gates. |
| Implement a Plane task | [implementation-plane-task.md](implementation-plane-task.md) | Same implementation workflow, sourced from Plane issue data and repository labels. |
| Diagnose a failed or paused run | [troubleshooting.md](troubleshooting.md) | Operational runbook for routing, config, auth, validation, HITL, publishing, and artifacts. |
| Add a new reusable role | [new-agent.md](new-agent.md) | Agent file layout, output schema, context, skills, tools, MCP, and subagents. |
| Add a new orchestration shape | [new-workflow.md](new-workflow.md) | Workflow YAML, node types, state references, artifacts, and gates. |
| Accept a new external input | [new-adapter.md](new-adapter.md) | Input adapter boundary and normalized invocation shape. |
| Add deterministic workflow behavior | [new-built-in.md](new-built-in.md) | Built-in contracts, metadata, registration, and tests. |
| Add an agent-local function | [new-tool.md](new-tool.md) | Local tool contract, catalog registration, and runtime materialization boundary. |

## Workflow Coverage

| Workflow | Purpose | HITL | Covers |
| --- | --- | --- | --- |
| `example-minimal-agent` | Smallest read-only runnable workflow. | No | context collection, one agent node, JSON/markdown artifacts. |
| `example-complete-agent` | Agent-authoring and HITL/publishing showcase. | Yes | trusted-write agent config, context, skills, local tools, subagents, gated loop, validation/review/acceptance gates, HITL approval, commit, push, change request, retry, runtime-log projection, artifacts. |
| `code-review` | Production-style PR review. | No | preflight, workspace capture, repository diff context, planning agent, reviewer agent, evidence validation, acceptance agent, optional PR review publication, final report. |
| `implementation` | Full trusted write implementation workflow. | No | preflight, worktree preparation, task context, planner, gated writer loop, validation, non-empty diff, review/acceptance gates, diff, commit, push, change request, final report. |

The platform-wide "everything" reference is the combination of
`workflows/example-complete-agent/workflow.yaml`,
`workflows/implementation/workflow.yaml`, `workflows/code-review/workflow.yaml`,
and `agents/example-complete-agent/agent.yaml`. No single example should be used
as proof that every Luna capability is appropriate for every workflow.

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

Bundled implementation workflow from Plane:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:implementation --from plane-task-url https://app.plane.so/company/browse/PROJ-42/
```

## Files

- `github-pr-opened.invocation.json`: normalized GitHub PR invocation example.
- `jira-issue-selected.invocation.json`: normalized Jira issue invocation example.
- `plane-issue-selected.invocation.json`: normalized Plane issue invocation example.
- `luna-generic.invocation.json`: generic routed invocation example.
- `review-pr.md`: GitHub PR review recipe.
- `implementation-jira-task.md`: Jira task implementation recipe.
- `implementation-plane-task.md`: Plane task implementation recipe.
- `troubleshooting.md`: runbook for failed, paused, or surprising runs.
- `new-agent.md`: create or modify agents.
- `new-workflow.md`: create or modify workflows.
- `new-adapter.md`: create input adapters.
- `new-built-in.md`: create built-ins.
- `new-tool.md`: create local tools.
