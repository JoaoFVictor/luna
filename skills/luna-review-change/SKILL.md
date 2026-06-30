---
name: luna-review-change
description: Use when reviewing Luna code, documentation, architecture, workflow, agent, adapter, capability, built-in, tool, MCP, subagent, provider, or runtime changes for correctness, boundary clarity, tests, and docs/examples completeness.
---

# Luna Review Change

Review Luna changes as architecture, not just text or code.

## Critical Checks

- No per-workflow TypeScript entrypoints.
- No workflow-specific CLI commands.
- Routing remains deterministic and model-free.
- Workflow YAML uses declared capabilities and explicit side-effect policies.
- Agents stay reusable; orchestration stays in workflow YAML.
- Public built-ins, tools, gates, patterns, ports, publishers, schemas, and
  policies are registered through capability manifests.
- Provider-specific auth/config/schema/URL/payload/report/publish code stays
  under `src/providers/<provider>/`.
- Provider-backed publishing stays provider-neutral at the capability boundary
  and provider-specific at the implementation boundary. Examples:
  `pull-request-review.publish` and `change-request.create`.
- Workflow runtime config is declared with workflow `config.file` and
  `config.schema`; runtime code should not branch on workflow ids. Check
  `docs/workflow-runtime-config.md` when this surface changes.
- Generic core and neutral capabilities do not import provider-specific shapes
  or runtime SDKs.
- Pi/runtime materialization stays under `src/agent-runtimes/pi/**`.
- MCP docs do not imply execution support in Pi.
- Repository tools distinguish read-only tools from trusted write tools.
- Docs/examples/skills are updated when public behavior or authoring paths
  change.
- Path references and ownership claims match the current capability layout.

## Verification

Run focused tests, then:

```bash
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```

For broad changes, also run:

```bash
npm test
npm run build
```
