import { Hono, type Context } from "hono";
import { presentedToken, systemForToken, type System } from "./auth";
import { accountFailure, candidatesFor, noteFailure, noteSuccess, type Candidate } from "./connections";
import type { AppEnv, Env } from "./env";
import { anthropicError } from "./errors";
import { allowedPatterns, allows, anthropicBase, isCustomProvider, parseModel, providerDef, targetName, type ProviderId } from "./providers";
import { anyOn, applySavers, saversFor } from "./savers";
import { getTokenSaver } from "./settings";
import { clientGone } from "./timeouts";
import { runMessages } from "./messages";
import { resolveModel } from "./route";
import { estimateTokens } from "./translate/anthropic-openai";
import { EMPTY, recordUsage, tokensThisMonth, usageOfMessage, usageOfStream, type Usage } from "./usage";

export type Upstream = (req: Request) => Promise<Response>;

const PROVIDER: ProviderId = "anthropic";

/** Request headers passed on to Anthropic. Everything else (cookies, the gateway token, client hints) stays here. */
const FORWARD_REQUEST = ["anthropic-version", "anthropic-beta", "content-type", "accept"];
const OAUTH_BETA = "oauth-2025-04-20";

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

const noKey = (c: Context<AppEnv>, provider: ProviderId) =>
  anthropicError(c, 500, "api_error", provider === PROVIDER ? "not_configured: no Anthropic key for this system" : `not_configured: no connection for ${provider}`, true);

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
async function sendWithAccounts(c: Context<AppEnv>, upstream: Upstream, system: System, provider: ProviderId, path: string, body: ArrayBuffer, metered: boolean, rtkSaved: number): Promise<Response | null> {
  const now = Math.floor(Date.now() / 1000);
  let failed: { up: Response; cand: Candidate } | null = null;
  // A subscription login with no usable token: its answer, if no account does better.
  let keyFailure: Response | null = null;
  const oauth = providerDef(provider).auth === "oauth";
  for (const cand of await candidatesFor(c.env, provider, system.id, now, upstream)) {
    if (clientGone()) return clientClosed();
    const key = await cand.key();
    if (key && typeof key !== "string") {
      keyFailure ??= authFailure(key);
      await noteFailure(c.env.DB, cand, key.status, key.error, null, now);
      continue;
    }
    if (typeof key !== "string") continue;
    if (failed) {
      // There is another account to try: this failure is not the client's answer.
      if (metered) record(c, system, failed.up, false, Promise.resolve(EMPTY), provider, rtkSaved);
      await noteFailure(c.env.DB, failed.cand, failed.up.status, await errorMessage(failed.up), retryAfterOf(failed.up), now);
    }
    c.set("connection", cand.connection);
    let up: Response;
    try {
      up = await upstream(upstreamRequest(c, provider, path, key, body, oauth));
      // A subscription token refused before it expired (revoked, or renewed elsewhere): renew it once and send again.
      if (up.status === 401 && oauth) {
        const renewed = await cand.key(true);
        if (typeof renewed === "string") up = await upstream(upstreamRequest(c, provider, path, renewed, body, oauth));
      }
    } catch {
      if (clientGone()) return clientClosed();
      // The provider could not be reached: like a 5xx, the account is set aside and the next one is tried.
      up = Response.json({ type: "error", error: { type: "api_error", message: `could not reach ${provider}` } }, { status: 502 });
    }
    if (!accountFailure(up.status)) {
      c.executionCtx.waitUntil(noteSuccess(c.env.DB, cand, now).catch(() => undefined));
      return up;
    }
    failed = { up, cand };
  }
  if (!failed) return keyFailure;
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

/** The client went away (FR-SEL-18): no account is set aside and no other one is tried. */
const clientClosed = () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "client closed the request" } }, { status: 499 });

/** 401: sign in again; 502: the sign-in service is down. The message never holds a token (oauth.ts). */
const authFailure = (f: { error: string; status: number }) =>
  Response.json({ type: "error", error: { type: f.status === 401 ? "authentication_error" : "api_error", message: f.error } }, { status: f.status, headers: { "x-should-retry": "false" } });

