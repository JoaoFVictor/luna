# Workflow Runtime Config

Workflow runtime config is the generic way for a workflow to receive operator
settings at run time. It replaces workflow-specific runtime branches such as
"if this is code-review, load this file".

The workflow owns the contract. The runtime only loads, validates, and exposes
the declared config as `$.config`.

## Contract

A workflow that needs config declares it in `workflows/<id>/workflow.yaml`:

```yaml
config:
  file: code-review.yaml
  schema: config.schema.json
```

That means:

- `file` is resolved under `config/`.
- `schema` is resolved inside the workflow directory.
- the YAML file is validated with that JSON Schema before execution.
- the validated value is exposed to workflow expressions as `$.config`.
- workflows without `config` receive an empty config object, `{}`.

The runtime does not infer the file from the workflow id. The file name is part
of the workflow declaration.

## File Layout

```text
workflows/<id>/
  workflow.yaml
  input.schema.json
  output.schema.json
  config.schema.json

config/
  <workflow-config>.yaml
```

Example:

```text
workflows/code-review/
  workflow.yaml
  config.schema.json

config/
  code-review.yaml
```

## Complete Code Review Example

`workflows/code-review/workflow.yaml` declares the config file and schema:

```yaml
id: code-review
type: workflow
mode: read_only
input_schema: input.schema.json
output_schema: output.schema.json
config:
  file: code-review.yaml
  schema: config.schema.json
```

`config/code-review.yaml` contains operator-controlled values:

```yaml
code_review:
  review_dimensions:
    - correctness
    - security
    - architecture
    - reuse_existing_components
  pull_request_review:
    enabled: false
    provider: github
    event: auto
    inline_comments: true
```

`workflows/code-review/config.schema.json` validates that shape. Keep the
schema in the workflow directory as the source of truth; operational fields are
documented in [configuration-reference.md](configuration-reference.md).

Minimal schema example:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["code_review"],
  "properties": {
    "code_review": {
      "type": "object",
      "additionalProperties": false,
      "required": ["pull_request_review"],
      "properties": {
        "review_dimensions": {
          "type": "array",
          "items": { "type": "string", "minLength": 1 }
        },
        "pull_request_review": {
          "type": "object",
          "additionalProperties": false,
          "required": ["enabled", "provider", "event", "inline_comments"],
          "properties": {
            "enabled": { "type": "boolean" },
            "provider": { "type": "string", "minLength": 1 },
            "event": {
              "enum": ["auto", "comment", "request_changes", "approve"]
            },
            "inline_comments": { "type": "boolean" }
          }
        }
      }
    }
  }
}
```

Workflow nodes read values through expressions:

```yaml
input:
  enabled:
    expression: "$.config.code_review.pull_request_review.enabled"
  provider_id:
    expression: "$.config.code_review.pull_request_review.provider"
  event:
    expression: "$.config.code_review.pull_request_review.event"
  inline_comments:
    expression: "$.config.code_review.pull_request_review.inline_comments"
  comment_policy:
    expression: "$.config.code_review.pull_request_review.comment_policy"
  acceptance:
    expression: "$.steps.acceptance"
```

For PR reviews, `auto` is the safest operational default: it uses the
structured acceptance result with safe downgrades. Accepted reviews without
findings publish an approval, rejected reviews with validated findings or
blocking reasons request changes, and uncertain reviews publish a regular
review `comment`. A configured `request_changes` is also downgraded to
`comment` when there are no findings or blocking reasons, and a configured
`approve` is downgraded to `comment` when findings or rejection exist.

The optional `acceptance` input lets the provider-neutral
`pull-request-review.publish` built-in render a clear review result in the PR
body: `approved`, `changes requested`, `not accepted`, or
`needs human review`. `body` remains the fallback for workflows that only have a
plain summary.

## New Workflow Checklist

Use this when adding runtime settings to another workflow:

1. Add `config:` to `workflows/<id>/workflow.yaml`.
2. Add `workflows/<id>/config.schema.json`.
3. Add the matching YAML file under `config/`.
4. Pass config into nodes with `$.config...` expressions.
5. Add focused tests for definition loading and runtime config loading.
6. Update the workflow recipe or example that operators will read.

Minimal example:

```yaml
# workflows/my-workflow/workflow.yaml
config:
  file: my-workflow.yaml
  schema: config.schema.json
```

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["my_workflow"],
  "properties": {
    "my_workflow": {
      "type": "object",
      "additionalProperties": false,
      "required": ["enabled"],
      "properties": {
        "enabled": { "type": "boolean" }
      }
    }
  }
}
```

```yaml
# config/my-workflow.yaml
my_workflow:
  enabled: true
```

```yaml
input:
  enabled:
    expression: "$.config.my_workflow.enabled"
```

## Ownership

Workflow runtime config belongs to the workflow authoring surface:

- workflow declaration: `workflows/<id>/workflow.yaml`
- config schema: `workflows/<id>/config.schema.json`
- operator values: `config/<file>.yaml`
- consumption: workflow expressions under `$.config`

Capability modules should receive resolved values through built-in input.
Provider modules should receive resolved values through provider-neutral ports.
Agents should receive only the config-derived values that the workflow chooses
to pass in their input.

## Anti-Patterns

Do not:

- add `if workflow.id === "..."` config branches in runtime code.
- add CLI commands for one workflow's config.
- read `config/*.yaml` directly inside agents.
- import workflow config schemas into provider-neutral capability modules.
- put provider auth, payload, or API details in workflow config schemas.
- use workflow config to bypass side-effect policies.
- rely on defaults that are not represented in the schema or workflow input.

## Current Bundled Configs

| Workflow | Config file | Schema |
| --- | --- | --- |
| `code-review` | `config/code-review.yaml` | `workflows/code-review/config.schema.json` |
| `implementation` | `config/implementation.yaml` | `workflows/implementation/config.schema.json` |
