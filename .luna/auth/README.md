# Luna Auth Root

This directory documents Luna's single auth root layout.

At runtime, set `LUNA_AUTH_ROOT` to the directory that contains these auth
subpaths:

```text
luna.auth.json
pi-ai/auth.json
gh/
ssh/
git/config
```

Only `*.example.*` files in this directory are safe to commit. Real credentials
and machine-specific identity files must stay untracked.

For Docker Compose, the default host auth root is `./.luna/auth` and it is
mounted at `/app/.luna/auth`. It must be writable because the Pi runtime can
refresh OAuth credentials.

Git identity for commits belongs in `git/config`. Create it from the host
machine identity:

```bash
mkdir -p .luna/auth/git
git config --global user.name | xargs -I{} git config -f .luna/auth/git/config user.name "{}"
git config --global user.email | xargs -I{} git config -f .luna/auth/git/config user.email "{}"
```
