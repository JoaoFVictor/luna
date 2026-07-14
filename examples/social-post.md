# Generate And Publish An X Post

The bundled `social-post` workflow receives a structured briefing, asks
`social-post-writer` for publication-ready text and a visual prompt, generates
a PNG, and pauses with both assets available for conversational human review.
The reviewer can request changes to text, image, or both as many times as
needed, then approve or reject. Approval uploads the selected image to X and
publishes the approved text with that media attached.

## Configure Authentication

The image step uses the existing Pi `openai-codex` OAuth credential at
`.luna/auth/pi-ai/auth.json`; `pi-imagegen` does not use a public OpenAI API
key. Store the X credential outside version control at
`.luna/auth/luna.auth.json` (or under `LUNA_AUTH_ROOT`):

```json
{
  "providers": {
    "x": {
      "default": {
        "auth_type": "oauth2_user_access_token",
        "access_token": "<user-access-token>",
        "refresh_token": "<refresh-token>",
        "client_id": "<oauth2-client-id>"
      }
    }
  }
}
```

The X Developer Console does not generate these OAuth 2.0 user tokens directly.
It provides the client credentials; the authorization flow returns the access
and refresh tokens. For a local one-account setup:

1. At [console.x.com](https://console.x.com), create an App and configure OAuth
   2.0 as `Native App` (public client).
2. Register `https://oauth.pstmn.io/v1/browser-callback` as an exact callback
   URL and copy the App's `Client ID` from `Keys and Tokens`.
3. In Postman, select OAuth 2.0 and `Authorization Code (With PKCE)`, enable
   `Authorize using browser`, use `SHA-256`, and configure:
   - Auth URL: `https://x.com/i/oauth2/authorize`
   - Access Token URL: `https://api.x.com/2/oauth2/token`
   - Scope: `tweet.read tweet.write users.read media.write offline.access`
   - Client ID: the value copied from the X App
4. Select `Get New Access Token`, authorize the publishing account, then open
   `Manage Tokens`. Copy the access token and refresh token into the Luna auth
   entry. The refresh token exists only when `offline.access` was requested.

The current X Postman procedure is documented at
[docs.x.com/tutorials/postman-getting-started](https://docs.x.com/tutorials/postman-getting-started),
and current Postman versions expose token details under `Manage Tokens`. An
app-only bearer token cannot create posts. Luna uses the current access token
until X returns a confirmed `401`, then refreshes and atomically persists the
rotated credentials. Set `expires_at` to an ISO-8601 timestamp when the token's
expiry is known to refresh proactively. Confidential clients must also set
`client_secret`; public PKCE clients omit it.

## Run

Edit `examples/social-post-invocation.json` with the desired briefing, then:

```bash
LUNA_CONFIG_ROOT=config npm run dev -- run --target workflow:social-post --input examples/social-post-invocation.json
```

The run pauses at the `editorial` loop review. In Luna Studio, open the run to review the text
and generated PNG inline. `Solicitar alterações` requires a message and at
least one target; it produces a new version and another review gate. Approving
unlocks exactly one `social-post.publish` attempt. Rejecting completes the run
normally without publishing.

Revision targets are enforced by `social-post.apply_revision_scope`, not by
prompt compliance. An image-only request preserves the effective text and its
supporting metadata byte-for-byte; a text-only request preserves the image
prompt and skips generation, retaining the exact immutable asset reference.

Before each review gate, `social-post.prepare` verifies the generated PNG's
bytes, content hash, media type, and size against the selected provider. X
declares a 5 MiB image upload limit, bounded by Luna's 25 MiB hard safety cap,
so an image that is already known to be unpublishable is shown with a
diagnostic. Approval remains blocked by the runtime while requesting a new
image or rejecting the version remains available.

The relevant artifacts are:

- `loops/editorial/iterations/N/social-post-draft.json` and `social-post-draft.md`
- `generated-images/<sha256>.png` and the iteration's `social-post-image-metadata.json`
- `social-post-published.json`

Automatic retry is deliberately forbidden for billed image generation and
publication. If the X request
has an unknown transport outcome, inspect the account before starting another
run so Luna does not duplicate the post.
