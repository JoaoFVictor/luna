---
name: luna-create-tool
description: Use when creating or modifying Luna local tools for agents, including capability tool registrations, core tool contracts/resolution, agent.yaml tools entries, mode restrictions, repository-bound cwd behavior, and Pi materialization tests.
---

# Luna Create Tool

Local tools are functions an agent can call during a model session. They are
not workflow nodes.

## Ownership

- Public tool registration belongs in a capability manifest.
- Tool contracts/resolution live under `src/core/tools/**`.
- Domain implementations live with the owning capability, such as
  `src/capabilities/repository/**`.
- Runtime materialization lives under `src/agent-runtimes/<runtime>/`.

Do not register a tool by only adding it to an agent. The id must resolve
through capability registration and the local contract catalog.

## Tool Rules

- Bind execution to the cwd Luna provides.
- Keep filesystem paths inside cwd.
- Validate input and return compact JSON.
- Declare which agent modes may use the tool.
- Keep provider-specific auth/config/payload parsing out of neutral tools.

Repository tools currently include read tools available in both modes and
write/delete tools restricted to `trusted_local_write`.

## Runtime Status

The bundled Pi adapter supports local tools and `tool_calling`. It does not
support MCP tool execution today. Adding MCP execution requires runtime adapter
work, not only config changes.

## Testing

Cover:

- capability registration.
- unknown tool ids.
- mode restrictions.
- cwd path safety.
- Pi materialization if the selected runtime should expose the tool.

Then run:

```bash
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```
