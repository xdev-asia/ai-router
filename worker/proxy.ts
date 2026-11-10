import { Hono, type Context } from "hono";
import { anthropicKeyFor, presentedToken, systemForToken, type System } from "./auth";
import type { AppEnv } from "./env";
import { anthropicError } from "./errors";
import { EMPTY, recordUsage, tokensThisMonth, usageOfMessage, usageOfStream, type Usage } from "./usage";

export type Upstream = (req: Request) => Promise<Response>;

const PROVIDER = "anthropic";

/** Request headers passed on to Anthropic. Everything else (cookies, the gateway token, client hints) stays here. */
const FORWARD_REQUEST = ["anthropic-version", "anthropic-beta", "content-type", "accept"];

/** Response headers dropped: the body is re-streamed, so its length and encoding no longer hold. */
const DROP_RESPONSE = ["content-length", "content-encoding", "transfer-encoding", "set-cookie"];

type Gate = { ok: true; system: System; key: string } | { ok: false; res: Response };

async function gate(c: Context<AppEnv>, metered: boolean): Promise<Gate> {
  const token = presentedToken(c.req.raw);
  const system = token ? await systemForToken(c.env.DB, token) : null;
  if (!system) return { ok: false, res: anthropicError(c, 401, "authentication_error", "invalid gateway token") };
  if (system.disabled) return { ok: false, res: anthropicError(c, 403, "permission_error", "this system is disabled") };

  const key = anthropicKeyFor(c.env, system.id);
  if (!key) return { ok: false, res: anthropicError(c, 500, "api_error", "not_configured: no Anthropic key for this system", true) };

  // Checked before the request, so one request may go over the cap; the next one is refused.
  if (metered && system.monthly_token_cap !== null) {
    const used = await tokensThisMonth(c.env.DB, system.id);
    if (used >= system.monthly_token_cap) {
      return { ok: false, res: anthropicError(c, 429, "rate_limit_error", "monthly token cap reached for this system", true) };
    }
  }
  return { ok: true, system, key };
}

function upstreamRequest(c: Context<AppEnv>, path: string, key: string, body: ArrayBuffer): Request {
  const base = c.env.ANTHROPIC_BASE_URL.replace(/\/+$/, "");
  const search = new URL(c.req.url).search; // keeps `?beta=true`, which the SDK adds on beta endpoints
  const headers = new Headers();
  for (const h of FORWARD_REQUEST) {
    const v = c.req.header(h);
    if (v !== undefined) headers.set(h, v);
  }
  headers.set("x-api-key", key);
  return new Request(base + path + search, { method: "POST", headers, body });
}

function responseHeaders(up: Response): Headers {
  const h = new Headers(up.headers);
  for (const name of DROP_RESPONSE) h.delete(name);
  h.set("cache-control", "no-store");
  return h;
}

function record(c: Context<AppEnv>, system: System, up: Response, streamed: boolean, usage: Promise<Usage>): void {
  const requestId = up.headers.get("request-id");
  c.executionCtx.waitUntil(
    usage
      .catch(() => EMPTY)
      .then((u) =>
        recordUsage(c.env.DB, { ...u, system_id: system.id, provider: PROVIDER, request_id: requestId, status: up.status, streamed }),
      )
      // Logs the system and status only: never keys, tokens or content.
      .catch((e: unknown) => console.error("usage record failed", system.id, up.status, e instanceof Error ? e.name : "error")),
  );
}

export function anthropicRoutes(upstream: Upstream): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/v1/messages", async (c) => {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    const up = await upstream(upstreamRequest(c, "/v1/messages", g.key, await c.req.arrayBuffer()));
    const headers = responseHeaders(up);

    if (!up.body) {
      record(c, g.system, up, false, Promise.resolve(EMPTY));
      return new Response(null, { status: up.status, headers });
    }
    const streamed = (up.headers.get("content-type") ?? "").includes("text/event-stream");
    const [toClient, toMeter] = up.body.tee();
    record(
      c,
      g.system,
      up,
      streamed,
      streamed ? usageOfStream(toMeter) : new Response(toMeter).json().then(usageOfMessage),
    );
    return new Response(toClient, { status: up.status, headers });
  });

  // Free on Anthropic's side: no cap check, no usage row.
  r.post("/v1/messages/count_tokens", async (c) => {
    const g = await gate(c, false);
    if (!g.ok) return g.res;
    const up = await upstream(upstreamRequest(c, "/v1/messages/count_tokens", g.key, await c.req.arrayBuffer()));
    return new Response(up.body, { status: up.status, headers: responseHeaders(up) });
  });

  r.all("*", (c) => anthropicError(c, 404, "not_found_error", "this gateway forwards only /v1/messages and /v1/messages/count_tokens"));

  return r;
}
