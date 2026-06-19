# Configured Workflows

Luna exposes one generic Flue workflow entrypoint named `luna`.

Run the configured workflow selected by `config/routing.yaml`:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --input examples/github-pr-opened.invocation.json
```

To add a workflow that uses existing Luna capabilities, add YAML under
`workflows/<workflow-id>/` and agents under `agents/<agent-id>/`. When
`LUNA_CONFIG_ROOT` contains `workflows/` or `agents/`, Luna uses those
directories; otherwise it falls back to the repository-level directories.

No TypeScript entrypoint is required for a new YAML workflow. TypeScript is
required only when adding a new built-in capability or an output schema shape
outside Luna's supported JSON Schema subset.

Agent `output.schema.json` files are used at runtime for Flue structured output.
The supported subset covers the schema features used by the bundled agents:
objects, required properties, arrays, strings, numbers, integers, booleans,
string enums, `minLength`, and `minimum`.

The compatibility workflow `code-review` remains available while existing
integrations migrate to `luna`.
