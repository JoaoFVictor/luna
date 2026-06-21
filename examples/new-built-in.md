# Create a new built-in step

Built-ins are deterministic local capabilities under `src/core/built-ins/` that
workflow YAML can call with:

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
- `implementation.ts` for Jira implementation built-in steps; supporting
  write-mode services live under `src/core/write-mode/`.

Create a new domain file only when the capability does not belong to an
existing domain. If you create a new domain file, create a matching focused
test file under `tests/core/`, for example
`tests/core/built-ins-my-domain.test.ts`.

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

Use `deferredLifecycle: "final_report"` only for final report steps that must
run after Luna decides whether to preserve or clean a worktree:

```ts
export const finalSomethingReportBuiltIn = defineBuiltInStep({
  name: "final_something_report",
  metadata: { deferredLifecycle: "final_report" },
  run() {
    return { json: {}, markdown: "# Report\n" };
  }
});
```

Do not add name checks to `src/core/configured-workflow/runner.ts`. Runner
behavior must come from metadata.

## 4. Register it in the catalog

Add the exported step to `src/core/built-ins/catalog.ts`:

```ts
import { myNewStepBuiltIn } from "./my-domain.js";

export const defaultBuiltInSteps = Object.freeze([
  // existing steps...
  myNewStepBuiltIn
] as const);
```

This is the source of truth for supported built-in names.
`src/core/workflow/definition.ts` validates YAML through this catalog, and
runtime execution resolves the same name through the registry.

## 5. Import direct owners

Do not add new barrel exports for built-in domain files. Runtime registration
comes from `catalog.ts`; tests and other internal consumers should import the
domain file that owns the step directly.

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

If the built-in becomes part of Luna's public inventory, update `README.md` and
`examples/configured-workflows.md` so workflow authors can discover it.

## 8. Verify

Run the focused tests:

```sh
rtk npm test -- tests/core/built-ins-registry.test.ts tests/core/built-ins-code-review.test.ts tests/core/built-ins-implementation.test.ts
rtk npm test -- tests/core/workflow-definition.test.ts tests/core/configured-workflow-runner.test.ts
rtk npm run typecheck
rtk npm run typecheck:unused-src
rtk npm run lint:unused
```

Run the full suite before committing:

```sh
rtk npm test
rtk npm run typecheck
rtk npm run typecheck:unused-src
rtk npm run lint:unused
rtk npm run build
```
