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
| `ADMIN_TOKEN_SHA256` | secret | SHA-256 hex of the owner's admin token. Unset: `/admin` and the console refuse everyone |
| `ANTHROPIC_BASE_URL` | var | `https://api.anthropic.com` |

```sh
cd services/llm
corepack pnpm exec wrangler d1 create xdev-llm        # put the id in wrangler.jsonc
corepack pnpm exec wrangler d1 migrations apply xdev-llm --remote
openssl rand -base64 32 | tee /dev/tty | tr -d '\n' | shasum -a 256 | cut -d' ' -f1 \
  | corepack pnpm exec wrangler secret put ADMIN_TOKEN_SHA256   # keep the printed token
corepack pnpm exec wrangler secret put ANTHROPIC_KEYS            # {"chat":"sk-ant-...","xdevd":"sk-ant-..."}
```

Then pick a hostname (a route in `wrangler.jsonc`), deploy, open the console, sign in with the admin token
and add the systems. Each system's token is shown once.

## Console

`/` serves the console (`web/`, built into `dist/`). Hash routes: `#/systems`, `#/usage`. The admin token is kept
in page memory only, never in storage or a cookie, so a reload signs out. [Inference] For more than one
operator, put Cloudflare Access in front of the console and `/admin/*`.

## Admin API

All under `/admin`, `Authorization: Bearer <admin token>`.

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
