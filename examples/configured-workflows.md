# Configured Workflows

Luna exposes one generic Flue workflow entrypoint named `luna`.

Run the configured workflow selected by `config/routing.yaml`:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --input examples/github-pr-opened.invocation.json
```

To add a workflow that uses existing Luna capabilities, add YAML under
`workflows/<workflow-id>/` and agents under `agents/<agent-id>/`.

No TypeScript entrypoint is required for a new YAML workflow. TypeScript is
required only when adding a new built-in capability.

The compatibility workflow `code-review` remains available while existing
integrations migrate to `luna`.
