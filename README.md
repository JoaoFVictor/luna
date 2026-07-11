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
- `src/studio/**` and `apps/studio/`: local React control plane for authoring,
  classified configuration, deterministic launch, run inspection, and
  restore-as-draft. See the [Luna Studio guide](docs/studio-guide.md).

Authoring surfaces:

- `workflows/<id>/`: strict YAML DAGs plus input/output JSON schemas.
- `agents/<id>/`: reusable model roles, instructions, output schemas, skills,
  tools, MCP server references, context files, and subagent references.
- `src/capabilities/<capability>/`: public capability manifests plus
  deterministic built-ins, patterns, gates, tools, ports, policies, and tests.
- `src/providers/<provider>/`: provider-owned input adapters, auth/config
  schemas, payload parsing, task/PR context, reports, PR review publishing,
  and change-request actions.
- `src/agent-runtimes/<runtime>/`: concrete agent runtime adapters. The
  bundled runtime is Pi under `src/agent-runtimes/pi/`.
- `config/*.yaml`: app, routing, repositories, model profiles, MCP policy,
  provider/task settings, and workflow-declared runtime config files.

## What Ships

Input adapters are registered through native platform plugins. The concrete
adapters currently live in provider modules:

- `github-pr-url`
- `jira-task-url`
- `plane-task-url`

Workflows:

- `code-review`: repository read-only GitHub PR review with optional
  provider-backed PR review publication.
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
  `change-request.create`, `pull-request-review.publish`,
  `local-exec.command.read`, `local-exec.command.write`, and the
  `repository-change.*` lifecycle built-ins.
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

Prepare Pi OpenAI Codex provider auth in the Luna auth root:

```bash
mkdir -p .luna/auth/pi-ai
# create .luna/auth/pi-ai/auth.json from .luna/auth/pi-ai/auth.example.json
```

For GitHub PR review, authenticate `gh`:

```bash
GH_CONFIG_DIR=.luna/auth/gh gh auth login
GH_CONFIG_DIR=.luna/auth/gh gh auth status
```

Luna uses one auth root. By default it is `./.luna/auth`; override it with
`LUNA_AUTH_ROOT=/path/to/auth-root`. Luna-owned provider credentials and
webhook signing secrets live in `.luna/auth/luna.auth.json`. Pi credentials
live in `.luna/auth/pi-ai/auth.json`. GitHub CLI auth lives in
`.luna/auth/gh`. SSH config and keys for repository remotes live in
`.luna/auth/ssh`. Git commit identity lives in `.luna/auth/git/config`.
Redacted examples are committed under `.luna/auth/`.

Configure a repository in `config/repositories.yaml`:

```yaml
repositories:
  - id: repo
    provider: github
    owner: org
    name: repo
    path: /repositories/repo
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

`code-review` plans review coverage, builds a deterministic related-context
impact graph around the changed files, runs general, security, and architecture
reviewers, merges duplicate findings with deterministic fingerprints and source
provenance, verifies coverage, validates evidence, and can publish the validated
review back to the PR when its workflow config enables PR review publishing:

```yaml
# config/code-review.yaml
code_review:
  pull_request_review:
    enabled: true
    provider: github
    event: auto
    inline_comments: true
```

The bundled config also declares `review_dimensions`, `related_context`, and
inline comment policy. See [configuration-reference.md](docs/configuration-reference.md)
for the complete field contract.

`event` can be `auto`, `comment`, `request_changes`, or `approve`. `auto` uses
the structured acceptance result with safe downgrades: accepted reviews without
findings publish an approval, rejected reviews with validated findings or
blocking reasons request changes, and uncertain reviews publish a regular PR
review comment. The review body includes the acceptance result
(`approved`, `changes requested`, `not accepted`, or `needs human review`) plus
the acceptance summary. Inline comments are created only for validated findings
whose evidence maps to right-side PR diff lines. By default Luna places the
primary evidence inline, deduplicates duplicate comment locations within the
published review, caps inline comments with `max_inline_comments`, and appends
secondary or unplaceable evidence to the review body. This is not cross-run
publication idempotency; a later run can still publish a new review.

Resume a human interrupt:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- resume --target workflow:implementation --thread <run-id> --checkpoint <checkpoint-id> --interrupt <interrupt-id> --decision '{"approved":true}'
```

Run webhook ingress locally:

```bash
redis-server
npm run build
node dist/src/cli.js webhook-server
node dist/src/cli.js webhook-worker
```

Or run the webhook API, worker, Redis, and Luna Studio with Docker Compose:

```bash
export HOST_UID="$(id -u)"
export HOST_GID="$(id -g)"
export LUNA_STUDIO_CHECKOUT_ID="$(pwd -P | sha256sum | cut -c1-24)"
install -d -m 0700 .runs .luna/studio
docker compose up --build
```

To start only the Studio and its storage-permission initializer:

```bash
docker compose up --build studio
docker compose logs studio
```

Open the `Luna Studio:` capability URL printed in the Studio log. Compose
publishes it only at `http://127.0.0.1:43110`; do not remove the loopback IP
from the port mapping while Studio uses local sessions. The container listens
on its bridge wildcard only through the explicit container-mode CLI flag, while
Host and Origin validation remain pinned to the public loopback authority.

