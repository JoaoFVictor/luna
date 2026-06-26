# Luna

Luna is a base for building multi-agent workflows.

It gives you a deterministic way to turn external inputs into workflow runs,
route them through YAML graphs, reuse agents, call deterministic capabilities,
and inspect the result through artifacts. The bundled PR review and
implementation flows are examples of what can be built on top of Luna; they are
not the boundary of the project.

Use Luna when you want repeatable agent workflows for code review, planning,
implementation, triage, research, migrations, repository automation, or any
other process that benefits from explicit orchestration instead of an ad hoc
chat transcript.

```text
adapter -> invocation -> router -> workflow graph -> built-ins/agents/gated agent loops -> artifacts
```

Luna currently uses Flue as the agent runtime adapter. The workflow entrypoint
stays generic: new workflows are YAML graphs, not new TypeScript workflow
entrypoints.

## Why Luna

Most agent workflows get hard to maintain when the orchestration, prompts,
tools, context, validation, and reporting all live in one place. Luna separates
those concerns:

- adapters normalize external inputs;
- routing chooses a workflow deterministically;
- workflow graphs define the orchestration;
- agents provide reusable model judgment;
- built-ins provide deterministic workflow steps;
- local tools expose deterministic functions to agents;
- artifacts make each run inspectable.

That structure is the point. You should be able to add a new workflow without
copying a runtime, rewriting an agent, or hiding important behavior inside a
prompt.

## Building Blocks

`workflows/<id>/` contains YAML workflow definitions. A workflow decides what
runs, in what order, and which outputs feed later steps.

`agents/<id>/` contains reusable agent definitions. Agents own their
instructions, model profile, output schema, skills, tools, MCP access, and
optional subagents. Reuse an agent when its role and output contract still fit;
create a new one when the responsibility changes.

`src/adapters/<id>/` contains input adapters. An adapter turns an external
input, such as a GitHub PR URL, Jira task URL, or Plane task URL, into a
normalized invocation.

`src/core/built-ins/` contains deterministic workflow behavior and shared
catalog helpers. Provider-facing built-ins are registered through
`src/core/providers/built-ins.ts`.

`src/core/tools/` contains Luna-native local tool contracts and the tool
catalog. Flue tool materialization lives under `src/core/agent-runtime/flue/`.

`skills/` contains reusable guidance for LLMs and runtime agents.

## Documentation

Use `docs/` when you need to understand Luna's architecture before changing a
layer. These files explain what each layer owns, how it runs, what it should
not do, and where the canonical source and tests live:

- [Architecture overview](docs/README.md)
- [Agents, context, and skills](docs/agents-context-and-skills.md)
- [Workflows and artifacts](docs/workflows-and-artifacts.md)
- [Adapters and providers](docs/adapters-and-providers.md)
- [Built-ins, tools, and runtime](docs/built-ins-tools-and-runtime.md)

Use `examples/` for practical recipes and copyable starting points.

## Try A Starter Workflow

Install dependencies:

```bash
npm install
```

Authenticate Pi's OpenAI Codex provider:

```bash
npx @earendil-works/pi-ai login openai-codex
```

Authenticate GitHub CLI:

```bash
gh auth status
```

Clone the repository Luna should inspect:

```bash
git clone git@github.com:org/repo.git /path/to/local/repo
```

Configure it in `config/repositories.yaml`:

```yaml
repositories:
  - id: repo
    provider: github
    owner: org
    name: repo
    path: /path/to/local/repo
    remote: origin
    expected_remote_urls:
      - git@github.com:org/repo.git
      - https://github.com/org/repo.git
    skills:
      - .luna/skills/repository-guidance/SKILL.md
    context:
      files:
        - AGENTS.md
        - README.md
```

