# Built-Ins, Tools, And Runtime

This document explains deterministic workflow steps, local tools, write-mode
services, provider-facing built-ins, and the current Flue runtime adapter.

## Built-Ins

Built-ins are deterministic workflow nodes. They are TypeScript steps registered
in the built-in registry and referenced by YAML workflow graphs.

A built-in owns:

- a stable name.
- input handling for one deterministic operation.
- output data for later workflow nodes.
- scheduling metadata.

Built-in metadata is part of the runtime contract. It tells the scheduler
whether a step requires a repository, captures a workspace, needs repository
locks, participates in implementation lifecycle evidence, or should be deferred
until final-report time.

Use metadata instead of ad hoc name checks. If scheduler behavior changes based
on a built-in, the built-in metadata should say so.

## Runtime-Neutral And Provider-Facing Built-Ins

Runtime-neutral built-ins live under `src/core/built-ins/`. They should not
know provider auth, provider payload shapes, provider URLs, or Flue details.

Provider-facing built-ins are composed through
`src/core/providers/built-ins.ts`. That composition root can dispatch to
provider-owned code under `src/providers/<provider>/` based on
`invocation.source`.

For example, source providers can render task context or final reports in their
own format while keeping the generic workflow graph stable.

## Built-In Categories

The current built-ins fall into these categories:

- preflight and repository preparation.
- context collection.
- code review repository context and report generation.
- implementation worktree creation.
- task context collection for source providers.
- validation command execution.
- implementation validation and acceptance evidence.
- worktree diff collection.
- commit, push, and change-request gates.
- final reports.

The exact inventory is listed in `README.md` and
`examples/configured-workflows.md`, and is checked against the runtime catalog
by the docs drift guardrail.

## Local Tools

Local tools are different from built-ins. A built-in is a workflow node. A
local tool is a small function an agent can call inside its model session.

Local tool contracts live in `src/core/tools/contracts.ts`. The catalog lives
in `src/core/tools/catalog.ts`. Flue materialization lives only in
`src/core/agent-runtime/flue/tool-registry.ts`.

A tool definition includes:

- id and description.
- input schema.
- safety metadata.
- allowed agent modes.
- a handler factory bound to a cwd.

The current repository tools are read-only. They run from the prepared
repository or workspace cwd and expose focused git inspection to agents.

Tools do not orchestrate workflows, normalize external inputs, choose
providers, or call Flue directly.

## MCP Tools

MCP servers are configured in `config/mcp.yaml`. Luna reads server URLs and
headers from environment variables, enforces `allowed_agent_modes`, filters
configured `allowed_tools`, adapts tool names for the model, and returns a
close hook for open connections.

Agent config references MCP server ids. Workflows do not attach MCP tools
directly.

## Write-Mode Services

Trusted local write behavior is split between workflow graphs, built-ins,
agent mode, and write-mode services.

Write-mode services under `src/core/write-mode/` handle branch naming,
worktree creation, git safety gates, lifecycle evidence, cleanup decisions, and
append-only transaction journals.

Important safety checks include:

- repository entries must declare `expected_remote_urls`.
- the configured remote URL must match the allowlist.
- base ancestry is checked before write work begins.
- commit, push, and change-request publishing are separate gates.
- staging uses literal pathspecs.
- rollback journals are append-only.
- failed validation, failed acceptance, disabled publishing, or publish failure
  can preserve the worktree for inspection.

Agents should edit the worktree during trusted loops. They should not commit,
push, or open change requests themselves. Deterministic built-ins own those
publishing gates.

The default change-request provider is GitHub through provider-owned actions
and the GitHub CLI.

## Flue Runtime Adapter

The current runtime adapter lives in `src/core/agent-runtime/flue/`. It is the
only place that should know how to materialize Luna runtime concepts into Flue.

It owns:

- the generic `luna` Flue workflow factory.
- model profile projection.
- Pi OAuth provider registration.
- Flue agent sessions.
- local tool materialization.
- MCP materialization.
- subagent profiles.
- prompt retry policy.
- usage and log bridging.
- trusted local gated loop execution.

It does not own:

- generic workflow definitions.
- generic built-in contracts.
- provider schemas.
- provider auth.
- routing policy.
- repository configuration semantics.

Model profiles live in `config/models.yaml`. Agents reference model profile
names; transport settings belong in model profiles, not in agent instructions
or workflow graphs.

## What This Layer Does

- Gives workflows deterministic TypeScript steps.
- Gives agents small explicit local tools.
- Keeps provider-specific built-ins behind provider composition.
- Keeps trusted write mutation behind deterministic services and gates.
- Keeps Flue-specific materialization out of generic core modules.

## What This Layer Does Not Do

- It does not ask models to decide deterministic workflow behavior.
- It does not put provider-specific auth in generic built-ins.
- It does not register tools outside `src/core/tools/catalog.ts`.
- It does not let read-only workflows use write lifecycle built-ins.
- It does not make prompt replay safe for trusted local writes.

## Source Map

- Built-in contracts: `src/core/built-ins/types.ts`
- Built-in catalog: `src/core/built-ins/catalog.ts`
- Built-in metadata: `src/core/built-ins/metadata.ts`
- Implementation built-ins: `src/core/built-ins/implementation.ts`
- Provider built-in composition: `src/core/providers/built-ins.ts`
- Provider-owned implementations: `src/providers/<provider>/`
- Tool contracts: `src/core/tools/contracts.ts`
- Tool catalog: `src/core/tools/catalog.ts`
- Repository tools: `src/core/tools/repository.ts`
- Flue tool registry: `src/core/agent-runtime/flue/tool-registry.ts`
- Flue runner: `src/core/agent-runtime/flue/runner.ts`
- Flue model options: `src/core/agent-runtime/flue/model-options.ts`
- Flue observability: `src/core/agent-runtime/flue/observability.ts`
- Write-mode services: `src/core/write-mode/`
- Provider change-request actions:
  `src/providers/<provider>/change-request/`

Useful tests include `tests/core/built-ins-registry.test.ts`,
`tests/core/built-ins-implementation.test.ts`,
`tests/core/flue-tool-registry.test.ts`,
`tests/core/flue-agent-capabilities.test.ts`,
`tests/core/flue-gated-agent-loop-runner.test.ts`,
`tests/core/flue-gated-agent-loop-retry.test.ts`,
`tests/core/flue-model-options.test.ts`, `tests/core/observability.test.ts`,
implementation git action tests, `tests/core/workspace-lifecycle.test.ts`,
and `tests/core/workflow-execution-policy.test.ts`.
