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
- Add new read-only agents with YAML, Markdown instructions, and JSON Schema.
- Add new workflows with YAML graphs when they can reuse Luna's current
  git built-ins.
- Add new input sources by implementing CLI adapters selected with `--from`.
- Inspect every run through local artifacts under `.runs/`.

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
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow code-review --from github-pr-url https://github.com/org/repo/pull/123
```

Run a Jira implementation task:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow implementation --from jira-task-url https://company.atlassian.net/browse/ABC-123
```

Open the generated report:

```text
.runs/code-review/<run-id>/final-report.md
```

For the complete walkthrough, see
[examples/review-pr.md](examples/review-pr.md).

## Core Concepts

- **Input adapter**: converts an external input, such as a GitHub PR URL, into
  Luna's normalized invocation format.
- **Invocation**: the normalized request Luna routes and passes into a workflow.
- **Router**: chooses the workflow from `--workflow`, the invocation, or
  `config/routing.yaml`.
- **Workflow**: a YAML graph of ordered nodes under `workflows/<workflow-id>/`.
- **Agent**: a configured Flue agent under `agents/<agent-id>/`, with YAML
  metadata, Markdown instructions, and a JSON Schema output contract.
- **Built-in step**: TypeScript runtime capability, such as preparing a git
  worktree or collecting repository context, that a YAML workflow can call.
- **Trusted local write mode**: `trusted_host_local` workflow sandbox plus a
  `trusted_host_local_write` agent. This is trusted-operator mode for local
  writes, not a sandbox security boundary.
- **Artifact**: a JSON or Markdown file written for a run under `.runs/`.

## How Luna Works

```text
input adapter -> normalized invocation -> router -> workflow YAML -> agents -> artifacts
```

There is one generic Flue workflow entrypoint: `luna`.

Workflow selection happens through the invocation and routing config. You do not
create a new TypeScript file under `src/workflows/` for every workflow.

## Project Structure

```text
agents/                 configured agent definitions
config/                 runtime configuration
examples/               usage examples and authoring guide
src/core/               local runtime, routing, adapters, git, artifacts
src/workflows/luna.ts   single generic Flue workflow entrypoint
workflows/              YAML workflow definitions
```

## Configuration

Core config lives in `config/`:

- `app.yaml`: workspace and artifact locations.
- `repositories.yaml`: local repositories Luna is allowed to inspect.
- `routing.yaml`: deterministic routing rules.
- `models.yaml`: reusable model profiles.
- `jira.yaml`: Jira instances, repository field mapping, and optional
  acceptance criteria field mapping for the `jira-task-url` adapter.
- `implementation.yaml`: branch naming, validation commands, trusted local
  sandbox settings, and optional commit, push, and draft PR gates for the
  `implementation` workflow.

`config/models.yaml` uses generic model profiles such as `default`, `deep`,
`fast`, and `balanced`. Agents reference these profiles by name.

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

`config/implementation.yaml` keeps commit, push, and pull request creation
disabled by default. Enabling push requires commit to be enabled, and enabling a
draft PR requires both commit and push to be enabled. When commit is disabled,
validation fails, acceptance rejects the work, or a git publishing gate fails,
Luna preserves the write worktree so you can inspect or continue the changes.

## Current Inventory

Input adapters:

- `github-pr-url`
- `jira-task-url`

Workflows:

- `code-review`
- `implementation`

Agents:

- `review-planner`
- `code-reviewer`
- `acceptance-reviewer`
- `implementation-planner`
- `code-implementer`
- `implementation-reviewer`
- `implementation-acceptance-reviewer`

Built-in steps:

- `preflight`
- `prepare_worktree`
- `collect_repo_context`
- `validate_code_review_findings`
- `final_code_review_report`
- `prepare_implementation_worktree`
- `collect_task_context`
- `collect_worktree_diff`
- `commit_changes`
- `push_branch`
- `open_pull_request`
- `final_implementation_report`

## Guides And Examples

- [Run a GitHub PR review](examples/review-pr.md)
- [Implement a Jira task](examples/implementation-jira-task.md)
- [Create a new agent](examples/new-agent.md)
- [Create a new workflow](examples/new-workflow.md)
- [Create a new input adapter](examples/new-adapter.md)
- [Configured workflows reference](examples/configured-workflows.md)

Use YAML/config for new agents, new workflow graphs using existing built-ins,
new model profiles, local repository entries, and routing rules.

Use TypeScript for new input adapters, new built-in steps, workspace/repository
behavior, artifact behavior, or JSON Schema features outside Luna's current
supported subset.

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

The value passed to `--from` is not registered in `src/core/flue-cli.ts`.

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
