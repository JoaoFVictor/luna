# Create a new local tool

Local tools are deterministic Luna-native TypeScript functions that can be
materialized for the current agent runtime. Use a tool when an agent needs a
small, explicit capability such as reading git status, summarizing a diff, or
querying a local system through controlled code.

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
- declares explicit safety metadata.

Start with the most conservative safety metadata:

```yaml
safety:
  localWrites: false
  network: false
  externalSideEffects: false
```

Read-only agents may use non-writing tools when the agent declares them.
Subagents do not receive local tools; use a trusted write subagent with an
explicit `policy.allow_tools` list or a workflow graph node when delegated work
needs tools.

Current examples live in `src/core/tools/repository.ts`.

## 2. Implement the Luna tool

Add the implementation to an existing file under `src/core/tools/` or create a
new domain file there:

```ts
import * as v from "valibot";
import { runGit } from "../git.js";
import type { LunaToolDefinition } from "./contracts.js";

const emptyParameters = v.object({});

export const repositoryLastCommitTool: LunaToolDefinition<
  v.InferOutput<typeof emptyParameters>,
  string
> = {
  id: "repository.last-commit",
  description: "Return the latest git commit summary for the bound worktree.",
  parameters: emptyParameters,
  safety: {
    localWrites: false,
    network: false,
    externalSideEffects: false
  },
  modes: ["read_only", "trusted_host_local_write"],
  createHandler: ({ cwd }) =>
    async () => await runGit(cwd, ["log", "-1", "--oneline"])
};
```

The id used in `agent.yaml` can contain dots, such as
`repository.last-commit`. Luna converts it to a model-facing Flue tool name at
the runtime adapter boundary, such as `repository_last_commit`.

## 3. Register the tool

Add it to `src/core/tools/catalog.ts`:

```ts
import { repositoryLastCommitTool } from "./repository.js";

export const lunaToolCatalog = {
  [repositoryLastCommitTool.id]: repositoryLastCommitTool
};
```

Use `read_only` only when the tool is safe for read-only agents. Reserve
`trusted_host_local_write` for tools that are useful only inside a trusted local
write worktree. Do not import `@flue/runtime` or call `defineTool` from
`src/core/tools/**`; `src/core/agent-runtime/flue/tool-registry.ts` owns that
adapter boundary.

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
rtk npm test -- tests/core/flue-tool-registry.test.ts tests/core/flue-agent-capabilities.test.ts
rtk npm test -- tests/core/flue-modules.test.ts
rtk npm run typecheck
```

## 6. Document public tools

If the tool is meant to be reused by future agents, update:

- `README.md` current inventory or agent capability notes;
- `examples/configured-workflows.md`;
- the agent guide if it changes the expected authoring pattern.
