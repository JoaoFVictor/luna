# Luna

Local-first multi-agent workflow orchestration built on Flue.

Luna is a base repository for running configurable agent workflows locally. It
uses Flue for the workflow and agent abstraction, while keeping routing, input
adapters, repository access, workspaces, model profiles, and artifacts under
your control.

The bundled workflows cover GitHub PR code review and Jira-driven
implementation. Luna is not meant to be only a code review tool; code review
was the first concrete workflow used to prove the architecture.

## What You Can Do Today

- Run the bundled `code-review` workflow against a GitHub PR URL.
- Run the bundled `implementation` workflow against a Jira task URL.
- Review private repositories through `gh` plus a local git clone.
- Implement Jira tasks in a managed write worktree through a trusted local
  agent mode.
- Configure model profiles once and reuse them across agents.
- Add new agents with YAML, Markdown instructions, JSON Schema, and explicit
  read/write modes.
- Add new workflows with YAML graphs when they can reuse Luna's current
  git built-ins.
- Add new input sources by implementing CLI adapters selected with `--from`.
- Inspect every run through local artifacts under `.runs/`.
- Inspect runtime events and prompt usage through local observability artifacts.

## Quick Start

Install dependencies:

```bash
npm install
```

Authenticate Pi's OpenAI Codex provider with your ChatGPT Plus or Pro
subscription:

```bash
npx @earendil-works/pi-ai login openai-codex
```

Authenticate GitHub CLI:

```bash
gh auth status
```

Clone the repository you want Luna to inspect:

```bash
git clone git@github.com:org/repo.git /path/to/local/repo
```

Configure the repository you want Luna to inspect in `config/repositories.yaml`:

```yaml
repositories:
  - id: repo
    provider: github
    owner: org
    name: repo
    path: /path/to/local/repo
    remote: origin
```

Run a PR review:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:code-review --from github-pr-url https://github.com/org/repo/pull/123
```

Run a Jira implementation task:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:implementation --from jira-task-url https://company.atlassian.net/browse/ABC-123
```

Open the generated report:

```text
.runs/code-review/<run-id>/final-report.md
.runs/implementation/<run-id>/final-report.md
```

For complete walkthroughs, see:

- [Run a GitHub PR review](examples/review-pr.md)
- [Implement a Jira task](examples/implementation-jira-task.md)

## Core Concepts

- **Input adapter**: converts an external input, such as a GitHub PR URL, into
  Luna's normalized invocation format.
- **Invocation**: the normalized request Luna routes and passes into a workflow.
- **Router**: chooses the workflow from `--target workflow:<id>`, the
  invocation `target`, or `config/routing.yaml`.
- **Workflow**: a YAML graph of ordered nodes under `workflows/<workflow-id>/`.
- **Agent**: a configured Flue agent under `agents/<agent-id>/`, with YAML
  metadata, Markdown instructions, and a JSON Schema output contract.
- **Built-in step**: TypeScript runtime capability, such as preparing a git
  worktree or collecting repository context, that a YAML workflow can call.
- **Trusted local write mode**: `trusted_host_local` workflow sandbox plus a
  `trusted_host_local_write` agent. This is trusted-operator mode for local
  writes, not a sandbox security boundary.
- **Artifact**: a JSON, Markdown, or JSONL file written for a run under
  `.runs/`.

## How Luna Works

```text
input adapter -> normalized invocation -> router -> workflow graph -> built-ins/agents/agent loops -> artifacts
```

There is one generic Flue workflow entrypoint: `luna`.

Workflow selection happens through `--target workflow:<id>`, an invocation
`target`, or `config/routing.yaml`. URL adapters omit `target` unless the CLI
override is used. You do not create a new TypeScript file under
`src/workflows/` for every workflow.

## Agent Capabilities

Agents can declare runtime skills and Luna-native local tools in `agent.yaml`:

```yaml
skills:
  - ../../skills/implementation-safe-git/SKILL.md
tools:
  - repository.status
  - repository.diff-summary
```

Skills are paths to `SKILL.md` files relative to the agent directory. Tools are
IDs resolved through Luna's TypeScript catalog and materialized for the current
agent runtime. Workflows do not declare tools directly; the workflow chooses
agents, and each agent brings its own capabilities.

## MCP Capabilities

Agents can opt into configured MCP servers:

