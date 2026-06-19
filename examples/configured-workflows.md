# Configured Workflows

Luna exposes one generic Flue workflow entrypoint named `luna`.

Review a GitHub pull request URL through the configured workflow selected by
`config/routing.yaml`:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- review-pr https://github.com/org/repo/pull/123
```

This adapter loads PR metadata through `gh api`, builds the normalized Luna
invocation, validates it, and then invokes the generic Flue workflow. The lower
level `run --input <path>` command still exists for tests and automation that
already produce a normalized invocation file.

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

The only Flue workflow entrypoint is `luna`; workflow selection happens through
configuration and routing.
