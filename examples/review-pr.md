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
npx @earendil-works/pi-ai login openai-codex
```

This creates `auth.json` in the Luna project directory. Luna reads it at runtime.
Do not commit it.

## 3. Authenticate GitHub

```bash
gh auth status
```

For private repositories, the authenticated account must have access to the PR.

## 4. Clone The Target Repository

```bash
git clone git@github.com:org/repo.git /path/to/local/repo
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
    path: /path/to/local/repo
    remote: origin
```

`provider`, `owner`, and `name` must match the PR URL exactly.

For this PR:

```text
https://github.com/swinggo-dev/swg-front-nuxt/pull/313
```

Use:

```yaml
provider: github
owner: swinggo-dev
name: swg-front-nuxt
```

## 6. Run The Review

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:code-review --from github-pr-url https://github.com/org/repo/pull/123
```

The `github-pr-url` adapter calls `gh api`, builds a normalized Luna invocation,
and runs the generic Flue workflow entrypoint. URL adapters omit `target`
unless the CLI override is used; workflow selection comes from
`--target workflow:<id>`, invocation `target`, or `config/routing.yaml`.

## 7. Read The Result

Artifacts are written under:

```text
.runs/code-review/<run-id>/
```

Important files:

- `final-report.md`: human-readable review report.
- `final-report.json`: structured final report.
- `repo-context.json`: changed files and diff context.
- `review-plan.json`: planner agent output.
- `code-review-findings.json`: validated review findings.
- `acceptance-review.json`: acceptance agent output.

## Troubleshooting

`Repository is not configured: github/org/repo`

The PR owner/name does not match `config/repositories.yaml`, or the repository
entry is missing.

`gh` cannot read the PR

Run `gh auth status` and confirm the account has access to the repository.

Git fetch fails

Check the local clone's remote:

```bash
git -C /path/to/local/repo remote -v
```

For private repositories, make sure SSH or HTTPS git auth works outside Luna.

`auth.json` is missing

Run `npx @earendil-works/pi-ai login openai-codex` from the Luna project root.
