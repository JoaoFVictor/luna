# Create a new local tool

Local tools are deterministic TypeScript functions exposed to Flue agents. Use
a tool when an agent needs a small, explicit capability such as reading git
status, summarizing a diff, or querying a local system through controlled code.

Do not use a tool for orchestration. Workflow order belongs in `graph.yaml`.
Do not use a tool for external input normalization. That belongs in an input
adapter.

## 1. Decide the tool boundary

A good local tool:

- has a narrow purpose;
- receives a bound `cwd` from Luna instead of choosing arbitrary paths;
- validates parameters with Valibot;
- returns compact, model-readable output;
- is allowed only for agent modes that should use it.

Current examples live in `src/tools/repository-tools.ts`.

## 2. Implement the Flue tool

Add the implementation to an existing file under `src/tools/` or create a new
domain file there:

```ts
import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { runGit } from "../core/git.js";

export function repositoryLastCommitTool(cwd: string) {
  return defineTool({
    name: "repository_last_commit",
    description: "Return the latest git commit summary for the bound worktree.",
    parameters: v.object({}),
    execute: async () => await runGit(cwd, ["log", "-1", "--oneline"])
  });
}
```

The registry id used in `agent.yaml` can contain dots, such as
`repository.last-commit`. The Flue tool name should be model-facing and safe,
such as `repository_last_commit`.

## 3. Register the tool

Add it to `src/core/flue-tool-registry.ts`:

```ts
import { repositoryLastCommitTool } from "../tools/repository-tools.js";

const toolRegistry: Record<string, RegisteredTool> = {
  "repository.last-commit": {
    factory: repositoryLastCommitTool,
    allowedAgentModes: ["read_only", "trusted_host_local_write"],
    safety: {
      writes: false,
      network: false,
      side_effects: false,
      subagent_read_only_allowed: true
    }
  }
};
```

Use `read_only` only when the tool is safe for read-only agents. Reserve
`trusted_host_local_write` for tools that are useful only inside a trusted local
write worktree. `subagent_read_only_allowed` must be explicit; leave it `false`
unless the tool is deterministic, local, non-writing, non-networked, and safe
inside a read-only subagent profile.

## 4. Attach the tool to an agent

In `agents/<agent-id>/agent.yaml`:

```yaml
tools:
  - repository.last-commit
```

Workflows do not declare tools directly. A workflow selects agents; agents bring
their own tools.

## 5. Test the registry behavior

Update `tests/core/flue-tool-registry.test.ts`:

```ts
const tools = resolveFlueTools({
  ids: ["repository.last-commit"],
  agentMode: "trusted_host_local_write",
  cwd: "/repo/worktree"
});

expect(tools.map((tool) => tool.name)).toEqual([
  "repository_last_commit"
]);
```

Also test execution with the underlying dependency mocked, and test mode
restrictions if the tool is not allowed in every agent mode.

Useful commands:

```sh
npm test -- tests/core/flue-tool-registry.test.ts tests/core/flue-agent-capabilities.test.ts
npm test -- tests/core/flue-modules.test.ts
npm run typecheck
```

## 6. Document public tools

If the tool is meant to be reused by future agents, update:

- `README.md` current inventory or agent capability notes;
- `examples/configured-workflows.md`;
- the agent guide if it changes the expected authoring pattern.
