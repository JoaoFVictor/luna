# Review A GitHub PR

This recipe is for a person who only wants to run Luna's bundled code review
workflow against a real GitHub PR.

## 1. Install Dependencies

```bash
npm install
```

## 2. Authenticate Models

The default `config/models.yaml` uses Pi's `openai-codex/...` provider.

```bash
mkdir -p .luna/auth/pi-ai
# create .luna/auth/pi-ai/auth.json from .luna/auth/pi-ai/auth.example.json
```

Luna reads Pi credentials from `.luna/auth/pi-ai/auth.json`.

## 3. Authenticate GitHub

```bash
GH_CONFIG_DIR=.luna/auth/gh gh auth status
```

For private repositories, the authenticated account must have access to the PR.

## 4. Clone The Target Repository

```bash
git clone git@github.com:org/repo.git /repositories/repo
```

Luna reviews code from the local clone. The GitHub adapter fetches PR metadata
through `gh`, but repository context comes from local git.

## 5. Configure The Repository

Edit `config/repositories.yaml`:

```yaml
repositories:
  - id: repo
    provider: github
    owner: org
    name: repo
    path: /repositories/repo
    remote: origin
    context:
      files:
        - AGENTS.md
        - README.md
```

`provider`, `owner`, and `name` must match the PR URL exactly.
`context.files` is optional; configured files are audited in
`context-intake.json` and injected into review agent instructions. They are not
kept as raw file contents in the agent task payload; the payload contains
`context_audit` metadata.

For this PR:

```text
https://github.com/octo-org/hello-world/pull/313
```

Use:

```yaml
provider: github
owner: octo-org
name: hello-world
```

## 6. Run The Review

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:code-review --from github-pr-url https://github.com/org/repo/pull/123
```

The `github-pr-url` adapter calls `gh api`, builds a normalized Luna invocation,
and runs the generic Luna workflow entrypoint. URL adapters omit `target`
unless the CLI override is used; workflow selection comes from
`--target workflow:<id>`, invocation `target`, or `config/routing.yaml`.

By default the workflow only writes local artifacts. To publish the review back
to the PR, enable `config/code-review.yaml`:

```yaml
code_review:
  pull_request_review:
    enabled: true
    provider: github
    event: auto
    inline_comments: true
```

Inline comments are created only for validated findings whose evidence maps to
right-side lines in the captured PR diff. Findings that cannot be placed inline
are appended to the review body.

The workflow remains read-only for the local repository: agents cannot edit the
worktree and no commit/push is performed. Publishing is still an external
GitHub side effect, so it is guarded by the `pull-request-review.publish`
capability policy and requires working `gh` auth.

Review event behavior:

- `auto`: request changes when validated findings exist; otherwise publish a
  non-blocking PR review comment.
- `comment`: publish a non-blocking PR review comment.
- `request_changes`: publish a formal review requesting changes on the PR.
- `approve`: publish an approval review.

The runtime protects contradictory states before calling the provider:
`request_changes` with no validated findings becomes `comment`, and `approve`
with validated findings becomes `comment`.

Published review body:

- Includes the acceptance result: `approved`, `changes requested`,
  `not accepted`, or `needs human review`.
- Includes the acceptance summary.
- Includes blocking reasons when the acceptance result provides them.

Capability/provider split:

- `workflows/code-review/workflow.yaml` decides when to call
  `pull-request-review.publish` and what state to pass.
- `src/capabilities/pull-request-review/` validates the provider-neutral input
  and derives inline/fallback comments from validated findings.
- `src/providers/github/pull-request-review/` performs the GitHub API call
  through the shared `gh` helper.

## 7. Read The Result

Artifacts are written under:

```text
.runs/code-review/<run-id>/
```

Important files:

- `final-report.md`: human-readable review report.
- `final-report.json`: structured final report.
- `context-intake.json`: configured repository and agent context audit.
- `repo-context.json`: changed files and diff context.
- `review-plan.json`: planner agent output.
- `code-review-findings.json`: validated review findings.
- `acceptance-review.json`: acceptance agent output.
- `pull-request-review.json`: PR review publication result when enabled.

## Troubleshooting

`Repository is not configured: github/org/repo`

The PR owner/name does not match `config/repositories.yaml`, or the repository
entry is missing.

`gh` cannot read the PR

Run `gh auth status` and confirm the account has access to the repository.

Git fetch fails

Check the local clone's remote:

```bash
git -C /repositories/repo remote -v
```

For private repositories, make sure SSH or HTTPS git auth works outside Luna.

`.luna/auth/pi-ai/auth.json` is missing

Create `.luna/auth/pi-ai/auth.json` from `.luna/auth/pi-ai/auth.example.json`.

`WebSocket closed 1006`

This is an abnormal Codex WebSocket transport closure. Keep read-only retry
bounded and set the affected `config/models.yaml` profile to `transport: sse`.
