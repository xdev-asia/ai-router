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
| `PROVIDER_KEYS` | secret | JSON object, provider id -> its official API key: `{"openai": "sk-...", "gemini": "...", "openrouter": "sk-or-...", "deepseek": "sk-...", "groq": "gsk_..."}`. Shared by the systems allowed to use that provider |
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

`/` serves the console (`web/`, built into `dist/`). Hash routes: `#/systems`, `#/usage`.

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
| `openai/<model>`, `gemini/<model>`, `openrouter/<vendor>/<model>`, `deepseek/<model>`, `groq/<model>` | that provider's OpenAI-compatible API with its official key from `PROVIDER_KEYS`; the body is passed on with the bare model name |
| `combo/<name>` | the combo's targets in order (below) |

Subscription logins (Claude Pro/Max, ChatGPT, Gemini CLI, Copilot...) are deliberately not supported.

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
