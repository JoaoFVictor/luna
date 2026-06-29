# Create A New Workflow

Workflows are YAML DAGs under `workflows/<id>/`. Luna keeps one generic
TypeScript entrypoint at `src/workflows/luna.ts`; do not add per-workflow
TypeScript files.

For runnable references, inspect:

- `workflows/example-minimal-agent/`
- `workflows/example-complete-agent/`
- `workflows/code-review/`
- `workflows/implementation/`

## 1. Create Files

```text
workflows/my-workflow/
  workflow.yaml
  input.schema.json
  output.schema.json
  config.schema.json   # optional, only if workflow.yaml declares config

config/
  my-workflow.yaml      # optional, matching workflow.yaml config.file
```

## 2. Write The YAML

```yaml
id: my-workflow
type: workflow
mode: read_only
input_schema: input.schema.json
output_schema: output.schema.json
config:
  file: my-workflow.yaml
  schema: config.schema.json
capabilities:
  - runtime
  - repository-workspace
  - repository-diff
  - context
  - agents
  - artifacts
  - reports
requires:
  repository: true
execution:
  max_concurrency: 2
  lock_timeout_ms: 120000
nodes:
  - id: preflight
    type: built_in
    uses: runtime.preflight
    artifacts:
      - path: preflight.json
        publisher: artifacts.manifest_publisher
        source:
          expression: "$.steps.preflight"
        format: json

  - id: workspace
    type: built_in
    uses: repository-workspace.capture
    policies:
      - uses: repository-workspace.capture_policy
        config:
          operation_id: repository-workspace.capture
    artifacts:
      - path: workspace.json
        publisher: artifacts.manifest_publisher
        source:
          expression: "$.steps.workspace"
        format: json
    after:
      - preflight

  - id: repo_context
    type: built_in
    uses: repository-diff.collect_context
    artifacts:
      - path: repo-context.json
        publisher: artifacts.manifest_publisher
        source:
          expression: "$.steps.repo_context"
        format: json
    after:
      - workspace

  - id: context
    type: built_in
    uses: context.collect_context
    input:
      agents:
        - my-agent
    artifacts:
      - path: context-intake.json
        publisher: artifacts.manifest_publisher
        source:
          expression: "$.steps.context"
        format: json
    after:
      - workspace

  - id: final_report
    type: built_in
    uses: reports.final_report
    input:
      title: My Workflow
      sections:
        - heading: Repository Context
          content:
            expression: "$.steps.repo_context"
    artifacts:
      - path: final-report.json
        publisher: artifacts.manifest_publisher
        source:
          expression: "$.steps.final_report"
        format: json
      - path: final-report.md
        publisher: artifacts.manifest_publisher
        source:
          expression: "$.steps.final_report.report"
        format: markdown
    after:
      - repo_context
      - context
```

Rules:

- Directory name and workflow `id` must match.
- Unknown fields fail.
- `capabilities:` uses unqualified capability ids.
- `uses:` values are namespaced capability ids.
- Side-effecting built-ins need matching `policies:`.
- Dynamic state references use `{ expression: "..." }`.
- Plain strings are literals.
- `config:` is optional. Add it only when the workflow needs runtime config.

## 3. Add Agents When Needed

Agent nodes reference `agents/<id>/` definitions:

```yaml
- id: review
  type: agent
  agent: my-agent
  output_schema: output.schema.json
  input:
    invocation:
      expression: "$.invocation"
    context:
      expression: "$.steps.context"
  after:
    - context
```

Workflows that want repository or agent context must run
`context.collect_context` and pass `$.steps.context` explicitly.

## 4. Trusted Write Pattern

Trusted write workflows can use:

- `mode: trusted_local_write`
- `repository-change.prepare_worktree`
- `quality-gates.gated_agent_loop`
- `quality-gates.validation_commands`
- `quality-gates.non_empty_diff`
- `quality-gates.agent_review`
- `human_gate` with `hitl.approval`
- `hitl.require_approval`
- `git.commit`
- `git.push_branch`
- `change-request.create`

Use `workflows/implementation/workflow.yaml` as the reference. Gate policy
belongs on the pattern node; writer/reviewer agents remain reusable.

## 5. Schemas And Output

`input.schema.json` documents accepted invocation input. `output.schema.json`
validates final workflow output, which is derived from terminal nodes.

Agent structured output schemas remain owned by agents unless the workflow uses
a capability-provided schema.

If the workflow declares `config:`, `config.schema.json` validates the matching
YAML file under `config/`. The runtime exposes the parsed value as `$.config`:

```yaml
input:
  enabled:
    expression: "$.config.my_workflow.enabled"
```

Do not add workflow-specific runtime loaders or CLI commands for config.
See [Workflow runtime config](../docs/workflow-runtime-config.md) for the full
file layout, schema/value examples, ownership rules, and anti-patterns.

## 6. Run

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:my-workflow --input path/to/invocation.json
```

Or use an adapter:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:my-workflow --from github-pr-url https://github.com/org/repo/pull/123
```

## 7. Test

Run focused workflow definition/compiler/runner tests, then:

```bash
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```
