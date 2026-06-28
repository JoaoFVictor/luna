# Create A New Input Adapter

Input adapters turn external values into Luna invocations. They let callers use
`--from <adapter> <value>` instead of hand-writing JSON.

Adapters do not run workflows, create worktrees, call model runtimes, write
artifacts, commit, push, or create change requests.

## 1. Pick The Owning Module

Shared contracts live in:

- `src/adapters/types.ts`
- `src/adapters/registry.ts`

Concrete provider adapters currently live under provider modules:

- `src/providers/github/input-adapter.ts`
- `src/providers/jira/input-adapter.ts`
- `src/providers/plane/input-adapter.ts`

For a new source provider, prefer `src/providers/<provider>/input-adapter.ts`
plus provider-owned auth/config/payload parsing.

## 2. Return An Invocation

Import from `src/core/router/invocation.ts`:

```ts
import {
  InvocationSchema,
  type Invocation
} from "../../core/router/invocation.js";
import type { InputAdapter } from "../../adapters/types.js";

export const slackMessageUrlAdapter: InputAdapter = {
  id: "slack-message-url",
  description: "Load a Slack message URL.",
  async load(input, context): Promise<Invocation> {
    const url = new URL(input.value);

    return InvocationSchema.parse({
      version: "2026-06",
      source: "slack",
      event: "message",
      action: "selected",
      subject: {
        type: "slack_message",
        id: "C123:1710000000.000100",
        title: "Slack message",
        url: url.toString()
      },
      payload: {
        channel_id: "C123",
        timestamp: "1710000000.000100"
      }
    });
  }
};
```

Preserve source-specific data under `payload` when later provider-owned steps
need it. Parse it strictly before use.

## 3. Register It

Register provider adapters through native platform plugins in
`src/platform/native/native-platform-plugins.ts`, or through a configured
native plugin module when the adapter is external to the bundled platform.

The CLI resolves `--from <adapter>` through the active platform's input adapter
registry.

## 4. Routing

Adapters should normally omit `target`. Workflow selection comes from:

1. CLI `--target workflow:<id>`.
2. invocation `target`.
3. `config/routing.yaml`.

Routing must remain deterministic and model-free.

## 5. Test

Add tests under `tests/adapters/` for valid input, invalid input, source API or
tool failures, auth/config failures, and normalized invocation shape. Add CLI
coverage if the adapter is public.

Run:

```bash
npm run typecheck
npm run typecheck:unused-src
npm run lint:unused
```
