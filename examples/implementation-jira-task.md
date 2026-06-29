# Implement A Jira Task

This recipe runs Luna's bundled `implementation` workflow against a Jira task.
The workflow creates a writable git worktree, runs a trusted local implementer,
validates the result, reviews it, and optionally commits, pushes, and opens a
change request. The first supported change request provider is GitHub, which
opens a draft PR.

## 1. Install Dependencies

```bash
npm install
```

## 2. Authenticate Models

The default `config/models.yaml` uses Pi's `openai-codex/...` provider.
Those profiles use `transport: sse` by default to avoid abnormal Codex
WebSocket closures during long trusted-local prompts.

```bash
mkdir -p .luna/auth/pi-ai
# create .luna/auth/pi-ai/auth.json from .luna/auth/pi-ai/auth.example.json
```

Luna reads Pi credentials from `.luna/auth/pi-ai/auth.json`.

## 3. Configure Jira

Edit `config/jira.yaml`:

```yaml
instances:
  - id: company
    base_url: https://company.atlassian.net
    repository_hint:
      source: field
      field_id: customfield_12345
    acceptance_criteria_field:
      field_id: customfield_67890
      format: markdown
```

The repository field must resolve to a GitHub repository that exists in
`config/repositories.yaml`.

Create `.luna/auth/luna.auth.json` under the Luna auth root:

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

Do not commit the real `.luna/auth/luna.auth.json`.

## 4. Configure The Repository

Clone the target repository locally:

```bash
git clone git@github.com:org/repo.git /repositories/repo
```

Edit `config/repositories.yaml`:

```yaml
repositories:
  - id: repo
    provider: github
    owner: org
    name: repo
    path: /repositories/repo
    remote: origin
    expected_remote_urls:
      - git@github.com:org/repo.git
      - https://github.com/org/repo.git
    context:
      files:
        - AGENTS.md
        - README.md
```

`expected_remote_urls` is required for repository-change workflows. Luna checks the
configured remote before creating the implementation worktree.

## 5. Configure Implementation Gates

Review `config/implementation.yaml`:

```yaml
implementation:
  branch_pattern: feature/{slug}
  commit:
    enabled: true
  push:
    enabled: true
    remote: origin
  change_request:
    enabled: true
    provider: github
    draft: true
    base_ref: main
  sandbox:
    type: trusted_host_local
    env_allowlist: []
  validation:
    repair_attempts: 1
    max_output_bytes: 200000
    commands:
      - cmd: npm
        args: ["test"]
        timeout_ms: 120000
      - cmd: npm
        args: ["run", "typecheck"]
        timeout_ms: 120000
```

`trusted_host_local` is trusted-operator mode and can edit the local worktree.
The implementer agent declares `trusted_local_write`.

The bundled configuration enables commit, push, and draft change request
creation. You can disable any publishing stage in this file. Enabling push
requires commit, and enabling a change request requires push. If commit is
disabled, validation fails, acceptance rejects the change, or a publishing gate
fails, Luna preserves the repository change worktree for inspection.

## 6. Run The Workflow

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:implementation --from jira-task-url https://company.atlassian.net/browse/ABC-123
```

The `jira-task-url` adapter fetches the Jira issue, maps the configured
repository field to a local repository entry, and runs the generic Luna workflow
entrypoint with a normalized Jira issue invocation. URL adapters omit `target`
unless the CLI override is used; workflow selection comes from
`--target workflow:<id>`, invocation `target`, or `config/routing.yaml`.

## 7. Read The Result

Artifacts are written under:

```text
.runs/implementation/<run-id>/
```

Important files:

- `preflight.json`: runtime/config preflight result.
- `final-report.md`: human-readable implementation report.
- `final-report.json`: structured final report.
- `workspace.json`: repository change worktree path and preservation state.
- `task-context.json`: normalized issue/task text for planner, implementer, and
  change request body.
- `context-intake.json`: repository and agent context audit.
- `implementation-plan.json`: planner agent output.
- `implementation-result.json`: gated implementer loop output, including repair
  attempts and gate decisions.
- `validation.json`: validation command output.
- `acceptance-review.json`: acceptance review gate output.
- `diff.json`: collected diff after automated gates pass.
- `prepared-commit.json`, `git-commit.json`, `commit.json`: commit preparation,
  side effect, and lifecycle result.
- `prepared-push.json`, `git-push.json`, `push.json`: push preparation, side
  effect, and lifecycle result.
- `change-request.json`: draft change request result.

## Troubleshooting

`.luna/auth/luna.auth.json` is missing

Create `.luna/auth/luna.auth.json` with a Jira provider entry for the
`config/jira.yaml` instance id.

`Repository is not configured`

The Jira repository field does not match a `provider: github` entry in
`config/repositories.yaml`.

`expected_remote_urls_missing`

Add `expected_remote_urls` to the matching repository entry before running the
repository-change `implementation` workflow.
