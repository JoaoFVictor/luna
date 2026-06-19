# Luna

Local-first multi-agent workflow orchestration built on Flue.

Luna is a base repository for running configurable agent workflows locally. It
uses Flue for the workflow and agent abstraction, while keeping routing, input
adapters, repository access, workspaces, model profiles, and artifacts under
your control.

The first bundled workflow is GitHub PR code review. Luna is not meant to be
only a code review tool; code review is the first concrete workflow used to
prove the architecture.

## What You Can Do Today

- Run the bundled `code-review` workflow against a GitHub PR URL.
- Review private repositories through `gh` plus a local git clone.
- Configure model profiles once and reuse them across agents.
- Add new read-only agents with YAML, Markdown instructions, and JSON Schema.
- Add new workflows with YAML graphs when they can reuse Luna's current
  read-only git built-ins.
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

`config/models.yaml` uses generic model profiles such as `default`, `deep`,
`fast`, and `balanced`. Agents reference these profiles by name.

By default, Luna uses Pi's `openai-codex/...` provider. Running
`npx @earendil-works/pi-ai login openai-codex` writes `auth.json` in the project
directory. Luna reads that file at runtime and registers the provider with Flue.
Do not commit `auth.json`.

## Current Inventory

Input adapters:

- `github-pr-url`

Workflows:

- `code-review`

Agents:

- `review-planner`
- `code-reviewer`
- `acceptance-reviewer`

Built-in steps:

- `preflight`
- `prepare_worktree`
- `collect_repo_context`
- `validate_code_review_findings`
- `final_code_review_report`

## Guides And Examples

- [Run a GitHub PR review](examples/review-pr.md)
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
