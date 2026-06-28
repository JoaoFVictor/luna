# Luna Auth Root

This directory documents Luna's single auth root layout.

At runtime, set `LUNA_AUTH_ROOT` to the directory that contains these auth
subpaths:

```text
luna.auth.json
pi-ai/auth.json
gh/
ssh/
```

Only `*.example.*` files in this directory are safe to commit. Real credentials
must stay untracked.

For Docker Compose, the default host auth root is `./.luna/auth` and it is
mounted at `/app/.luna/auth`. It must be writable because the Pi runtime can
refresh OAuth credentials.
