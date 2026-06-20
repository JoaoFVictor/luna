# Create a new built-in step

Built-ins are reusable local capabilities that workflow YAML can call with:

```yaml
- id: my_step
  type: built_in
  uses: my_new_step
```

Use a built-in when the workflow needs deterministic TypeScript behavior:
filesystem/git operations, repository context, artifact shaping, validation, or
state plumbing. Use an agent when the work is model-driven. Use an adapter when
the work only converts external input into a Luna invocation.

## 1. Choose the domain file

Built-ins live under `src/core/built-ins/`.

Current domain files:

- `code-review.ts` for GitHub PR review steps.
- `implementation.ts` for Jira implementation/write-mode steps.

Create a new domain file only when the capability does not belong to an
existing domain.

## 2. Define the step

Export each built-in individually with `defineBuiltInStep`:

```ts
import { defineBuiltInStep } from "./registry.js";
import { requiredState, resolvedInput } from "./state.js";

export const myNewStepBuiltIn = defineBuiltInStep({
  name: "my_new_step",
  async run({ state, input, dependencies = {} }) {
    const resolved = resolvedInput(input, state);
    const run = requiredState(state.run, "run");

    return {
      run_id: run.run_id,
      value: resolved.value ?? "default"
    };
  }
});
```

Keep the step small. If several built-ins need the same state parsing, add a
helper to `state.ts`. If the helper executes domain behavior, keep it in the
domain file instead.

## 3. Add metadata only when the runner needs it

Most built-ins do not need metadata.

Use `capturesWorkspace` only when the step returns a `WorkspaceRecord` that
should become `state.workspace`:

```ts
export const prepareSomethingBuiltIn = defineBuiltInStep({
  name: "prepare_something",
  metadata: { capturesWorkspace: true },
  async run() {
    return workspaceRecord;
  }
});
```

Use `deferUntilAfterWorkspaceLifecycle` only for final report steps that must
run after Luna decides whether to preserve or clean a worktree:

```ts
export const finalSomethingReportBuiltIn = defineBuiltInStep({
  name: "final_something_report",
  metadata: { deferUntilAfterWorkspaceLifecycle: true },
  run() {
    return { json: {}, markdown: "# Report\n" };
  }
});
```

Do not add name checks to `configured-workflow-runner.ts`. Runner behavior must
come from metadata.

## 4. Register it in the catalog

Add the exported step to `src/core/built-ins/catalog.ts`:

```ts
import { myNewStepBuiltIn } from "./my-domain.js";

export const defaultBuiltInSteps = Object.freeze([
  // existing steps...
  myNewStepBuiltIn
] as const);
```

This is the source of truth for supported built-in names. `workflow-definition.ts`
validates YAML through this catalog, and runtime execution resolves the same
name through the registry.

## 5. Re-export if needed

If you created a new domain file, export it from `src/core/built-ins/index.ts`:

```ts
export * from "./my-domain.js";
```

Existing domain files are already re-exported.

## 6. Use it from workflow YAML

Add a node to `workflows/<workflow-id>/graph.yaml`:

```yaml
- id: my_step
  type: built_in
  uses: my_new_step
  input:
    value: $.steps.previous.value
  after:
    - previous
```

`input` values can reference workflow state through JSON-path-like expressions
resolved by Luna before the built-in runs.

## 7. Test it directly

Create or update the focused domain test:

```ts
import { describe, expect, it } from "vitest";
import { myNewStepBuiltIn } from "../../src/core/built-ins/my-domain.js";

describe("my domain built-ins", () => {
  it("runs my_new_step", async () => {
    await expect(
      myNewStepBuiltIn.run({
        state: {
          run: { run_id: "run-1" },
          steps: {}
        },
        input: { value: "ok" }
      })
    ).resolves.toEqual({
      run_id: "run-1",
      value: "ok"
    });
  });
});
```

For registry/catalog changes, also update
`tests/core/built-ins-registry.test.ts`.

## 8. Verify

Run the focused tests:

```sh
npm test -- tests/core/built-ins-registry.test.ts tests/core/built-ins-code-review.test.ts tests/core/built-ins-implementation.test.ts
npm test -- tests/core/workflow-definition.test.ts tests/core/configured-workflow-runner.test.ts
npm run typecheck
```

Run the full suite before committing:

```sh
npm test
npm run build
```