Run a GitHub PR review:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:code-review --from github-pr-url https://github.com/org/repo/pull/123
```

Read the report:

```text
.runs/code-review/<run-id>/final-report.md
```

For the starter write-mode implementation workflow, configure Jira or Plane
credentials, repository remote allowlists, validation commands, and optional
publishing gates first. See [Implement a Jira task](examples/implementation-jira-task.md)
or the Plane adapter notes in [Configured workflows](examples/configured-workflows.md).

## Build Your Own Workflow

Start from the minimal read-only pair when you want the smallest runnable
shape:

- `workflows/example-minimal-agent/`
- `agents/example-minimal-agent/`

Use the complete pair when you need to inspect skills, tools, subagents,
trusted write mode, validation, and optional artifacts:

- `workflows/example-complete-agent/`
- `agents/example-complete-agent/`

Then create:

- `workflows/<id>/workflow.yaml`
- `workflows/<id>/input.schema.json`
- `workflows/<id>/output.schema.json`

Put orchestration in `workflow.yaml` `nodes:`. Use:

- `built_in` nodes for deterministic TypeScript behavior;
- `agent` nodes for model judgment with structured output;
- `pattern` nodes such as `quality-gates.gated_agent_loop` for trusted local
  write work with validation and repair.

`quality-gates.gated_agent_loop` gates are configured in
`workflows/<id>/workflow.yaml` under the pattern node's `gates:` list. Luna
supports `quality-gates.validation_commands` gates and read-only workflow
`agent` gates. For an `agent` gate, configure `block_when` as a JSONata
expression on the workflow gate entry, not in the referenced agent definition.
`block_when.expression` must return a boolean, and optional
`feedback.expression` selects repair feedback when the gate blocks. Failed gates
loop back into the trusted write agent for a repair attempt.

Link agents by id from the workflow graph. Prefer reusing an existing agent when
the role, input, tools, MCP access, and output schema match what the workflow
needs. Create a new agent when the workflow needs a different contract.

Authoring guides:

- [Create a new workflow](examples/new-workflow.md)
- [Create a new agent](examples/new-agent.md)
- [Configured workflows reference](examples/configured-workflows.md)

## How Luna Runs

An adapter converts an external value into an invocation. The router chooses a
workflow from `--target workflow:<id>`, the invocation `target`, or
`config/routing.yaml`.

There is one generic TypeScript workflow entrypoint:
`src/workflows/luna.ts`. Do not add one TypeScript workflow file per workflow.

The selected workflow graph runs built-ins, agents, and gated agent loops. Each node
reads explicit inputs from earlier steps and writes inspectable outputs into the
run artifact directory.

## Context, Artifacts, And Trust

Luna does not ask agents or Flue to discover repository guidance implicitly.
Workflows that need guidance files run `collect_context` and pass
`context: { expression: "$.steps.context" }` explicitly to model nodes.

Context files may come from:

- repository config in `config/repositories.yaml`;
- agent config in `agents/<id>/agent.yaml`.

Luna renders collected context as runtime instructions, then sends a compact
`context_audit` summary in the task input. Each run writes
`context-intake.json`, so missing, skipped, and read context files remain
inspectable.

Skills are explicit runtime capabilities, not implicit context. Repository
skills live in `config/repositories.yaml` and are resolved relative to the
prepared repository root. Agent skills live in `agents/<id>/agent.yaml` and are
resolved relative to the agent directory. Luna materializes repository skills
first, then agent skills, dedupes the same resolved file, and rejects duplicate
skill `name` values from different files.

Every run writes artifacts under:

```text
<app.artifacts.root>/<workflow-id>/<run-id>/
```

Common artifacts include `run.json`, `events.jsonl`,
`observability-summary.json`, intermediate node outputs, and final reports.

Write-mode repositories must declare `expected_remote_urls`; Luna checks the
configured git remote before creating an implementation worktree.

## Configuration

Core config lives in `config/`:

- `app.yaml`: workspace and artifact locations.
- `repositories.yaml`: repositories Luna may inspect or edit.
- `routing.yaml`: deterministic routing rules.
- `models.yaml`: reusable model profiles.
- `mcp.yaml`: MCP server policy and allowlists.
- `jira.yaml`: Jira instance and repository hint field mapping.
- `plane.yaml`: Plane instance and repository hint label mapping.
- `implementation.yaml`: write-mode branch, validation, commit, push, and draft
  PR gates.

Secrets are not committed:

- `auth.json` is created by `npx @earendil-works/pi-ai login openai-codex`.
- `luna.auth.json` stores Jira credentials keyed by `config/jira.yaml`
  instance id and Plane API keys keyed by `config/plane.yaml` instance id.

## Bundled Base

These are the adapters, workflows, agents, built-ins, tools, and skills that
ship with the repo. Treat them as starter parts and authoring examples.

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

## Guides

- [Architecture deep dives](docs/README.md)
- [Examples index](examples/README.md)
- [Run a GitHub PR review](examples/review-pr.md)
- [Implement a Jira task](examples/implementation-jira-task.md)
- [Configured workflows reference](examples/configured-workflows.md)
- [Create a new workflow](examples/new-workflow.md)
- [Create a new agent](examples/new-agent.md)
- [Create a new input adapter](examples/new-adapter.md)
- [Create a new built-in step](examples/new-built-in.md)
- [Create a new local tool](examples/new-tool.md)

## Troubleshooting

`Repository is not configured: github/org/repo`

The PR URL owner/name does not match `config/repositories.yaml`, or the
repository entry is missing.

`gh` cannot read the PR

Run `gh auth status` and confirm the authenticated account has access to the
repository.

`auth.json` is missing

Run `npx @earendil-works/pi-ai login openai-codex` from the Luna project root.

`luna.auth.json` is missing

Create `luna.auth.json` in the Luna project root with credentials for the
instance id used in `config/jira.yaml` or `config/plane.yaml`.

`expected_remote_urls_missing`

The `implementation` workflow is a write-mode workflow. Add
`expected_remote_urls` to the matching repository entry.

`Unknown input adapter`

The value passed to `--from` is not registered in `src/adapters/registry.ts`.

## Development

```bash
npm test
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
npm run build
npm run flue:build
```

## Principles

- Workflow graphs over workflow-specific code.
- Deterministic routing.
- Reusable agents; orchestration in workflow graphs.
- Explicit context intake.
- Artifacts as part of the runtime contract.
- Runtime adapters at the boundary, not spread through core modules.
