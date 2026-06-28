# Luna

Luna runs deterministic, inspectable agent workflows from YAML. It turns an
external event or JSON invocation into a routed workflow run, executes
capability-backed nodes and model agents, and writes artifacts that explain
what happened.

```text
input adapter or JSON -> invocation -> deterministic router -> YAML workflow
  -> native platform composition -> runtime scheduler -> artifacts
```

The important design choice is separation. Workflows orchestrate. Agents judge.
Capabilities provide deterministic operations. Providers own source-system
details. Runtime adapters materialize model sessions.

There is one generic TypeScript workflow entrypoint:
`src/workflows/luna.ts`. Add new workflow behavior with `workflows/<id>/`,
agents, capabilities, providers, plugins, and config; do not add one
TypeScript workflow file per workflow.

## Current Shape

Runtime entrypoints:

- `src/cli.ts`: `run` and `resume` commands.
- `src/workflows/luna.ts`: generic workflow entrypoint for programmatic use.
- `src/platform/native/**`: native platform plugin loading, workflow run
  preparation, executor wiring, and resume support.
- `src/runtime/**`: backend composition, LangGraph runtime adapter, scheduler,
  checkpoints, interrupts, artifacts, events, and runtime logs.
- `src/core/observability/**`: telemetry records, spans, sinks, runtime-log
  projection, and summary artifacts.

Authoring surfaces:

- `workflows/<id>/`: strict YAML DAGs plus input/output JSON schemas.
- `agents/<id>/`: reusable model roles, instructions, output schemas, skills,
  tools, MCP server references, context files, and subagent references.
- `src/capabilities/<capability>/`: public capability manifests plus
  deterministic built-ins, patterns, gates, tools, ports, policies, and tests.
- `src/providers/<provider>/`: provider-owned input adapters, auth/config
  schemas, payload parsing, task/PR context, reports, and change-request
  actions.
- `src/agent-runtimes/<runtime>/`: concrete agent runtime adapters. The
  bundled runtime is Pi under `src/agent-runtimes/pi/`.
- `config/*.yaml`: app, routing, repositories, model profiles, MCP policy, and
  provider/task settings.

## What Ships

Input adapters are registered through native platform plugins. The concrete
adapters currently live in provider modules:

- `github-pr-url`
- `jira-task-url`
- `plane-task-url`

Workflows:

- `code-review`: read-only GitHub PR review.
- `implementation`: trusted local write implementation loop for Jira/Plane
  tasks, with validation, reviews, commit, push, and optional
  change-request creation.
- `example-minimal-agent`: smallest runnable agent workflow.
- `example-complete-agent`: fuller authoring example with context, artifacts,
  retry, and gated loop usage.

Official capabilities are registered from `src/capabilities/registry.ts`.
Common public ids include:

- Built-ins: `runtime.preflight`, `context.collect_context`,
  `repository-diff.collect_context`, `repository-workspace.capture`,
  `task-context.collect`, `task-context.final_report`,
  `validation.run_commands`, `findings.validate_evidence`,
  `reports.final_report`, `git.status`, `git.commit`, `git.push_branch`,
  `change-request.create`, `local-exec.command.read`,
  `local-exec.command.write`, and the `repository-change.*` lifecycle
  built-ins.
- Pattern: `quality-gates.gated_agent_loop`.
- Gates: `quality-gates.validation_commands`,
  `quality-gates.agent_review`, `quality-gates.non_empty_diff`,
  `hitl.approval`.
- Local tools: repository tools such as `repository.status`,
  `repository.diff-summary`, `repository.read-file`,
  `repository.write-file`, and `repository.delete-file`.

## Run It

Install dependencies:

```bash
npm install
```

Authenticate the Pi OpenAI Codex provider:

```bash
npx @earendil-works/pi-ai login openai-codex
```

For GitHub PR review, authenticate `gh`:

```bash
gh auth status
```

Configure a repository in `config/repositories.yaml`:

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
    context:
      files:
        - AGENTS.md
        - README.md