The Studio image includes the production React build. Only the `studio`
service mounts `workflows/`, `agents/`, and `config/` read-write so confirmed
authoring changes reach the checkout. Private Studio state persists in
`.luna/studio/`, runtime data remains in `.runs/`, and the SQLite run ledger is
kept in the checkout-scoped `luna-<checkout-id>_luna-studio-state` named volume
at `/var/lib/luna-studio`. `LUNA_STUDIO_CHECKOUT_ID` is also hashed into the
ledger directory, so identities remain isolated even if an override deliberately
points two checkouts at one volume. Use a stable id derived from the physical
checkout path, not its basename. Keeping the database outside the repository
prevents a checkout-controlled leaf from redirecting the SQLite open. Local
non-container runs use `${LUNA_STUDIO_STATE_ROOT}` when set, otherwise the
per-user XDG state directory.

Compose runs Luna as the required numeric `HOST_UID:HOST_GID`. The one-shot
state initializer changes ownership only on the named-volume root, without a
recursive `chown`; bind-mounted `.runs/`, `.luna/studio/`, auth, source, and
repository directories are never re-owned by Compose. They must exist and be
writable by that host identity before startup. A read-only preflight verifies
that `.runs/` and `.luna/studio/` are owned by `HOST_UID` with mode `0700` and
fails instead of repairing them as root. The webhook server and worker keep
their existing read-only `dist/` and `config/` mounts.

The Compose setup mounts `${LUNA_AUTH_ROOT:-./.luna/auth}` at
`/app/.luna/auth` and `${LUNA_REPOSITORIES_ROOT:-./repositories}` at
`/repositories`. Configure repository paths in `config/repositories.yaml` with
container paths such as `/repositories/repo`. Compose exposes
`/app/.luna/auth/git/config` as Git's global config, so commits made by the
worker use the same identity file as local CLI runs. Those mounts are also
available to the Studio process so an explicitly confirmed real Launch can use
the same native model/provider/repository configuration. The Luna checkout's
`.git` directory is separately mounted read-only into Studio for history and
restore-as-draft; the Studio cannot update refs or create commits there. Docker
startup explicitly rejects a linked Git worktree whose `.git` is a gitfile,
because its absolute host gitdir is not valid inside `/app`; use a full clone for
the Compose deployment.
The tracked `repositories/.gitkeep` only guarantees that this bind source
exists in a fresh clone; repository contents remain ignored by Git and excluded
from the image build context.

For a machine-local repository smoke test, keep the committed
`config/repositories.yaml` generic and put real repository wiring in ignored
local files:

```yaml
# docker-compose.override.yml
services:
  webhook-server:
    volumes:
      - ./.luna/local-config/repositories.yaml:/app/config/repositories.yaml:ro
  webhook-worker:
    volumes:
      - ./.luna/local-config/repositories.yaml:/app/config/repositories.yaml:ro
  studio:
    volumes:
      - ./.luna/local-config/repositories.yaml:/app/config/repositories.yaml:ro
```

```bash
# .env
LUNA_REPOSITORIES_ROOT=/path/to/repositories-parent
```

Create `.luna/auth/git/config` from the host machine before running trusted
write workflows in Docker:

```bash
mkdir -p .luna/auth/git
git config --global user.name | xargs -I{} git config -f .luna/auth/git/config user.name "{}"
git config --global user.email | xargs -I{} git config -f .luna/auth/git/config user.email "{}"
```

Configure signing secrets in `.luna/auth/luna.auth.json` under `providers.webhooks` and
send signed requests to `POST /webhooks/:provider`. The HTTP process enqueues
only; the worker routes and executes the workflow asynchronously.

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

Workflows can declare their own runtime config without runtime name checks:

```yaml
config:
  file: code-review.yaml
  schema: config.schema.json
```

The native runtime loads `config/<file>`, validates it with
`workflows/<id>/<schema>`, and exposes the result as `$.config`. New workflows
that need runtime settings should follow this pattern instead of adding
workflow-specific TypeScript branches. See
[Workflow runtime config](docs/workflow-runtime-config.md) for the complete
contract and examples.

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

GitHub uses the `gh` CLI with `GH_CONFIG_DIR` under the Luna auth root. Git
uses `.luna/auth/git/config` for commit identity. Jira, Plane, and webhook
signing secrets read provider credentials from `.luna/auth/luna.auth.json`.
Pi model auth lives in `.luna/auth/pi-ai/auth.json`.

Provider code belongs under `src/providers/<provider>/`. Generic core and
capability code must not validate or import provider-specific auth, config,
URL, SDK, or payload shapes. Composition happens in platform/plugin roots.
Provider-backed publishing is exposed through provider-neutral capabilities,
such as `pull-request-review.publish` and `change-request.create`, while the
GitHub API/CLI details remain under `src/providers/github/**`.

## Documentation

- [Architecture overview](docs/README.md)
- [Workflows and artifacts](docs/workflows-and-artifacts.md)
- [Workflow runtime config](docs/workflow-runtime-config.md)
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
