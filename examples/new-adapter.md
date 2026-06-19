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
- Jira task URL.
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
For Jira tasks, `src/core/jira-adapter.ts` shows an adapter that reads
`config/jira.yaml`, loads secrets from `luna.auth.json`, fetches source
metadata over HTTP, and returns a write-workflow invocation.

## 3. Return A Normalized Invocation

The result must satisfy Luna's `InvocationSchema`.

Current Luna invocations include GitHub PRs and Jira tasks. A valid GitHub PR
example looks like this:

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

The bundled `jira-task-url` adapter returns a `jira_task` invocation with
`workflow: implementation`:

```json
{
  "target": "jira_task",
  "workflow": "implementation",
  "jira": {
    "instance_id": "company",
    "issue_key": "ABC-123",
    "url": "https://company.atlassian.net/browse/ABC-123",
    "summary": "Fix checkout validation",
    "description": "Reject invalid checkout payloads.",
    "acceptance_criteria": "Invalid payloads fail validation.",
    "status": "To Do",
    "issue_type": "Task"
  },
  "repository": {
    "provider": "github",
    "owner": "org",
    "name": "repo"
  }
}
```

`config/jira.yaml` maps a Jira origin and fields:

```yaml
instances:
  - id: company
    base_url: https://company.atlassian.net
    repository_field:
      field_id: customfield_12345
      format: github_full_name
    acceptance_criteria_field:
      field_id: customfield_67890
      format: markdown
```

`luna.auth.json` stores Jira credentials at the Luna project root and must not
be committed:

```json
{
  "providers": {
    "jira": {
      "company": {
        "base_url": "https://company.atlassian.net",
        "auth_type": "basic_api_token",
        "email": "user@company.com",
        "api_token": "secret-token"
      }
    }
  }
}
```

For write-mode adapters, ensure the matched repository entry has
`expected_remote_urls` so Luna can verify the local git remote before writing:

```yaml
repositories:
  - id: repo
    provider: github
    owner: org
    name: repo
    path: /path/to/local/repo
    remote: origin
    expected_remote_urls:
      - git@github.com:org/repo.git
```

## 4. Register The Adapter In The CLI

Register the adapter in `src/core/flue-cli.ts`, where `--from` is resolved.

The existing shape is:

```ts
if ("input" in parsedArgs) {
  invocation = await loadInvocationFromFile(parsedArgs.input);
} else if (parsedArgs.from === "github-pr-url") {
  invocation = await fetchGitHubPullRequestInvocation(parsedArgs.value);
} else if (parsedArgs.from === "jira-task-url") {
  invocation = await fetchJiraTaskInvocation(parsedArgs.value);
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
- Enable commit, push, or pull request creation directly. For the
  `implementation` workflow, `config/implementation.yaml` controls optional
  commit, push, and draft PR gates after validation and acceptance.

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
For Jira-like adapters, also cover missing `luna.auth.json`, instance mapping,
and repository field validation.

## 7. Document The Adapter

Update:

- `README.md` current adapter inventory.
- `examples/configured-workflows.md` current adapter inventory.
- Any source-specific recipe that helps a new user run it.
