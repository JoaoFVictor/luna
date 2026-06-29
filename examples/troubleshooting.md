# Troubleshooting Runs

Use this runbook when a Luna run fails, pauses, or produces an unexpected
artifact. Start with the artifact directory:

```text
.runs/<workflow-id>/<run-id>/
```

Then inspect runtime logs, events, and node artifacts before changing code or
configuration.

## Routing Did Not Pick The Expected Workflow

Luna chooses a workflow in this order:

1. CLI `--target workflow:<id>`.
2. Invocation `target`.
3. Deterministic route from `config/routing.yaml`.

If the wrong workflow runs, check the normalized invocation JSON first. The
router does not ask a model to choose the workflow.

## Adapter Cannot Find The Repository

Check `repository` in the normalized invocation and compare it with
`config/repositories.yaml`:

```yaml
repositories:
  - provider: github
    owner: org
    name: repo
```

For repository-change workflows, also configure `path`, `remote`, and
`expected_remote_urls`. Luna verifies the local remote before creating a
writable worktree.

## Provider Auth Fails

GitHub adapters and publishing use `gh` authentication from the Luna auth root
through `GH_CONFIG_DIR`. Jira and Plane read provider credentials from
`.luna/auth/luna.auth.json`.

Pi model authentication is separate:

```bash
mkdir -p .luna/auth/pi-ai
# create .luna/auth/pi-ai/auth.json from .luna/auth/pi-ai/auth.example.json
```

Do not put Pi model credentials in `luna.auth.json`; keep them at
`.luna/auth/pi-ai/auth.json`.

## Context Looks Empty

Check `context-intake.json`. It records:

- configured repository and agent files.
- successfully read files.
- missing files.
- skipped path escapes.
- non-file paths.
- files skipped for size.

Collected file bodies become agent instructions. Agent task input keeps a
compact `context_audit` instead of raw context bodies.

## Agent Output Is Rejected

Agent nodes validate model output against the node `output_schema`. The Pi
adapter expects the final model output to be valid JSON that matches that
schema. Inspect the node artifact and the runtime log projection to see whether
the model returned prose, malformed JSON, or a schema-shaped object with
invalid fields.

## Validation Gate Fails

The `implementation` workflow runs validation inside
`quality-gates.gated_agent_loop`. Check `implementation-result.json` and
`validation.json`.

If `config/implementation.yaml` has `repair_attempts` greater than zero, Luna
feeds gate feedback back to the writer and retries the writer loop. When
attempts are exhausted, the run fails and preserves the worktree for manual
inspection.

## Human Approval Paused The Run

The bundled `example-complete-agent` workflow intentionally pauses at
`hitl.approval` to demonstrate resumable HITL. The production-style
`implementation` workflow does not pause for human approval; it publishes after
automated gates pass.

Resume with the stored ids:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- resume \
  --target workflow:example-complete-agent \
  --thread <run-id> \
  --checkpoint <checkpoint-id> \
  --interrupt <interrupt-id> \
  --decision '{"approved":true}'
```

Repeating the same decision is idempotent. Changing a recorded decision is
rejected.

## Commit, Push, Or Change Request Is Skipped

Check `config/implementation.yaml`:

```yaml
implementation:
  commit:
    enabled: true
  push:
    enabled: true
  change_request:
    enabled: true
```

Push depends on commit. Change request creation depends on push. Publishing can
also be stopped by failed validation, failed acceptance review, side-effect
policy, missing `gh` auth, or repository remote mismatch.

## Pull Request Review Is Not Published

Check `config/code-review.yaml`:

```yaml
code_review:
  pull_request_review:
    enabled: true
    provider: github
    event: auto
    inline_comments: true
```

If publishing is disabled, `pull-request-review.json` records a skipped result.
If publishing is enabled but fails, check `gh auth status` with the Luna
`GH_CONFIG_DIR`, confirm the authenticated account can review the PR, and
inspect `repo-context.json` plus `code-review-findings.json`.

`event: auto` publishes `request_changes` only when
`code-review-findings.json` contains validated findings; with no findings it
publishes a regular PR review comment. That comment should still include the
acceptance result from `acceptance-review.json`, such as `approved`,
`changes requested`, `not accepted`, or `needs human review`. If the provider
call fails, the workflow records a `publish_failed` result in
`pull-request-review.json` instead of retrying the webhook job.

If GitHub accepts the request but Luna cannot prove the created review identity
from the response, the workflow fails with
`pull_request_review_unknown_publish_outcome`. That failure is non-retryable
because retrying could create duplicate reviews.

Inline comments are only created for validated findings whose evidence maps to
right-side lines in the captured PR diff. Other findings are appended to the
review body, so zero inline comments does not necessarily mean publication
failed.

## Runtime Or Observability Backend Is Invalid

Runtime composition validates every selected backend and option object. The
default app config uses filesystem artifacts, events, interrupts, and runtime
logs, SQLite checkpoints, LangGraph workflow runtime, and Pi agent runtime.

Durable checkpoints are required for trusted writes, human interrupts, and
external side effects. Native LangGraph interrupts require SQLite checkpoints.

## MCP Tools Do Not Appear In Pi

MCP server policy can be configured and validated, but the current Pi runtime
adapter does not materialize MCP tools. Use Luna local tools or add runtime
adapter support before expecting MCP calls in Pi-backed agents.

## Useful Artifacts

- `preflight.json`: selected runtime and config preflight.
- `context-intake.json`: repository and agent context audit.
- `implementation-result.json`: writer attempts and gate outcomes.
- `validation.json`: validation command results.
- `acceptance-review.json`: acceptance gate result.
- `diff.json`: collected worktree diff.
- `commit.json`, `push.json`, `change-request.json`: publishing lifecycle.
- `pull-request-review.json`: PR review publication or skipped result.
- `final-report.md`: operator-facing final summary.
