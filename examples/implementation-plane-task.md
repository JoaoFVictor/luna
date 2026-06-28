# Implement A Plane Task

This recipe runs the bundled `implementation` workflow from a Plane issue URL.
The workflow creates a trusted local write worktree, plans the implementation,
runs a gated writer loop, validates, commits, pushes, and can create a draft
GitHub change request.

## 1. Install And Authenticate

```bash
npm install
npx @earendil-works/pi-ai login openai-codex
gh auth status
```

`gh` is required when commit/push/change-request publishing targets GitHub.

## 2. Configure The Repository

`config/repositories.yaml` must include the repository Plane should map to:

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

`expected_remote_urls` is required for trusted write workflows.

## 3. Configure Plane

`config/plane.yaml` declares Plane instances:

```yaml
instances:
  - id: company
    base_url: https://app.plane.so
    repository_hint:
      source: label
```

The Plane adapter can read repository hints from labels. Expected label value:

```text
provider:owner/repo
```

Example:

```text
github:org/repo
```

## 4. Add Provider Auth

Create `.luna/auth/luna.auth.json` under the Luna auth root:

```json
{
  "providers": {
    "plane": {
      "company": {
        "base_url": "https://app.plane.so",
        "auth_type": "api_key",
        "api_key": "plane-api-key"
      }
    }
  }
}
```

Do not commit this file.

## 5. Configure Implementation Gates

`config/implementation.yaml` controls validation and publishing:

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
  validation:
    repair_attempts: 1
    max_output_bytes: 200000
    commands:
      - cmd: npm
        args:
          - test
        timeout_ms: 120000
```

Publishing requires the workflow's automated validation, review, and acceptance
gates to pass.

## 6. Run

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:implementation --from plane-task-url https://app.plane.so/company/browse/PROJ-42/
```

The adapter supports Plane browse/project issue URL shapes handled by the
provider module.

## 7. Read Artifacts

Important files:

- `task-context.json`
- `context-intake.json`
- `implementation-plan.json`
- `implementation-result.json`
- `validation.json`
- `acceptance-review.json`
- `diff.json`
- `commit.json`
- `push.json`
- `change-request.json`
- `final-report.md`

Failed runs preserve the worktree by default for inspection.
