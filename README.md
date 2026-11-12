# xDev LLM gateway

One place that holds the provider keys for every xDev system (chat, `xdevd`, ...). A Cloudflare Worker (Hono)
backed by D1, with an owner console built from `@xdev-asia/ui`.

Each system keeps using the provider's official SDK and only changes the base URL and the key:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.LLM_GATEWAY_TOKEN, baseURL: "https://<gateway host>/anthropic" });
```

## Where the ideas come from

The feature set and the console's layout follow [9router](https://github.com/decolua/9router) (MIT): provider
connections with fallback between accounts, round robin, combos, token savers, usage, and the Providers pages.
The code here is written anew for a Cloudflare Worker, D1 and `@xdev-asia/ui`, with two exceptions that are
9router's own files: the token-saver filters under `worker/savers/vendor/` (see
`worker/savers/THIRD_PARTY_NOTICES.md`), and the names, base URLs and key pages of the providers added in
`worker/providers.ts`. `docs/9router/` holds screenshots of its dashboard and a page-by-page comparison.

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
| `PROVIDER_KEYS` | secret | JSON object, provider id -> its official API key: `{"openai": "sk-...", "gemini": "...", "openrouter": "sk-or-...", "deepseek": "sk-...", "groq": "gsk_..."}`. Shared by the systems allowed to use that provider |
| `CONNECTIONS_KEY` | secret | 32 random bytes, base64 (`openssl rand -base64 32`). Seals the credentials of the connections stored in D1. Unset: connections cannot be added or used. Changing it makes the stored connections unreadable |
| `OIDC_CLIENT_SECRET` | secret | This gateway's client secret at xDev ID |
| `ANTHROPIC_BASE_URL` | var | `https://api.anthropic.com` |
| `OIDC_ISSUER` | var | `https://id.xdev.asia/api/auth` |
| `OIDC_CLIENT_ID` | var | This gateway's client id at xDev ID. Empty: xDev ID sign-in is off |
| `CONSOLE_EMAILS` | var | Comma-separated xDev account emails (verified) allowed into the console |

```sh
corepack pnpm exec wrangler d1 create xdev-llm        # put the id in wrangler.jsonc
corepack pnpm exec wrangler d1 migrations apply xdev-llm --remote
openssl rand -base64 32 | tee /dev/tty | tr -d '\n' | shasum -a 256 | cut -d' ' -f1 \
  | corepack pnpm exec wrangler secret put ADMIN_TOKEN_SHA256   # keep the printed token
corepack pnpm exec wrangler secret put ANTHROPIC_KEYS            # {"chat":"sk-ant-...","xdevd":"sk-ant-..."}
```

Then pick a hostname (a route in `wrangler.jsonc`), deploy, open the console, sign in and add the systems.
Each system's token is shown once.

xDev ID sign-in: register the gateway at xDev ID (a super admin, from `services/id` in the `cloud` repo), put the client id in
`OIDC_CLIENT_ID` and the secret in `OIDC_CLIENT_SECRET`:

```sh
XDEV_ADMIN_TOKEN=... node ../cloud/services/id/scripts/admin.mjs oauth-client "AI router" https://<host>/auth/callback
corepack pnpm exec wrangler secret put OIDC_CLIENT_SECRET
```

## Console

`/` serves the console (`web/`, built into `dist/`). Hash routes: `#/systems`, `#/providers`, `#/providers/<id>`, `#/combos`, `#/usage`.

Two ways in:

- **xDev ID** (OpenID Connect, code flow with PKCE, confidential client). `/auth/login` starts it,
  `/auth/callback` finishes it, `/auth/me` and `POST /auth/logout`. Only a verified email in
  `CONSOLE_EMAILS` gets a session: a random token in a `__Host-xllm_session` cookie (Secure, HttpOnly,
  SameSite=Lax, 12 hours), stored as its SHA-256 in `console_session`. The state is bound to the browser by
  a `__Host-xllm_login` cookie and is single use. Writes with the cookie must be same-origin.
- **The admin token**, kept in page memory only, never in storage or a cookie, so a reload signs out.

