import { Hono, type Context } from "hono";
import { presentedToken, systemForToken, type System } from "./auth";
import { accountFailure, candidatesFor, noteFailure, noteSuccess, type Candidate } from "./connections";
import type { AppEnv, Env } from "./env";
import { anthropicError } from "./errors";
import { allowedPatterns, allows, parseModel, targetName } from "./providers";
import { anyOn, applySavers, saversFor } from "./savers";
import { getTokenSaver } from "./settings";
import { EMPTY, recordUsage, tokensThisMonth, usageOfMessage, usageOfStream, type Usage } from "./usage";

export type Upstream = (req: Request) => Promise<Response>;

const PROVIDER = "anthropic";

/** Request headers passed on to Anthropic. Everything else (cookies, the gateway token, client hints) stays here. */
const FORWARD_REQUEST = ["anthropic-version", "anthropic-beta", "content-type", "accept"];

/** Response headers dropped: the body is re-streamed, so its length and encoding no longer hold. */
const DROP_RESPONSE = ["content-length", "content-encoding", "transfer-encoding", "set-cookie"];

export type GateFailure = {
  ok: false;
  status: 401 | 403 | 429 | 500;
  kind: "authentication" | "permission" | "not_configured" | "cap";
  message: string;
  /** Tells the official SDKs not to retry (`x-should-retry: false`). */
  noRetry: boolean;
};

/** Who is calling (gateway token) and whether that system may call now (enabled, under its cap). */
export async function checkSystem(env: Env, req: Request, metered: boolean): Promise<{ ok: true; system: System } | GateFailure> {
  const token = presentedToken(req);
  const system = token ? await systemForToken(env.DB, token) : null;
  if (!system) return { ok: false, status: 401, kind: "authentication", message: "invalid gateway token", noRetry: false };
  if (system.disabled) return { ok: false, status: 403, kind: "permission", message: "this system is disabled", noRetry: false };

  // Checked before the request, so one request may go over the cap; the next one is refused.
  if (metered && system.monthly_token_cap !== null) {
    const used = await tokensThisMonth(env.DB, system.id);
    if (used >= system.monthly_token_cap) {
      return { ok: false, status: 429, kind: "cap", message: "monthly token cap reached for this system", noRetry: true };
    }
  }
  return { ok: true, system };
}

const ANTHROPIC_TYPE = { authentication: "authentication_error", permission: "permission_error", not_configured: "api_error", cap: "rate_limit_error" } as const;

async function gate(c: Context<AppEnv>, metered: boolean): Promise<{ ok: true; system: System } | { ok: false; res: Response }> {
  const g = await checkSystem(c.env, c.req.raw, metered);
  if (g.ok) return g;
  return { ok: false, res: anthropicError(c, g.status, ANTHROPIC_TYPE[g.kind], g.message, g.noRetry) };
}

const noKey = (c: Context<AppEnv>) => anthropicError(c, 500, "api_error", "not_configured: no Anthropic key for this system", true);

