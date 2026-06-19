# Luna

Local-first multi-agent workflow orchestration built on Flue.

Luna is an experimental base repository for running configurable agent
workflows locally. It uses Flue for the workflow and agent abstraction, while
keeping routing, input adapters, repository access, workspaces, model profiles,
and artifacts under your control.

The first bundled workflow is GitHub PR code review. The project is not meant to
be only a code review tool; code review is the first concrete workflow used to
prove the architecture.

## Why

- Run multi-agent workflows locally.
- Keep workflow shape in YAML instead of workflow-specific TypeScript.
- Add input sources through adapters instead of one-off CLI commands.
- Reuse generic model profiles across agents.
- Review GitHub PRs through local git worktrees.
- Preserve auditable run artifacts for debugging and iteration.
- Avoid depending on Cloudflare-hosted infrastructure.

## Status

Luna is early and intentionally small. The current focus is a local,
read-only GitHub PR code review workflow.

Current input adapter:

- `github-pr-url`

Current workflow:

- `code-review`

## How It Works

```text
input adapter -> normalized invocation -> router -> workflow YAML -> agents -> artifacts
```

There is one generic Flue workflow entrypoint: `luna`. Workflow selection happens
through invocation data and routing, not by creating a new TypeScript entrypoint
for each workflow.

## Quick Start

Install dependencies:

```bash
npm install
```

Configure the local repository Luna can inspect:

```yaml
# config/repositories.yaml
repositories:
  - id: example
    provider: github
    owner: org
    name: repo
    path: /path/to/local/repo
    remote: origin
```

Authenticate the GitHub CLI:

```bash
gh auth status
```

Run the bundled code review workflow from a GitHub PR URL:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow code-review --from github-pr-url https://github.com/org/repo/pull/123
```

The `github-pr-url` adapter fetches PR metadata through `gh api`, builds a
normalized invocation, attaches `workflow: code-review`, and invokes the generic
Flue workflow locally.

## Configuration

Core config lives in `config/`:

- `app.yaml`: workspace and artifact locations.
- `repositories.yaml`: local repositories Luna is allowed to inspect.
- `routing.yaml`: default routing rules.
- `models.yaml`: reusable model profiles such as `default`, `deep`, `fast`, and
  `balanced`.

Agents live in `agents/<agent-id>/`:

- `agent.yaml`: agent metadata and model profile.
- `instructions.md`: agent instructions.
- `output.schema.json`: structured output schema.

Workflows live in `workflows/<workflow-id>/`:

- `workflow.yaml`: workflow metadata.
- `graph.yaml`: nodes and dependencies.
- `input.schema.json`: input contract.
- `output.schema.json`: output contract.

## Project Structure

```text
agents/                 configured agent definitions
config/                 runtime configuration
examples/               usage examples
src/core/               local runtime, routing, adapters, git, artifacts
src/workflows/luna.ts   single generic Flue workflow entrypoint
workflows/              YAML workflow definitions
```

## Built-In Code Review Workflow

The bundled `code-review` workflow is read-only and git-managed. It currently:

1. Validates the invocation and configured repository.
2. Prepares an isolated git worktree.
3. Collects changed files and diff context.
4. Asks a planning agent what to focus on.
5. Asks a reviewer agent for findings.
6. Validates evidence against collected code context.
7. Asks an acceptance agent whether the result matches the requested review.
8. Writes JSON and Markdown artifacts.

Artifacts are written under the configured artifact root, currently
`.runs/code-review`.

## Adding Workflows

For workflows that use existing Luna capabilities, add YAML under
`workflows/<workflow-id>/` and agent definitions under `agents/<agent-id>/`.

No new TypeScript workflow entrypoint is required. TypeScript is only needed when
adding a new built-in capability, a new input adapter, or output schema behavior
outside Luna's supported JSON Schema subset.

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