```

Run a GitHub PR review:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --from github-pr-url https://github.com/org/repo/pull/123
```

Or force a workflow target:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:code-review --from github-pr-url https://github.com/org/repo/pull/123
```

Run from a normalized invocation JSON:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:code-review --input examples/github-pr-opened.invocation.json
```

Resume a human interrupt:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- resume --target workflow:implementation --thread <run-id> --checkpoint <checkpoint-id> --interrupt <interrupt-id> --decision '{"approved":true}'
```

Run artifacts are written under:

```text
<config/app.yaml artifacts.root>/<workflow-id>/<run-id>/
```

Expect files such as `invocation.json`, `run.json`, `events.jsonl`,
`observability-summary.json`, node artifacts, interrupt records, and final
reports.

## How Routing Works

Routing is deterministic and first-match. The CLI loads an invocation from
`--input` or an adapter from `--from`, optionally stamps `--target`, then
evaluates `config/routing.yaml` with JSONata over `{ invocation }`.

The default routing file keeps explicit targets first, maps GitHub PR events to
`workflow:code-review`, and maps Jira/Plane issue selections to
`workflow:implementation`.

No model chooses a workflow.

## Workflow Rules

Workflow YAML is strict. Unknown fields fail. Capabilities must be declared as
unqualified ids in `capabilities:`. Capability references in nodes are
namespaced ids such as `reports.final_report`.

Supported node types are:

- `built_in`: deterministic capability operation.
- `agent`: one reusable agent call with structured output validation.
- `pattern`: reusable workflow pattern such as
  `quality-gates.gated_agent_loop`.
- `human_gate`: interrupt/resume gate.

Dynamic values are expression objects:

```yaml
input:
  context:
    expression: "$.steps.context"
```

Plain strings are literals, not templates. Final workflow output is derived
from terminal node outputs; there is no separate `output:` mapping in workflow
YAML.

## Context And Skills

Context is explicit. A workflow must run `context.collect_context` and pass its
output to model nodes that need repository or agent guidance. Luna renders
context into runtime instructions and keeps a compact `context_audit` in task
input.

Skills are reusable runtime instructions. Repository skills are configured in
`config/repositories.yaml` and resolve relative to the prepared repository
root. Agent skills are configured in `agents/<id>/agent.yaml` and resolve
relative to the agent directory. Repository skills load first, then agent
skills.

## Provider And Auth Boundaries

GitHub uses the `gh` CLI. Jira and Plane read provider credentials from
`luna.auth.json` under the active config root. Pi model auth is separate and
lives in `~/.config/pi-ai/auth.json`.

Provider code belongs under `src/providers/<provider>/`. Generic core and
capability code must not validate or import provider-specific auth, config,
URL, SDK, or payload shapes. Composition happens in platform/plugin roots.

## Documentation

- [Architecture overview](docs/README.md)
- [Workflows and artifacts](docs/workflows-and-artifacts.md)
- [Agents, context, and skills](docs/agents-context-and-skills.md)
- [Adapters and providers](docs/adapters-and-providers.md)
- [Capabilities, tools, and runtime](docs/built-ins-tools-and-runtime.md)
- [Capabilities reference](docs/capabilities-reference.md)
- [Runtime and observability](docs/runtime-and-observability.md)
- [Configuration reference](docs/configuration-reference.md)
- [Examples index](examples/README.md)
- [Run a GitHub PR review](examples/review-pr.md)
- [Implement a Jira task](examples/implementation-jira-task.md)
- [Implement a Plane task](examples/implementation-plane-task.md)
- [Troubleshooting runs](examples/troubleshooting.md)
- [Create a workflow](examples/new-workflow.md)
- [Create an agent](examples/new-agent.md)
- [Create an adapter](examples/new-adapter.md)
- [Create a built-in](examples/new-built-in.md)
- [Create a local tool](examples/new-tool.md)

## Development

```bash
npm test
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
npm run build
```

For focused work, run the relevant test files first, then the type/unused/lint
checks before finishing.
