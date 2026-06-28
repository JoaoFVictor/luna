# Create A New Local Tool

Local tools are deterministic functions an agent can call during a model
session. They are not workflow nodes.

Use a tool when an agent needs a small local capability, such as reading a file
from the bound worktree or summarizing git status. Use a built-in when the
workflow itself needs a deterministic step.

## 1. Pick The Owning Capability

Public tool ids are registered through capability manifests. Domain
implementations live with the owning capability, such as
`src/capabilities/repository/**`.

Core tool code under `src/core/tools/**` provides contracts, resolution, MCP
policy, and catalog mechanics.

Runtime materialization belongs under `src/agent-runtimes/<runtime>/`.

## 2. Define The Contract

A good tool:

- receives a cwd from Luna.
- keeps paths inside that cwd.
- validates JSON input.
- returns compact JSON.
- declares allowed agent modes.
- avoids provider-specific auth/config/payload parsing unless owned by a
  provider-specific capability.

Repository examples:

- `repository.status`, `repository.diff-summary`, `repository.read-file`:
  read-only and trusted write.
- `repository.write-file`, `repository.delete-file`: trusted write only.

## 3. Register The Tool

Add the tool registration to the owning capability manifest and local contract
catalog. The id in `agent.yaml` should match the public id.

```yaml
tools:
  - repository.read-file
```

Workflows do not declare tools directly. Workflows select agents; agents bring
their allowed tools.

## 4. Runtime Notes

The bundled Pi adapter supports local tools and `tool_calling`. It converts ids
such as `repository.read-file` into model-facing names and validates arguments
before calling the handler.

MCP policy exists, but Pi does not execute MCP tools today.

## 5. Test

Cover registration, resolution, mode restriction, cwd/path safety, and runtime
materialization when relevant.

Run:

```bash
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```
