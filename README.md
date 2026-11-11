# xDev LLM gateway

One place that holds the provider keys for every xDev system (chat, `xdevd`, ...). A Cloudflare Worker (Hono)
backed by D1, with an owner console built from `@xdev-asia/ui`.

Each system keeps using the provider's official SDK and only changes the base URL and the key:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.LLM_GATEWAY_TOKEN, baseURL: "https://<gateway host>/anthropic" });
```

## What it does

| Step | Rule |
|---|---|
| Authenticate | The system's gateway token in `x-api-key` (what the SDK sends) or `Authorization: Bearer`. Stored as SHA-256 only |
| Disable | A disabled system gets `403 permission_error` |
| Cap | Tokens this UTC month (input + output + cache write + cache read) checked before the request; at or over the cap: `429 rate_limit_error` with `x-should-retry: false`. One request can go over the cap; the next one is refused |
| Forward | `POST /anthropic/v1/messages` and `/anthropic/v1/messages/count_tokens`, query string kept. Only `anthropic-version`, `anthropic-beta`, `content-type` and `accept` are passed on; the key becomes the system's Anthropic key |
| Meter | One `usage` row per Messages request: model, status, token counts, request id. Streaming replies are read on a copy of the stream. No request or response content is stored |

The body is not changed, so thinking, caching, tools and fallbacks work as when calling Anthropic directly.
A provider is a path prefix: another one can be added beside `/anthropic` without touching it.

## Secrets and setup

| Name | Kind | Value |
|---|---|---|
| `ANTHROPIC_KEYS` | secret | JSON object, system id -> that system's Anthropic API key. One key per system, ideally one Anthropic workspace per system |
| `ADMIN_TOKEN_SHA256` | secret | SHA-256 hex of the owner's admin token. Unset: the token is refused (xDev ID sign-in still works) |
| `OIDC_CLIENT_SECRET` | secret | This gateway's client secret at xDev ID |
| `ANTHROPIC_BASE_URL` | var | `https://api.anthropic.com` |
| `OIDC_ISSUER` | var | `https://id.xdev.asia/api/auth` |
| `OIDC_CLIENT_ID` | var | This gateway's client id at xDev ID. Empty: xDev ID sign-in is off |
| `CONSOLE_EMAILS` | var | Comma-separated xDev account emails (verified) allowed into the console |

```sh
cd services/llm
corepack pnpm exec wrangler d1 create xdev-llm        # put the id in wrangler.jsonc
corepack pnpm exec wrangler d1 migrations apply xdev-llm --remote
openssl rand -base64 32 | tee /dev/tty | tr -d '\n' | shasum -a 256 | cut -d' ' -f1 \
  | corepack pnpm exec wrangler secret put ADMIN_TOKEN_SHA256   # keep the printed token
corepack pnpm exec wrangler secret put ANTHROPIC_KEYS            # {"chat":"sk-ant-...","xdevd":"sk-ant-..."}
```

Then pick a hostname (a route in `wrangler.jsonc`), deploy, open the console, sign in and add the systems.
Each system's token is shown once.

xDev ID sign-in: register the gateway at xDev ID (a super admin, from `services/id`), put the client id in
`OIDC_CLIENT_ID` and the secret in `OIDC_CLIENT_SECRET`:

```sh
XDEV_ADMIN_TOKEN=... node ../id/scripts/admin.mjs oauth-client "AI router" https://<host>/auth/callback
corepack pnpm exec wrangler secret put OIDC_CLIENT_SECRET
```

## Console

`/` serves the console (`web/`, built into `dist/`). Hash routes: `#/systems`, `#/usage`.

Two ways in:

- **xDev ID** (OpenID Connect, code flow with PKCE, confidential client). `/auth/login` starts it,
  `/auth/callback` finishes it, `/auth/me` and `POST /auth/logout`. Only a verified email in
  `CONSOLE_EMAILS` gets a session: a random token in a `__Host-xllm_session` cookie (Secure, HttpOnly,
  SameSite=Lax, 12 hours), stored as its SHA-256 in `console_session`. The state is bound to the browser by
  a `__Host-xllm_login` cookie and is single use. Writes with the cookie must be same-origin.
- **The admin token**, kept in page memory only, never in storage or a cookie, so a reload signs out.

## Admin API

All under `/admin`, `Authorization: Bearer <admin token>` or the console's xDev ID session cookie
(writes from the console's own origin only). A wrong token is refused even with a valid cookie.

| Call | Body | Answer |
|---|---|---|
| `GET /systems` | | systems (no token hashes) |
| `POST /systems` | `{id, name, monthly_token_cap?}` | `201 {id, token}`; `400`, `409 exists` |
| `POST /systems/:id/rotate` | | `{id, token}`; the old token stops working |
| `PATCH /systems/:id` | `{name?, monthly_token_cap?, disabled?}` | the system |
| `GET /usage?month=YYYY-MM` | | `{month, rows}` per system, provider and model |

## Local development and tests

Same install as `services/id` (needs a GitHub Packages token for `@xdev-asia/ui`).

```sh
corepack pnpm --filter llm run typecheck
corepack pnpm --filter llm run test        # Worker, in workerd with a fake upstream
corepack pnpm --filter llm run test:web    # console, jsdom
corepack pnpm --filter llm run build
```

Local secrets go in `services/llm/.dev.vars` (git-ignored).
