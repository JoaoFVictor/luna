# Create A New Input Adapter

Adapters turn external input into Luna's normalized invocation format. They
exist so callers do not need to hand-write JSON.

Input adapter modules live under `src/adapters/<id>/` and are registered in
`src/adapters/registry.ts`.

The CLI shape should stay generic:

```bash
rtk env LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:my-workflow --from my-adapter value
```

Do not add workflow-specific commands such as:

```bash
review-pr <url>
```

## 1. Decide The External Input

Examples:

- GitHub PR URL.
- Jira task URL.
- Slack message URL.
- API event id.
- GitHub issue URL.
- Local file path.

The adapter receives the value after `--from <adapter>`.

## 2. Create The Adapter Module

Create a module under `src/adapters/<adapter-id>/`, for example:

```text
src/adapters/slack-message-url/
  adapter.ts
  index.ts
```

The adapter should:

- Parse and validate the external value.
- Fetch source metadata through source-native tooling or APIs.
- Normalize the result into Luna's invocation shape.
- Return clear errors for invalid input, missing auth, or unsupported sources.

For GitHub PRs, `src/adapters/github-pr-url/adapter.ts` is the reference
implementation. For Jira tasks, `src/adapters/jira-task-url/adapter.ts` shows
an adapter that reads `config/jira.yaml`, loads secrets from `luna.auth.json`,
fetches source metadata over HTTP, and returns a normalized invocation for the
implementation workflow to consume through routing or a CLI target override.

## 3. Return A Normalized Invocation

The result must satisfy Luna's `NormalizedInvocation` contract:

```ts
import {
  InvocationSchema,
  type NormalizedInvocation
} from "../../core/invocation/types.js";
import type { InputAdapter } from "../types.js";

export const slackMessageUrlAdapter: InputAdapter = {
  id: "slack-message-url",
  description: "Load a Slack message from a Slack message URL.",
  async load(input): Promise<NormalizedInvocation> {
    const messageUrl = new URL(input.value);

    return InvocationSchema.parse({
      version: "2026-06",
      source: "slack",
      event: "message",
      action: "selected",
      subject: {
        type: "slack_message",
        id: "C123:1710000000.000100",
        url: messageUrl.toString()
      },
      payload: {
        channel_id: "C123",
        timestamp: "1710000000.000100"
      }
    });
  }
};
```

Use `version`, `source`, `event`, optional `action`, and source-specific
`subject`, `repository`, `references`, and `payload` fields as needed.
Invocation routing uses `target` when it is present, but URL adapters should
omit `target` unless the CLI override is used. Without a target override,
workflow selection comes from the invocation `target` or `config/routing.yaml`.

Do not ask an LLM which workflow should run. Routing should be deterministic.

## 4. Export And Register The Adapter

Export the adapter from the adapter package:

```ts
export { slackMessageUrlAdapter } from "./adapter.js";
```

Register it once in `src/adapters/registry.ts`:

```ts
import { slackMessageUrlAdapter } from "./slack-message-url/index.js";

export const inputAdapterRegistry = defineInputAdapters([
  githubPrUrlAdapter,
  jiraTaskUrlAdapter,
  slackMessageUrlAdapter
]);
```

The CLI resolves `--from <adapter>` through this registry.

## 5. Keep Responsibilities Separate

An adapter should not:

- Run Flue directly.
- Create git worktrees.
- Write final artifacts.
- Hide how the workflow is selected.
- Enable commit, push, or change request creation directly. For the
  `implementation` workflow, `config/implementation.yaml` controls optional
  commit, push, and change request gates after validation and acceptance.

The runtime handles workflow execution after the adapter returns an invocation.

## 6. Add Tests

Add adapter tests under `tests/adapters/` for:

- Valid input parsing.
- Invalid input.
- Source API/tool failures.
- Normalized invocation shape.

Add CLI tests proving `--from <adapter>` dispatches to the adapter.

Useful test targets:

```bash
rtk npm test -- tests/core/cli.test.ts tests/adapters/github-pr-url-adapter.test.ts
```

For a new adapter, add a dedicated `tests/adapters/<adapter-id>-adapter.test.ts`
file. For Jira-like adapters, also cover missing `luna.auth.json`, instance
mapping, and repository field validation.

## 7. Document The Adapter

Update:

- `README.md` current adapter inventory.
- `examples/configured-workflows.md` current adapter inventory.
- Any source-specific recipe that helps a new user run it.