function upstreamRequest(c: Context<AppEnv>, provider: ProviderId, path: string, key: string, body: ArrayBuffer, oauth = false): Request {
  const base = anthropicBase(c.env, provider);
  // Keeps `?beta=true`, which the SDK adds on beta endpoints; drops `key`, where a caller may put the gateway token.
  const params = new URL(c.req.url).searchParams;
  params.delete("key");
  const query = params.toString();
  const search = query ? `?${query}` : "";
  const headers = new Headers();
  for (const h of FORWARD_REQUEST) {
    const v = c.req.header(h);
    if (v !== undefined) headers.set(h, v);
  }
  if (oauth) {
    // A subscription login (Claude Code) sends its OAuth access token as a bearer, with the beta that accepts it.
    const betas = (headers.get("anthropic-beta") ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== OAUTH_BETA);
    headers.set("anthropic-beta", [OAUTH_BETA, ...betas].join(","));
    headers.set("authorization", `Bearer ${key}`);
  } else {
    headers.set("x-api-key", key);
  }
  return new Request(base + path + search, { method: "POST", headers, body });
}

function responseHeaders(up: Response): Headers {
  const h = new Headers(up.headers);
  for (const name of DROP_RESPONSE) h.delete(name);
  h.set("cache-control", "no-store");
  return h;
}

export function record(c: Context<AppEnv>, system: System, up: Response, streamed: boolean, usage: Promise<Usage>, provider: string = PROVIDER, rtkSaved = 0): void {
  // The console's model test runs as no system and leaves no usage row.
  if (system.id === "") return;
  const requestId = up.headers.get("request-id");
  // Read now: the next account's attempt changes it.
  const connection = c.get("connection") ?? null;
  c.executionCtx.waitUntil(
    usage
      .catch(() => EMPTY)
      .then((u) =>
        // Taken when the usage is known: for a stream, that is its last byte.
        recordUsage(c.env.DB, { ...u, system_id: system.id, provider, request_id: requestId, status: up.status, streamed, rtk_saved_bytes: rtkSaved, latency_ms: Date.now() - c.get("startedAt"), connection_id: connection }),
      )
      // Logs the system and status only: never keys, tokens or content.
      .catch((e: unknown) => console.error("usage record failed", system.id, up.status, e instanceof Error ? e.name : "error")),
  );
}

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).buffer as ArrayBuffer;

/** The request body as a JSON object with a string `model`, or null (then it goes to Anthropic, which answers 400). */
function bodyWithModel(body: ArrayBuffer): (Record<string, unknown> & { model: string }) | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { model?: unknown }).model === "string") return parsed as Record<string, unknown> & { model: string };
  } catch {
    // not JSON
  }
  return null;
}

/**
 * Whether `model` is sent to an Anthropic-format provider as the client sent it: Claude models, the Claude
 * subscription (`claude/`, a sign-in) and the owner's Anthropic-compatible providers. Everything else (other
 * providers, combos, aliases) is translated and routed as chat (messages.ts).
 */
function passthroughTarget(model: string): { provider: ProviderId; model: string; custom: boolean } | null {
  const ref = parseModel(model);
  const t = ref?.kind === "target" ? ref.target : null;
  if (!t) return null;
  if (t.provider === PROVIDER) return { ...t, custom: false };
  const custom = providerDef(t.provider).format === "anthropic" && (isCustomProvider(t.provider) || providerDef(t.provider).auth === "oauth");
  return custom ? { ...t, custom: true } : null;
}

/**
 * The model to forward as sent, or null to translate. A name that only an alias makes a Claude model (with no
 * `(level)` suffix, which only the chat router applies) is forwarded too, as the model it stands for.
 */
async function forwardedModel(db: D1Database, model: string): Promise<string | null> {
  if (passthroughTarget(model)) return model;
  const r = await resolveModel(db, model);
  const t = r?.ref.kind === "target" && !r.thinking ? r.ref.target : null;
  if (!t || !passthroughTarget(targetName(t))) return null;
  return t.provider === PROVIDER ? t.model : targetName(t);
}

/**
 * Removes thinking blocks with no signature from earlier assistant turns. A translated turn (messages.ts) makes them;
 * Anthropic checks the signatures it gets back, so an empty one would make it refuse the request. Signed blocks stay.
 * True when something was removed.
 */
function dropUnsignedThinking(req: Record<string, unknown>): boolean {
  let dropped = false;
  for (const m of Array.isArray(req.messages) ? req.messages : []) {
    if (!m || typeof m !== "object" || (m as { role?: unknown }).role !== "assistant") continue;
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const kept = content.filter((b) => !(b && typeof b === "object" && (b as { type?: unknown }).type === "thinking" && !(b as { signature?: unknown }).signature));
    if (kept.length !== content.length && kept.length > 0) {
      (m as { content: unknown[] }).content = kept;
      dropped = true;
    }
  }
  return dropped;
}

