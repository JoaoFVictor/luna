# Configured Workflows

This guide is the practical extension map for Luna. It explains what can be
created with configuration and what still requires TypeScript.

For step-by-step recipes, see:

- [Run a GitHub PR review](review-pr.md)
- [Create a new agent](new-agent.md)
- [Create a new workflow](new-workflow.md)
- [Create a new input adapter](new-adapter.md)

Choose the guide by intent:

- If you only want to use Luna, start with `review-pr.md`.
- If you want a new role in an existing graph, start with `new-agent.md`.
- If you want a new orchestration shape, start with `new-workflow.md`.
- If you want Slack, API events, GitHub issues, or another input source, start
  with `new-adapter.md`.

## Runtime Model

Luna exposes one generic Flue workflow entrypoint named `luna`.

```text
adapter or JSON input -> invocation -> route -> workflow graph -> agents/built-ins -> artifacts
```

The workflow id comes from one of these places:

1. The CLI flag:
   ```bash
   --workflow code-review
   ```
2. The normalized invocation's `workflow` field.
3. `config/routing.yaml`.

The common command shape is:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow <workflow-id> --from <adapter> <value>
```

The lower-level JSON path is useful for tests and automation:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow <workflow-id> --input path/to/invocation.json
```

The current normalized invocation shape is GitHub PR focused. See
`examples/github-pr-opened.invocation.json` for a valid example.

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

Model profiles:

- `default`
- `deep`
- `fast`
- `balanced`

## Adding An Agent

Create:

```text
agents/<agent-id>/
  agent.yaml
  instructions.md
  output.schema.json
```

Minimal `agent.yaml`:

```yaml
id: my-agent
description: Short responsibility statement.
model_profile: default
mode: read_only
instructions_file: instructions.md
output_schema: output.schema.json
```

`instructions.md` should describe only that agent's role. Keep orchestration in
the workflow graph, not inside every agent prompt.

`output.schema.json` is the structured output contract. The current supported
subset covers objects, required properties, arrays, strings, numbers, integers,
booleans, string enums, `minLength`, and `minimum`.

Use capability-based model profiles:

```yaml
model_profile: default
```

Avoid role-based model profiles:

```yaml
model_profile: reviewer
```

The same agent can be reused by multiple workflows as long as its input contract
and instructions make sense in both places.

## Adding A Workflow

Create:

```text
workflows/<workflow-id>/
  workflow.yaml
  graph.yaml
  input.schema.json
  output.schema.json
```

Minimal `workflow.yaml`:

```yaml
id: my-workflow
type: workflow
mode: git_managed_read_only
input_schema: input.schema.json
output_schema: output.schema.json
graph: graph.yaml
```

Minimal `graph.yaml`:

```yaml
nodes:
  - id: preflight
    type: built_in
    uses: preflight
    artifact: preflight.json

  - id: workspace
    type: built_in
    uses: prepare_worktree
    artifact: workspace.json
    after:
      - preflight

  - id: repo_context
    type: built_in
    uses: collect_repo_context
    artifact: repo-context.json
    after:
      - workspace

  - id: my_agent_step
    type: agent
    agent: my-agent
    output_schema: my_output
    artifact: my-agent-output.json
    input:
      invocation: $.invocation
      repo_context: $.steps.repo_context
    after:
      - repo_context
```

Graph validation catches duplicate node ids, unknown dependencies, and cycles.

## Node Types

Built-in node:

```yaml
- id: repo_context
  type: built_in
  uses: collect_repo_context
  artifact: repo-context.json
  after:
    - workspace
```

Agent node:

```yaml
- id: code_review
  type: agent
  agent: code-reviewer
  output_schema: code_review_findings
  artifact: code-review-findings.json
  input:
    invocation: $.invocation
    repo_context: $.steps.repo_context
  after:
    - repo_context
```

`artifact` can be a string or, for built-ins that write multiple files, a map:

```yaml
artifact:
  json: final-report.json
  markdown: final-report.md
```

## Workflow Input References

Node `input` values can reference workflow state:

- `$.invocation`: normalized input from adapter or JSON.
- `$.repository`: matched repository config.
- `$.run`: current run metadata.
- `$.workspace`: git worktree metadata.
- `$.steps.<node-id>`: output from a previous node.

Example:

```yaml
input:
  invocation: $.invocation
  plan: $.steps.review_plan
  findings: $.steps.validate_findings
```

References are whole-value references. Luna does not currently support nested
paths like `$.steps.review_plan.summary`.

## Adding An Input Adapter

Adapters exist so callers do not need to hand-write invocation JSON.

The current adapter command is:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow code-review --from github-pr-url https://github.com/org/repo/pull/123
```

To add a new adapter:

1. Create a module under `src/core/`, for example
   `src/core/slack-message-adapter.ts`.
2. Export a function that receives the external value and returns a normalized
   invocation.
3. Validate external input early.
4. Fetch source metadata using the source's normal tool or API.
5. Parse the result with Luna's `InvocationSchema` or return data that will pass
   it in the CLI.
6. Register the adapter name in `src/core/flue-cli.ts`.
7. Add unit tests for the adapter.
8. Add CLI tests proving `--from <adapter>` dispatches to it.
9. Add docs to `README.md` and this file.

Keep the CLI shape generic:

```bash
run --workflow <workflow-id> --from <adapter> <value>
```

Do not add one-off commands such as:

```bash
review-pr <url>
```

## Adapter Responsibilities

An adapter should:

- Convert source-specific input into Luna's normalized invocation.
- Attach `workflow` only when the source has an explicit deterministic mapping.
- Preserve source metadata that agents may need.
- Return clear errors for invalid input and missing source auth.
- Avoid LLM routing decisions.

An adapter should not:

- Run the workflow directly.
- Create git worktrees.
- Write final artifacts.
- Hide which workflow is being called.

## YAML vs TypeScript

Use YAML/config for:

- New agents.
- New workflow graphs using existing built-ins.
- New model profiles.
- New local repository entries.
- New routing rules.

Use TypeScript for:

- New input adapters.
- New built-in steps.
- New workspace or repository behavior.
- New artifact behavior.
- JSON Schema features outside Luna's supported subset.

## Testing Checklist

For a new agent:

```bash
npm test -- tests/core/agent-definition.test.ts
```

For a new workflow:

```bash
npm test -- tests/core/workflow-definition.test.ts tests/core/configured-workflow-runner.test.ts
```

For a new adapter:

```bash
npm test -- tests/core/cli.test.ts tests/core/github-pr-adapter.test.ts
```

Before finishing a branch:

```bash
npm test
npm run typecheck
npm run build
npm run flue:build
```

## Real Review Checklist

1. Authenticate Pi:
   ```bash
   npx @earendil-works/pi-ai login openai-codex
   ```
2. Authenticate GitHub:
   ```bash
   gh auth status
   ```
3. Clone the target repo locally.
4. Add the repo to `config/repositories.yaml`.
5. Run:
   ```bash
   LUNA_CONFIG_ROOT=config npm run dev -- run --workflow code-review --from github-pr-url https://github.com/org/repo/pull/123
   ```
6. Open `.runs/code-review/<run-id>/final-report.md`.