/** "<message>" of an Anthropic error body, for the account's last error. Never request content. */
async function errorMessage(up: Response): Promise<string> {
  const body = (await up.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" ? body.error.message : `upstream error ${up.status}`;
}

function retryAfterOf(up: Response): number | null {
  const ra = Number(up.headers.get("retry-after"));
  return Number.isFinite(ra) && ra > 0 ? ra : null;
}

/**
 * Sends the request with each Anthropic account in turn (connections.ts) and returns the first answer that is
 * not an account failure (429, 5xx, refused key), or the last account's answer as it came. An account that
 * failed is set aside, and its attempt gets a usage row when `metered`. Null: no account and no key.
 */
async function sendWithAccounts(c: Context<AppEnv>, upstream: Upstream, system: System, path: string, body: ArrayBuffer, metered: boolean, rtkSaved: number): Promise<Response | null> {
  const now = Math.floor(Date.now() / 1000);
  let failed: { up: Response; cand: Candidate } | null = null;
  for (const cand of await candidatesFor(c.env, "anthropic", system.id, now)) {
    const key = await cand.key();
    if (!key) continue;
    if (failed) {
      // There is another account to try: this failure is not the client's answer.
      if (metered) record(c, system, failed.up, false, Promise.resolve(EMPTY), PROVIDER, rtkSaved);
      await noteFailure(c.env.DB, failed.cand, failed.up.status, await errorMessage(failed.up), retryAfterOf(failed.up), now);
    }
    const up = await upstream(upstreamRequest(c, path, key, body));
    if (!accountFailure(up.status)) {
      c.executionCtx.waitUntil(noteSuccess(c.env.DB, cand, now).catch(() => undefined));
      return up;
    }
    failed = { up, cand };
  }
  if (!failed) return null;
  // The last account's failure goes to the client untouched; a copy tells the console why the account is set aside.
  const { up, cand } = failed;
  if (cand.connection !== null) {
    const copy = up.clone();
    c.executionCtx.waitUntil(
      errorMessage(copy)
        .then((m) => noteFailure(c.env.DB, cand, up.status, m, retryAfterOf(up), now))
        .catch(() => undefined),
    );
  }
  return up;
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

export function record(c: Context<AppEnv>, system: System, up: Response, streamed: boolean, usage: Promise<Usage>, provider: string = PROVIDER, rtkSaved = 0): void {
  const requestId = up.headers.get("request-id");
  c.executionCtx.waitUntil(
    usage
      .catch(() => EMPTY)
      .then((u) =>
        // Taken when the usage is known: for a stream, that is its last byte.
        recordUsage(c.env.DB, { ...u, system_id: system.id, provider, request_id: requestId, status: up.status, streamed, rtk_saved_bytes: rtkSaved, latency_ms: Date.now() - c.get("startedAt") }),
      )
      // Logs the system and status only: never keys, tokens or content.
      .catch((e: unknown) => console.error("usage record failed", system.id, up.status, e instanceof Error ? e.name : "error")),
  );
}

/** /anthropic forwards Claude models only, and only those the system may call. */
function modelRefused(c: Context<AppEnv>, system: System, body: ArrayBuffer): Response | null {
  let model: unknown;
  try {
    model = (JSON.parse(new TextDecoder().decode(body)) as { model?: unknown }).model;
  } catch {
    return null; // not JSON: Anthropic answers with its own 400
  }
  if (typeof model !== "string") return null; // no model: Anthropic answers with its own 400
  const ref = parseModel(model);
  if (!ref || ref.kind !== "target" || ref.target.provider !== "anthropic") {
    return anthropicError(c, 404, "not_found_error", "this surface serves Claude models; use /openai/v1 for other providers and combos");
  }
  if (!allows(allowedPatterns(system.allowed_models), targetName(ref.target))) {
    return anthropicError(c, 403, "permission_error", "this system may not use this model");
  }
  return null;
}

export function anthropicRoutes(upstream: Upstream): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/v1/messages", async (c) => {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    let body = await c.req.arrayBuffer();
    const refused = modelRefused(c, g.system, body);
    if (refused) return refused;
    // Token savers rewrite the body; with none on, the client's bytes go upstream untouched.
    // Headroom is not applied here: it only takes requests in OpenAI shape (see /openai/v1).
    const savers = saversFor(g.system, c.req.raw, await getTokenSaver(c.env.DB));
    let rtkSaved = 0;
    if (anyOn(savers)) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
        rtkSaved = applySavers(parsed, "anthropic", savers);
        body = new TextEncoder().encode(JSON.stringify(parsed)).buffer as ArrayBuffer;
      } catch {
        // not JSON: forwarded as is, Anthropic answers 400
      }
    }
    const up = await sendWithAccounts(c, upstream, g.system, "/v1/messages", body, true, rtkSaved);
    if (!up) return noKey(c);
    const headers = responseHeaders(up);

    if (!up.body) {
      record(c, g.system, up, false, Promise.resolve(EMPTY), PROVIDER, rtkSaved);
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
      PROVIDER,
      rtkSaved,
    );
    return new Response(toClient, { status: up.status, headers });
  });

  // Free on Anthropic's side: no cap check, no usage row.
  r.post("/v1/messages/count_tokens", async (c) => {
    const g = await gate(c, false);
    if (!g.ok) return g.res;
    const body = await c.req.arrayBuffer();
    const refused = modelRefused(c, g.system, body);
    if (refused) return refused;
    const up = await sendWithAccounts(c, upstream, g.system, "/v1/messages/count_tokens", body, false, 0);
    if (!up) return noKey(c);
    return new Response(up.body, { status: up.status, headers: responseHeaders(up) });
  });

  r.all("*", (c) => anthropicError(c, 404, "not_found_error", "this gateway forwards only /v1/messages and /v1/messages/count_tokens"));

  return r;
}