/**
 * /anthropic forwards Claude models, and the models of the owner's Anthropic-compatible providers
 * (`<id>/<model>`, sent upstream as `<model>`), only those the system may call.
 * A body that is not JSON, or has no model, goes to Anthropic, which answers with its own 400.
 */
function routeOf(c: Context<AppEnv>, system: System, body: ArrayBuffer): { res: Response } | { provider: ProviderId; body: ArrayBuffer } {
  const parsed = bodyWithModel(body);
  if (!parsed) return { provider: PROVIDER, body };
  const t = passthroughTarget(parsed.model);
  if (!t) return { res: anthropicError(c, 404, "not_found_error", "not an Anthropic-format model") };
  const custom = t.custom;
  if (!allows(allowedPatterns(system.allowed_models), targetName(t))) {
    return { res: anthropicError(c, 403, "permission_error", "this system may not use this model") };
  }
  // Anthropic's own model goes as the client sent it; a custom provider's without its prefix.
  return { provider: t.provider, body: custom ? encode({ ...(parsed as object), model: t.model }) : body };
}

export function anthropicRoutes(upstream: Upstream): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/v1/messages", async (c) => {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    let raw = await c.req.arrayBuffer();
    // Another provider or a combo: translated to chat and back (messages.ts), metered by the chat router.
    const parsed = bodyWithModel(raw);
    if (parsed) {
      const forwarded = await forwardedModel(c.env.DB, parsed.model);
      if (forwarded === null) return runMessages(c, upstream, g.system, parsed);
      const renamed = forwarded !== parsed.model;
      if (renamed) parsed.model = forwarded;
      if (dropUnsignedThinking(parsed) || renamed) raw = encode(parsed);
    }
    const route = routeOf(c, g.system, raw);
    if ("res" in route) return route.res;
    const { provider } = route;
    let body = route.body;
    // Token savers rewrite the body; with none on, the client's bytes go upstream untouched.
    // Headroom is not applied here: it only takes requests in OpenAI shape (see /openai/v1).
    const savers = saversFor(g.system, c.req.raw, await getTokenSaver(c.env.DB));
    let rtkSaved = 0;
    if (anyOn(savers)) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
        rtkSaved = applySavers(parsed, "anthropic", savers);
        body = encode(parsed);
      } catch {
        // not JSON: forwarded as is, Anthropic answers 400
      }
    }
    const up = await sendWithAccounts(c, upstream, g.system, provider, "/v1/messages", body, true, rtkSaved);
    if (!up) return noKey(c, provider);
    // The client is gone: nothing to meter, no one to answer.
    if (up.status === 499) return up;
    const headers = responseHeaders(up);

    if (!up.body) {
      record(c, g.system, up, false, Promise.resolve(EMPTY), provider, rtkSaved);
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
      provider,
      rtkSaved,
    );
    return new Response(toClient, { status: up.status, headers });
  });

  // Free on Anthropic's side: no cap check, no usage row.
  r.post("/v1/messages/count_tokens", async (c) => {
    const g = await gate(c, false);
    if (!g.ok) return g.res;
    let raw = await c.req.arrayBuffer();
    // Another provider or a combo: a local estimate (FR-API-05), no provider call.
    const parsed = bodyWithModel(raw);
    if (parsed) {
      const forwarded = await forwardedModel(c.env.DB, parsed.model);
      if (forwarded === null) return Response.json({ input_tokens: estimateTokens(parsed) }, { headers: { "cache-control": "no-store" } });
      const renamed = forwarded !== parsed.model;
      if (renamed) parsed.model = forwarded;
      if (dropUnsignedThinking(parsed) || renamed) raw = encode(parsed);
    }
    const route = routeOf(c, g.system, raw);
    if ("res" in route) return route.res;
    const up = await sendWithAccounts(c, upstream, g.system, route.provider, "/v1/messages/count_tokens", route.body, false, 0);
    if (!up) return noKey(c, route.provider);
    return new Response(up.body, { status: up.status, headers: responseHeaders(up) });
  });

  r.all("*", (c) => anthropicError(c, 404, "not_found_error", "this gateway forwards only /v1/messages and /v1/messages/count_tokens"));

  return r;
}
