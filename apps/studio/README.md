# Luna Studio web app

React/Vite client for the local Luna Studio Control API. The production app is
served by the loopback-only Studio server on the same origin as
`/api/studio/v1/**`.

## Session bootstrap

The CLI launch URL carries a one-use `#capability=...` fragment. The client
removes that fragment synchronously when bootstrap starts, exchanges it for the
HttpOnly local session cookie and keeps the returned CSRF token only in memory.
It is never written to browser storage. A full reload can reuse the cookie for
catalog access and requests a fresh in-memory CSRF token from `/session/csrf`.
That restores mutation authority only while the same local session is still
valid. After the cookie expires or the server restarts, reopen the fresh URL
printed by `luna studio`.

The interface always identifies itself as local single-user mode. It does not
claim user identity, RBAC, remote deployment safety or authentication features.

## Development

The Vite dev server binds to `127.0.0.1` and proxies Studio API requests to the
default backend at `http://127.0.0.1:43110`, rewriting the request origin for the
backend's loopback/origin checks.

```sh
npm run dev --workspace studio
npm run build --workspace studio
npm run lint --workspace studio
```

Do not add production mocks. UI actions must correspond to a real Control API
contract. Currently, workflow drafts support create/edit/validate/compile,
authoritative diff planning and confirmed apply. Structured agent editing,
adapter preview, routing simulation, run planning/dispatch, live run projection,
logs and bounded artifact readers are implemented. User-facing cancel, retry,
resume and approval actions remain unavailable because no corresponding governed
backend action is exposed yet.
