# Luna Studio web app

React/Vite client for the local Luna Studio Control API. The production app is
served by the loopback-only Studio server on the same origin as
`/api/studio/v1/**`.

## Session bootstrap

Opening the normal loopback URL establishes an HttpOnly local session
automatically. The client first reuses an existing cookie through
`/session/csrf`; when the cookie is missing, invalid, or expired, it requests a
new loopback-only session from `/session/local`. The returned CSRF token stays
only in memory and is never written to browser storage. The legacy one-use
capability exchange remains accepted for compatibility, but is not required for
normal startup.

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
