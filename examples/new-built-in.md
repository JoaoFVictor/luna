# Create A New Built-In Step

Built-ins are deterministic local capabilities that workflow YAML can call with:

```yaml
- id: my_step
  type: built_in
  uses: my_new_step
```

Use a built-in when the workflow needs deterministic TypeScript behavior:
filesystem/git operations, repository context, artifact shaping, validation, or
state plumbing. Use an agent when the work is model-driven. Use an adapter when
the work only converts external input into a Luna invocation.

## 1. Choose The Domain File

Runtime-neutral built-ins live under `src/core/built-ins/`. Provider-specific
built-ins live under `src/providers/<provider>/built-ins.ts` and are wired
through an explicit composition registry.

Current domain files:

- `src/providers/github/built-ins.ts` for GitHub PR review steps.
- `src/providers/jira/built-ins.ts` for Jira task context and reports.
- `src/providers/plane/built-ins.ts` for Plane task context and reports.
- `src/core/built-ins/implementation.ts` for write-mode implementation steps;
  supporting write-mode services live under `src/core/write-mode/`.

Create a new domain file only when the capability does not belong to an
existing domain. If you create a new domain file, create a matching focused
test file under `tests/core/`, for example
`tests/core/built-ins-my-domain.test.ts`.

## 2. Define The Step

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

## 3. Add Metadata Only When The Runner Needs It

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

Do not add name checks to `src/runtime/langgraph/workflow-runner.ts`. Runner
behavior must come from metadata.

## 4. Register It In A Composition Registry

Add provider-facing steps through the provider-owned composition root:

```ts
import { myNewStepBuiltIn } from "../../providers/my-provider/built-ins.js";

export const defaultBuiltInSteps = Object.freeze([
  // existing steps...
  myNewStepBuiltIn
] as const);
```

Runtime-neutral built-ins and shared catalog helpers stay under
`src/core/built-ins/`. The native workflow factory injects the provider built-in
registry, so YAML validation and runtime execution must see the same active
registry.

## 5. Import Direct Owners

Do not add new barrel exports for built-in domain files. Runtime registration
comes from the active provider registry; tests and other internal consumers
should import the domain file that owns the step directly.

## 6. Use It From Workflow YAML

Add a node to `workflows/<workflow-id>/workflow.yaml` under `nodes:`:

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

## 7. Test It Directly

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

If the built-in becomes part of Luna's public inventory, update `README.md` so
workflow authors can discover it.

## 8. Verify

Run the focused tests:

```sh
npm test -- tests/core/built-ins-registry.test.ts tests/core/built-ins-code-review.test.ts tests/core/built-ins-implementation.test.ts
npm test -- tests/core/workflow/definition.test.ts tests/core/workflow/runner.test.ts
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```

Run the full suite before committing:

```sh
npm test
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
npm run build
```