```yaml
mcp_servers:
  - github
```

MCP server policy lives in `config/mcp.yaml`. Secrets stay in environment
variables. `allowed_tools` uses original MCP tool names, such as
`get_pull_request`; Flue exposes them to the model as adapted names like
`mcp__github__get_pull_request`. Luna filters exposed MCP tools through that
allowlist and rejects servers that are not allowed for the agent mode.

## Flue Subagents

Agents can declare other Luna agents as Flue subagents:

```yaml
subagents:
  - change-reviewer
```

String entries use the default read-only policy. Trusted write subagents must be
declared explicitly and only work when the workflow allows write subagents:

```yaml
subagents:
  - id: implementer-helper
    policy:
      mode: trusted_host_local_write
      allow_tools:
        - repository.status
```

The referenced ID must resolve to a valid Luna agent directory under
`agents/<id>/`, including `agent.yaml`, the files referenced by
`instructions_file` and `output_schema`, and a configured `model_profile`.
Flue subagents run inside the parent agent session. They are not workflow graph
nodes and do not create separate Luna artifacts automatically.

Subagents are read-only Flue profiles by default. Luna uses the referenced
agent's description, instructions, model profile, and skills. Read-only
subagents cannot declare local tools, MCP servers, or nested subagents. Trusted
write subagents require both workflow-level
`subagent_policy.allow_write: true` and a per-subagent `policy.allow_tools`
allowlist. Use a workflow graph node when delegated work needs MCP access,
another delegation tree, its own artifact, schema, or workflow gate.

## Project Structure

```text
agents/                 configured agent definitions
config/                 runtime configuration
examples/               usage examples and authoring guide
src/core/               local runtime, routing, adapters, git, artifacts
src/adapters/           input adapters and registry
src/workflows/luna.ts   single generic Flue workflow entrypoint
workflows/              YAML workflow definitions
```

## Configuration

Core config lives in `config/`:

- `app.yaml`: workspace and artifact locations.
- `repositories.yaml`: local repositories Luna is allowed to inspect.
- `routing.yaml`: deterministic routing rules.
- `models.yaml`: reusable model profiles.
- `mcp.yaml`: MCP server definitions, tool allowlists, and allowed agent modes.
- `jira.yaml`: Jira instances, repository field mapping, and optional
  acceptance criteria field mapping for the `jira-task-url` adapter.
- `implementation.yaml`: branch naming, validation commands, trusted local
  sandbox settings, and optional commit, push, and draft PR gates for the
  `implementation` workflow.

`config/models.yaml` uses generic model profiles such as `default`, `deep`,
`fast`, and `balanced`. Agents reference these profiles by name.

`config/app.yaml` sets the shared artifact root.

Artifact directories are always resolved as:
`<app.artifacts.root>/<workflow-id>/<run-id>/`

Workflow YAML does not define a separate artifact namespace. The routed
`workflow_id` is the only namespace.

Workflow nodes write explicit artifact plans:

```yaml
artifacts:
  - path: output.json
    source: $.steps.node_id
    format: json
    required: true
```

Each run also writes Luna-owned observability artifacts:

- `run.json`: strict run identity.
- `events.jsonl`: append-only runtime events with stable run/workflow/step ids.
- `observability-summary.json`: derived prompt, token, cost, failure, and
  rejected-capability counters, including prompt usage gaps.

`events.jsonl` is always written and cannot be disabled. Flue receives these
events through an optional log sink when Luna runs inside Flue, but Luna's local
artifacts are the runtime contract. OpenTelemetry, Braintrust, and Sentry are
future exporter targets, not accepted config keys today.

Workflow YAML may configure optional observability exporters and subagent write
policy:

```yaml
observability:
  exporters:
    runtime_log:
      enabled: true
      required: false

subagent_policy:
  allow_write: false
```

`flue_log` is accepted as a legacy Flue runtime alias, but `runtime_log` is the
canonical workflow key.

Workflow YAML may tune scheduler execution:

```yaml
execution:
  max_concurrency: 2
  lock_timeout_ms: 120000
```

`config/app.yaml` may tune local lock storage and stale-lock recovery:

```yaml
locks:
  root: .luna/locks
  timeout_ms: 120000
  stale_after_ms: 600000
```

