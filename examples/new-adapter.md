# Create A New Input Adapter

Adapters turn external input into Luna's normalized invocation format. They
exist so callers do not need to hand-write JSON.

The CLI shape should stay generic:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --workflow my-workflow --from my-adapter value
```

Do not add workflow-specific commands such as:

```bash
review-pr <url>
```

## 1. Decide The External Input

Examples:

- GitHub PR URL.
- Slack message URL.
- API event id.
- GitHub issue URL.
- Local file path.

The adapter receives the value after `--from <adapter>`.

## 2. Create The Adapter Module

Create a module under `src/core/`, for example:

```text
src/core/slack-message-adapter.ts
```

The adapter should:

- Parse and validate the external value.
- Fetch source metadata through source-native tooling or APIs.
- Normalize the result into Luna's invocation shape.
- Return clear errors for invalid input, missing auth, or unsupported sources.

For GitHub PRs, `src/core/github-pr-adapter.ts` is the reference implementation.

## 3. Return A Normalized Invocation

The result must satisfy Luna's `InvocationSchema`.

Current Luna invocations are GitHub PR focused. A valid minimal example looks
like this:

```json
{
  "target": "github_pr",
  "owner": "octo-org",
  "repo": "hello-world",
  "pull_number": 42,
  "base_ref": "main",
  "base_repository": {
    "owner": "octo-org",
    "name": "hello-world",
    "full_name": "octo-org/hello-world"
  },
  "head_repository": {
    "owner": "contributor",
    "name": "hello-world",
    "full_name": "contributor/hello-world",
    "fork": true
  },
  "references": {
    "base_sha": "abc123",
    "head_sha": "def456"
  }
}
```

See `examples/github-pr-opened.invocation.json` for the committed example.

An adapter may also attach `workflow` when the mapping is deterministic:

```ts
return {
  target: "github_pr",
  owner: "octo-org",
  repo: "hello-world",
  pull_number: 42,
  base_ref: "main",
  base_repository: {
    owner: "octo-org",
    name: "hello-world",
    full_name: "octo-org/hello-world"
  },
  head_repository: {
    owner: "contributor",
    name: "hello-world",
    full_name: "contributor/hello-world",
    fork: true
  },
  references: {
    base_sha: "abc123",
    head_sha: "def456"
  },
  workflow: "code-review",
};
```

Do not ask an LLM which workflow should run. Routing should be deterministic.

## 4. Register The Adapter In The CLI

Register the adapter in `src/core/flue-cli.ts`, where `--from` is resolved.

The existing shape is:

```ts
if ("input" in parsedArgs) {
  invocation = await loadInvocationFromFile(parsedArgs.input);
} else if (parsedArgs.from === "github-pr-url") {
  invocation = await fetchGitHubPullRequestInvocation(parsedArgs.value);
} else {
  throw cliError("unknown_input_adapter", `Unknown input adapter: ${parsedArgs.from}`);
}
```

Add your adapter as another explicit branch or refactor to a small registry if
the list grows.

## 5. Keep Responsibilities Separate

An adapter should not:

- Run Flue directly.
- Create git worktrees.
- Write final artifacts.
- Hide which workflow is being called.

The runtime handles workflow execution after the adapter returns an invocation.

## 6. Add Tests

Add adapter tests for:

- Valid input parsing.
- Invalid input.
- Source API/tool failures.
- Normalized invocation shape.

Add CLI tests proving `--from <adapter>` dispatches to the adapter.

Useful test targets:

```bash
npm test -- tests/core/cli.test.ts tests/core/github-pr-adapter.test.ts
```

For a new adapter, add a dedicated test file beside `github-pr-adapter.test.ts`.

## 7. Document The Adapter

Update:

- `README.md` current adapter inventory.
- `examples/configured-workflows.md` current adapter inventory.
- Any source-specific recipe that helps a new user run it.