## OpenAI-compatible endpoint, providers and combos

For systems that only have an OpenAI SDK: `new OpenAI({ apiKey: <gateway token>, baseURL: "https://<host>/openai/v1" })`.
Metered, capped and refused exactly like `/anthropic`, whatever the provider.

`model` names a target or a combo:

| `model` | Goes to |
|---|---|
| `claude-*` or `anthropic/<model>` | Anthropic, translated to the Messages API (idea from 9router's translator, MIT; written anew) |
| `<provider>/<model>`: `openai`, `gemini`, `openrouter`, `deepseek`, `groq`, and 41 more OpenAI-compatible providers (`mistral`, `cerebras`, `together`, `fireworks`, ...; `GET /admin/providers` lists them) | that provider's API with a key from its connections or from `PROVIDER_KEYS`; the body is passed on with the bare model name. The 41 added ones take their base URLs from 9router's registry and have not been called against the live services here |
| `combo/<name>` | the combo's targets in order (below) |

Subscription logins (Claude Pro/Max, ChatGPT, Gemini CLI, Copilot...) are not built yet. The `connection` table
already holds `auth_type = 'oauth'` for them; no provider uses it so far.

## Connections: several accounts per provider

The idea of 9router's provider connections (MIT), written anew. A connection is one account at a provider, added
from the console or with `POST /admin/connections`. Its key is sealed with AES-256-GCM under `CONNECTIONS_KEY`
before it reaches D1, and no API answer returns it: only its last 4 characters (`hint`, for keys of 12 characters
or more).

For each request the gateway tries, for the target's provider:

1. the enabled connections that are not set aside, lowest `priority` first ("fill-first"), or, when the provider
   is set to "round-robin", the one that answered longest ago first;
2. the key in the environment (`ANTHROPIC_KEYS` for that system, `PROVIDER_KEYS`), when there is one;
3. the connections that are set aside, the one that comes back soonest first.

It moves to the next one only after a 429, a 5xx, a network failure or a refused key (401, 403), never after
another request error. A connection that failed this way is set aside for the provider's `retry-after`, else
30 s doubling with each failure in a row, at most 10 min; `last_error` keeps the status and the provider's message.
A success clears that. A connection whose secret cannot be opened (the key changed) is skipped.
Every attempt gets its own usage row. Both `/anthropic` and `/openai/v1` work this way; on `/anthropic` the last
account's answer is passed on as it came.

A combo still moves to its next target only after a 429, a 5xx or a network failure, once the accounts of the
current target are used up.

**Allow-list.** A system calls only the models its `allowed_models` allows: a JSON array of `*`, `provider/*`,
`provider/model` or `combo/name`. `null` (the default) means `anthropic/*`, so new providers cost nothing until a
system is allowed to use them. A combo's name in the list is enough for its targets.

**Combos** (`PUT /admin/combos/<name>` with `{targets: [...]}`). A combo moves to the next target only after a 429,
a 5xx or a network failure, or when a target's provider has no key, never after a request error (4xx). A target that
failed is put aside for its `retry-after` (default 30 s, at most 10 min) and tried last until then. The answer carries
`x-gateway-target`. Every attempt gets its own usage row.

Translation to Claude: text, images (https or base64 data URL), function tools and tool results, `tool_choice`,
`parallel_tool_calls`, `stop`, `temperature` (clamped to 0-1), `max_tokens` / `max_completion_tokens` (default 8192),
streaming with `stream_options.include_usage`. Refused with `400`: `n` other than 1, non-function tools, plain-http
image URLs, unknown roles. Thinking blocks are not returned. For other providers the gateway always asks for stream
usage (to meter) and drops that chunk when the client did not ask for it.

| Call | |
|---|---|
| `POST /openai/v1/chat/completions` | as above |
| `GET /openai/v1/models` | allowed Claude models, allowed combos, and exact `provider/model` entries of the allow-list |

Errors use the OpenAI envelope `{error: {message, type, param, code}}`; codes of the gateway's own refusals:
`invalid_api_key`, `system_disabled`, `monthly_token_cap`, `model_not_found`, `model_not_allowed`, `not_configured`.

## Token savers (per system, off by default)

Ported from 9router (MIT), which ports RTK (Apache-2.0) and adapts Caveman (Apache-2.0) and Ponytail (MIT); see
`worker/savers/THIRD_PARTY_NOTICES.md`. Set with `PATCH /admin/systems/:id`:

| Field | Effect |
|---|---|
| `rtk: true` | Rewrites successful tool results (Claude `tool_result`, OpenAI `role: "tool"`) over 500 bytes with a filter picked from their first 1 KB: git diff/log/status, grep, find, ls, tree, build output, repeated log lines, or the first 120 + last 60 lines. **Lossy**: long outputs are cut. Errors, user and assistant text are never touched |
| `caveman: "lite" \| "full" \| "ultra"` | Appends a terse-answer instruction to the system prompt (code, paths, commands, errors stay exact) |
| `ponytail: "lite" \| "full" \| "ultra"` | Appends a "minimal code, YAGNI first" instruction to the system prompt |

With all off the request bytes go upstream unchanged. One request can opt out with `x-gateway-token-saver: off`.
Each usage row records `rtk_saved_bytes`, so the effect can be measured against the token counts. The savings that
9router's README claims are not measured by its tests; measure them here before relying on them. [Inference] Caveman
and Ponytail change how the model answers: fit for coding agents, not for systems that need full prose.

## Admin API

All under `/admin`, `Authorization: Bearer <admin token>` or the console's xDev ID session cookie
(writes from the console's own origin only). A wrong token is refused even with a valid cookie.

| Call | Body | Answer |
|---|---|---|
| `GET /systems` | | systems (no token hashes) |
| `POST /systems` | `{id, name, monthly_token_cap?}` | `201 {id, token}`; `400`, `409 exists` |
| `POST /systems/:id/rotate` | | `{id, token}`; the old token stops working |
| `PATCH /systems/:id` | `{name?, monthly_token_cap?, disabled?, allowed_models?, rtk?, caveman?, ponytail?}` | the system |
| `GET /connections` | | connections, by provider and priority (no secrets) |
| `POST /connections` | `{provider, name, api_key}` | `201` the connection; `400`; `500 not_configured` without `CONNECTIONS_KEY` |
| `PATCH /connections/:id` | `{name?, disabled?, priority?, api_key?}` | the connection. A new `api_key` clears its cooldown and last error |
| `DELETE /connections/:id` | | `204`; `404` |
| `GET /providers` | | `[{id, name, format, auth, env_key, key_url, strategy}]`: the providers the gateway can reach; `env_key` says the environment holds a key |
| `PUT /providers/:id/strategy` | `{strategy: "fill-first" \| "round-robin"}` | `{provider, strategy}`; `400`; `404` |
| `POST /connections/:id/test` | | `{ok: true}` or `{ok: false, status, message}`: the provider's answer to a model-list request with the connection's key; `404` |
| `PUT /providers/:id/order` | `{ids: [...]}` (every connection of the provider, once each) | the provider's connections in the new order; `400`; `404` |
| `GET /combos` | | `[{name, targets, updated_at}]` |
| `PUT /combos/:name` | `{targets: ["provider/model", ...]}` (1-10) | the combo |
| `DELETE /combos/:name` | | `204`; `404` |
| `GET /usage?month=YYYY-MM` | | `{month, rows}` per system, provider and model |

## Local development and tests

The install needs a GitHub Packages token (`read:packages`) for `@xdev-asia/ui`, in `~/.npmrc`.

```sh
corepack pnpm run typecheck
corepack pnpm run test        # Worker, in workerd with a fake upstream
corepack pnpm run test:web    # console, jsdom
corepack pnpm run build
```

Local secrets go in `.dev.vars` (git-ignored).

### In Docker

`wrangler dev` (workerd, local D1) in a container, on http://localhost:8787 only:

```sh
corepack pnpm run build      # the console, on the host (needs the GitHub Packages token)
docker compose up --build    # .dev.vars is mounted read-only; the local D1 lives in a volume
```

Not the production runtime (that is Cloudflare Workers).