By default, Luna uses Pi's `openai-codex/...` provider. Running
`npx @earendil-works/pi-ai login openai-codex` writes `auth.json` in the project
directory. Luna reads that file at runtime and registers the provider with Flue.
Do not commit `auth.json`.

Jira credentials live in `luna.auth.json` at the project root. Do not commit
this file. The Jira provider entries are keyed by `config/jira.yaml` instance
id:

```json
{
  "providers": {
    "jira": {
      "company": {
        "base_url": "https://company.atlassian.net",
        "auth_type": "basic_api_token",
        "email": "user@company.com",
        "api_token": "secret-token"
      }
    }
  }
}
```

Write-mode repositories should also declare `expected_remote_urls` in
`config/repositories.yaml`. Luna checks the configured git remote against this
allowlist before creating an implementation worktree:

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
```

`config/implementation.yaml` keeps commit, push, and change request creation
disabled by default. Enabling push requires commit to be enabled, and enabling a
change request requires both commit and push to be enabled. The first supported
change request provider is GitHub, which opens a draft PR. When commit is
disabled, validation fails, acceptance rejects the work, or a git publishing
gate fails, Luna preserves the write worktree so you can inspect or continue the
changes.

## Current Inventory

Input adapters:

- `github-pr-url`
- `jira-task-url`

Workflows:

- `code-review`
- `implementation`

Agents:

- `review-planner`
- `change-reviewer`
- `change-acceptance-reviewer`
- `implementation-planner`
- `code-implementer`

Built-in steps:

- `preflight`
- `prepare_worktree`
- `collect_repo_context`
- `validate_code_review_findings`
- `final_code_review_report`
- `prepare_implementation_worktree`
- `collect_task_context`
- `run_validation_commands`
- `record_implementation_validation`
- `collect_worktree_diff`
- `record_acceptance_decision`
- `commit_changes`
- `push_branch`
- `open_change_request`
- `final_implementation_report`

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

Agent configs reference skills by relative paths to `SKILL.md`, for example
`../../skills/luna-create-agent/SKILL.md`.

## Guides And Examples

- [Run a GitHub PR review](examples/review-pr.md)
- [Implement a Jira task](examples/implementation-jira-task.md)
- [Create a new agent](examples/new-agent.md)
- [Create a new workflow](examples/new-workflow.md)
- [Create a new input adapter](examples/new-adapter.md)
- [Create a new built-in step](examples/new-built-in.md)
- [Create a new local tool](examples/new-tool.md)
- [Configured workflows reference](examples/configured-workflows.md)

Use YAML/config for new agents, new workflow graphs using existing built-ins,
new model profiles, local repository entries, and routing rules.

Use TypeScript for new input adapters, new built-in steps, workspace/repository
behavior, artifact behavior, or JSON Schema features outside Luna's current
supported subset. Built-ins are registered through `src/core/built-ins/catalog.ts`;
workflow YAML can only use names exported by that catalog.

## Troubleshooting

`Repository is not configured: github/org/repo`

The PR URL owner/name does not match `config/repositories.yaml`. Add a matching
entry with `provider: github`, the exact `owner`, the exact `name`, and a valid
local `path`.

`gh` cannot read the PR

Run `gh auth status`. For private repositories, the authenticated GitHub account
needs access to the repo. If git fetch also fails, check SSH or HTTPS git auth
for the local clone.

`auth.json` is missing

Run:

```bash
npx @earendil-works/pi-ai login openai-codex
```

Run it from the Luna project directory so `auth.json` is created where Luna
expects it.

`luna.auth.json` is missing

Create `luna.auth.json` in the Luna project root with Jira credentials for the
instance id used in `config/jira.yaml`.

`expected_remote_urls_missing`

The `implementation` workflow is a write-mode workflow. Add
`expected_remote_urls` to the matching repository entry in
`config/repositories.yaml`.

`Unknown input adapter`

The value passed to `--from` is not registered in `src/adapters/registry.ts`.

## Development

```bash
npm test
npm run typecheck
npm run build
npm run flue:build
```

## Design Principles

- Local-first by default.
- Configuration over workflow-specific code.
- Input adapters are generic and explicit.
- Routing is deterministic where possible.
- Agents own judgment inside their assigned role.
- Artifacts are part of the runtime contract.
- Vendor cloud services are optional, not required infrastructure.
