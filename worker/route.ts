import type { Context } from "hono";
import type { System } from "./auth";
import { BLOCKED_MESSAGE, ENDED_EARLY, RELAY_ERROR_HEADER, RELAY_SECRET_HEADER, isBlockPage, type Step, chatToCodex, codexHeaders, codexSteps, codexToChatStream, readCodex } from "./codex";
import { accountFailure, candidatesFor, noteFailure, noteSuccess, type Candidate } from "./connections";
import { providerHeaders } from "./provider-headers";
import { codexDestinationFor } from "./proxy-pools";
import type { AppEnv } from "./env";
import { ANTHROPIC_VERSION, COMBO_NAME, anthropicBase, allowedPatterns, allows, expandCombo, isModelName, parseModel, providerDef, targetName, usageOfOpenAI, type ModelRef, type Target } from "./providers";
import { applyThinking, disabledSet, getAlias, getProviderThinking, inferProvider, stripMarkers, upstreamModel, type Thinking } from "./models";
import { record, type Upstream } from "./proxy";
import { chatToMessages, messageToChat, openaiErrorBody, streamToChat, TranslateError } from "./translate/openai-anthropic";
import { EMPTY, usageOfMessage, usageOfStream, type Usage } from "./usage";
import { headroomCompress } from "./headroom";
import { clientGone } from "./timeouts";
import { oauthRequestHeaders } from "./oauth";
import { cloudCodeWire } from "./cloudcode";
import { OFF, applySavers, saversFor, type Savers } from "./savers";
import { getTokenSaver } from "./settings";
import { responsesBody, wireFor, type Wire } from "./wire";
import { appliesTo, audiosIn, describeRequest, getAdapter, imagesIn, replaceAudio, replaceImages, transcribeRequest, type AdapterKind } from "./vision";
import {
  FUSION_DEFAULTS,
  ROUTER_TIMEOUT_MS,
  dropHeld,
  gather,
  getComboSettings,
  heldModel,
  holdModel,
  isStrategy,
  judgeRequest,
  lastUserText,
  orderByChoice,
  panelRequest,
  parseRouterAnswer,
  readConfig,
  rotate,
  routerRequest,
  thresholdOf,
  type ComboConfig,
  type Strategy,
} from "./combo-strategy";

export { ANTHROPIC_VERSION };

/** A combo target that failed this way is put aside for this long (or the provider's retry-after, at most 10 min). */
const COOLDOWN_S = 30;
const MAX_COOLDOWN_S = 600;

type Json = Record<string, unknown>;

export function errorResponse(status: number, message: string, type: string, code: string | null = null, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(openaiErrorBody(message, type, code)), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

/** 429 and 5xx (and network failures) may succeed on another target; anything else is the request's fault. */
const retryable = (status: number) => status === 429 || status >= 500;

/** `gateway`: the failure is the gateway's own (its set-up, or a refusal of where it runs), not the account's. */
type Attempt = { ok: true; res: Response } | { ok: false; res: Response; status: number; message: string; retryable: boolean; retryAfter: number | null; gateway?: true };

const gatewayFailure = (status: number, message: string, code: string, type = "server_error"): Attempt => ({
  ok: false,
  res: errorResponse(status, message, type, code, { "x-should-retry": "false" }),
  status,
  message,
  retryable: true,
  retryAfter: null,
  gateway: true,
});

/**
 * The client went away (FR-SEL-18): 499, the nginx code for it. Not the account's fault, so it is not set aside, and
 * nothing else is tried: no one is waiting for the answer.
 */
const clientClosed = (): Attempt => ({ ok: false, res: errorResponse(499, "client closed the request", "invalid_request_error", "client_closed"), status: 499, message: "client closed the request", retryable: false, retryAfter: null, gateway: true });

/** Rebuilds an upstream error (Anthropic or OpenAI shape) as an OpenAI error with the same status. */
async function failure(up: Response): Promise<Attempt> {
  const body = (await up.json().catch(() => ({}))) as { error?: { type?: unknown; message?: unknown; code?: unknown } | string; detail?: unknown; message?: unknown };
  const e = typeof body.error === "object" && body.error ? body.error : {};
  // `detail`: how the ChatGPT backend (Codex) words its refusals; a top-level `message`: AWS (Bedrock).
  const message =
    typeof e.message === "string" ? e.message : typeof body.error === "string" ? body.error : typeof body.detail === "string" ? body.detail : typeof body.message === "string" ? body.message : `upstream error ${up.status}`;
  const type = typeof e.type === "string" ? e.type : "api_error";
  const extra: Record<string, string> = {};
  for (const h of ["retry-after", "x-should-retry"]) {
    const v = up.headers.get(h);
    if (v) extra[h] = v;
  }
  const ra = Number(up.headers.get("retry-after"));
  return {
    ok: false,
    res: errorResponse(up.status, message, type, typeof e.code === "string" ? e.code : null, extra),
    status: up.status,
    message,
    retryable: retryable(up.status),
    retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null,
  };
}

async function callAnthropic(c: Context<AppEnv>, upstream: Upstream, system: System, key: string, target: Target, req: Json, savers: Savers, wire?: Wire): Promise<Attempt> {
  const messages = chatToMessages({ ...req, model: target.model });
  const saved = applySavers(messages, "anthropic", savers);
  const stream = messages.stream === true;
  const includeUsage = stream && (req.stream_options as Json | undefined)?.include_usage === true;
  // A subscription login sends its OAuth access token as a bearer: Claude Code with the beta that accepts it,
  // another (MiniMax Code) with its own headers.
  const auth: Record<string, string> =
    providerDef(target.provider).auth === "oauth"
      ? { ...(target.provider === "claude" ? { "anthropic-beta": "oauth-2025-04-20" } : await oauthRequestHeaders(c.env, target.provider, null)), authorization: `Bearer ${key}` }
      : { "x-api-key": key };
  let up = await upstream(
    wire
      ? await wire.request(messages)
      : new Request(anthropicBase(c.env, target.provider) + "/v1/messages", {
          method: "POST",
          headers: { ...auth, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
          body: JSON.stringify(messages),
        }),
  );
  if (wire?.response) up = wire.response(up, stream);
  if (!up.ok || !up.body) {
    record(c, system, up, false, Promise.resolve({ ...EMPTY, model: target.model }), target.provider, saved);
    return failure(up);
  }
  const [toClient, toMeter] = up.body.tee();
  if (stream) {
    record(c, system, up, true, usageOfStream(toMeter), target.provider, saved);
    return {
      ok: true,
      res: new Response(toClient.pipeThrough(streamToChat(target.model, includeUsage)), {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
      }),
    };
  }
  const msg: unknown = await new Response(toClient).json();
  record(c, system, up, false, new Response(toMeter).json().then(usageOfMessage), target.provider, saved);
  return { ok: true, res: Response.json(messageToChat(msg, target.model), { headers: { "cache-control": "no-store" } }) };
}

/**
 * Reads an OpenAI chat SSE stream for its usage chunk, and passes the stream on without that chunk when the
 * client did not ask for usage (the gateway always asks upstream, to meter).
 */
function meterOpenAIStream(body: ReadableStream<Uint8Array>, model: string, keepUsage: boolean): { client: ReadableStream<Uint8Array>; usage: Promise<Usage> } {
  let resolve!: (u: Usage) => void;
  const usage = new Promise<Usage>((r) => (resolve = r));
  let found: Usage = { ...EMPTY, model };
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  const event = (raw: string, ctrl: TransformStreamDefaultController<Uint8Array>) => {
    const data = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (data && data !== "[DONE]") {
      try {
        const ch = JSON.parse(data) as { usage?: unknown; model?: unknown; choices?: unknown[] };
        if (ch.usage) {
          found = usageOfOpenAI(typeof ch.model === "string" ? ch.model : model, ch.usage);
          if (!keepUsage && Array.isArray(ch.choices) && ch.choices.length === 0) return; // the usage-only chunk
        }
      } catch {
        // pass through as is
      }
    }
    ctrl.enqueue(enc.encode(raw + "\n\n"));
  };
  // The usage settles when the stream ends, fails (an idle timeout) or is cancelled, so no wait outlives it.
  const reader = body.getReader();
  const source = new ReadableStream<Uint8Array>({
    async pull(c) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (e) {
        resolve(found);
        c.error(e);
        return;
      }
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel(reason) {
      resolve(found);
      return reader.cancel(reason);
    },
  });
  const client = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, ctrl) {
        buf += dec.decode(bytes, { stream: true }).replace(/\r\n/g, "\n");
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          event(buf.slice(0, i), ctrl);
          buf = buf.slice(i + 2);
        }
      },
      flush(ctrl) {
        buf += dec.decode();
        if (buf.trim()) event(buf.trimEnd(), ctrl);
        resolve(found);
      },
    }),
  );
  return { client, usage };
}

async function callOpenAICompatible(c: Context<AppEnv>, upstream: Upstream, system: System, key: string, target: Target, req: Json, savers: Savers, extra: Record<string, string> = {}, wire?: Wire): Promise<Attempt> {
  const p = providerDef(target.provider) as { baseUrl: string; headers?: Readonly<Record<string, string>> };
  const stream = req.stream === true;
  const keepUsage = (req.stream_options as Json | undefined)?.include_usage === true;
  // A deep copy: savers rewrite messages in place, and a combo may send the same request to another target.
  const body: Json = { ...(structuredClone(req) as Json), model: target.model };
  const saved = applySavers(body, "openai", savers);
  if (stream) body.stream_options = { ...((req.stream_options as Json | undefined) ?? {}), include_usage: true };
  let up = await upstream(
    wire
      ? await wire.request(body)
      : new Request(`${p.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { ...p.headers, ...extra, authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  );
  if (wire?.response) up = wire.response(up, stream);
  if (!up.ok || !up.body) {
    record(c, system, up, false, Promise.resolve({ ...EMPTY, model: target.model }), target.provider, saved);
    return failure(up);
  }
  if (stream) {
    const { client, usage } = meterOpenAIStream(up.body, target.model, keepUsage);
    record(c, system, up, true, usage, target.provider, saved);
    return { ok: true, res: new Response(client, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } }) };
  }
  const out = (await up.json()) as Json;
  record(c, system, up, false, Promise.resolve(usageOfOpenAI(typeof out.model === "string" ? out.model : target.model, out.usage)), target.provider, saved);
  return { ok: true, res: Response.json(out, { headers: { "cache-control": "no-store" } }) };
}

const SSE_HEADERS = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" };

/** One chat request through a Codex account (worker/codex.ts): a Responses request out, a chat completion back. */
async function callCodex(c: Context<AppEnv>, upstream: Upstream, system: System, token: string, cand: Candidate, target: Target, req: Json, savers: Savers): Promise<Attempt> {
  const shaped = structuredClone(req) as Json;
  const saved = applySavers(shaped, "openai", savers);
  const stream = req.stream === true;
  const includeUsage = stream && (req.stream_options as Json | undefined)?.include_usage === true;
  const dest = await codexDestinationFor(c.env, cand.proxyPool);
  if (!dest.ok) return gatewayFailure(500, dest.message, "not_configured");
  const headers = codexHeaders(token, cand.account);
  // The owner's extra headers (provider-headers.ts) never replace the ones the gateway sets.
  for (const [k, v] of Object.entries(await providerHeaders(c.env.DB, "codex"))) if (!headers.has(k)) headers.set(k, v);
  if (dest.secret) headers.set(RELAY_SECRET_HEADER, dest.secret);
  // A pool's HTTP or SOCKS5 proxy comes with its own fetch (worker/socket-fetch.ts).
  const up = await (dest.fetch ?? upstream)(new Request(dest.url, { method: "POST", headers, body: JSON.stringify(chatToCodex(shaped, target.model)) }));
  if (dest.secret && up.headers.get(RELAY_ERROR_HEADER) === "relay_unauthorized") {
    record(c, system, up, false, Promise.resolve({ ...EMPTY, model: target.model }), target.provider, saved);
    return gatewayFailure(500, "not_configured: the Codex relay refused CODEX_RELAY_SECRET", "not_configured");
  }
  if (isBlockPage(up)) {
    record(c, system, up, false, Promise.resolve({ ...EMPTY, model: target.model }), target.provider, saved);
    await up.body?.cancel();
    return gatewayFailure(502, BLOCKED_MESSAGE, "codex_blocked", "api_error");
  }
  if (!up.ok || !up.body) {
    record(c, system, up, false, Promise.resolve({ ...EMPTY, model: target.model }), target.provider, saved);
    return failure(up);
  }
  if (stream) {
    // The first step decides the status: a failure reported before any answer is a 502, not a 200 with an error.
    const steps = codexSteps(up.body);
    let first: IteratorResult<Step>;
    try {
      first = await steps.next();
    } catch {
      first = { done: false, value: { kind: "failed", message: "the stream from the provider broke off" } };
    }
    if (first.done || first.value.kind === "failed") {
      const message = first.done ? ENDED_EARLY : first.value.kind === "failed" ? first.value.message : ENDED_EARLY;
      await steps.return(undefined).catch(() => undefined);
      record(c, system, new Response(null, { status: 502 }), false, Promise.resolve({ ...EMPTY, model: target.model }), target.provider, saved);
      return { ok: false, res: errorResponse(502, message, "api_error"), status: 502, message, retryable: true, retryAfter: null };
    }
    const { client, usage } = codexToChatStream(first.value, steps, target.model, includeUsage);
    record(c, system, up, true, usage, target.provider, saved);
    return { ok: true, res: new Response(client, { headers: SSE_HEADERS }) };
  }
  const answer = await readCodex(up.body, target.model);
  if (!answer.ok) {
    // The backend answered 200 and then reported a failure inside the stream.
    record(c, system, new Response(null, { status: 502 }), false, Promise.resolve({ ...EMPTY, model: target.model }), target.provider, saved);
    return { ok: false, res: errorResponse(502, answer.message, "api_error"), status: 502, message: answer.message, retryable: true, retryAfter: null };
  }
  record(c, system, up, false, Promise.resolve(answer.usage), target.provider, saved);
  return { ok: true, res: Response.json(answer.completion, { headers: { "cache-control": "no-store" } }) };
}

/**
 * One chat request to a provider's Responses API (wire.ts): always streamed upstream, read with Codex's reader
 * (the same events), answered as a chat completion or a chat stream.
 */
async function callResponses(c: Context<AppEnv>, upstream: Upstream, system: System, target: Target, req: Json, savers: Savers, wire: Wire): Promise<Attempt> {
  const shaped = structuredClone(req) as Json;
  const saved = applySavers(shaped, "openai", savers);
  const stream = req.stream === true;
  const includeUsage = stream && (req.stream_options as Json | undefined)?.include_usage === true;
  const up = await upstream(await wire.request({ ...responsesBody(shaped, target.model), stream: true }));
  const none = () => Promise.resolve({ ...EMPTY, model: target.model });
  if (!up.ok || !up.body) {
    record(c, system, up, false, none(), target.provider, saved);
    return failure(up);
  }
  const broke = (message: string): Attempt => {
    record(c, system, new Response(null, { status: 502 }), false, none(), target.provider, saved);
    return { ok: false, res: errorResponse(502, message, "api_error"), status: 502, message, retryable: true, retryAfter: null };
  };
  if (stream) {
    const steps = codexSteps(up.body);
    let first: IteratorResult<Step>;
    try {
      first = await steps.next();
    } catch {
      first = { done: false, value: { kind: "failed", message: "the stream from the provider broke off" } };
    }
    if (first.done || first.value.kind === "failed") {
      await steps.return(undefined).catch(() => undefined);
      return broke(!first.done && first.value.kind === "failed" ? first.value.message : ENDED_EARLY);
    }
    const { client, usage } = codexToChatStream(first.value, steps, target.model, includeUsage);
    record(c, system, up, true, usage, target.provider, saved);
    return { ok: true, res: new Response(client, { headers: SSE_HEADERS }) };
  }
  const answer = await readCodex(up.body, target.model);
  if (!answer.ok) return broke(answer.message);
  record(c, system, up, false, Promise.resolve(answer.usage), target.provider, saved);
  return { ok: true, res: Response.json(answer.completion, { headers: { "cache-control": "no-store" } }) };
}

async function coolingTargets(db: D1Database, names: string[], now: number): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const r = await db
    .prepare(`SELECT target FROM cooldown WHERE until > ? AND target IN (${names.map(() => "?").join(",")})`)
    .bind(now, ...names)
    .all<{ target: string }>();
  return new Set(r.results.map((x) => x.target));
}

/** Every combo's members, by name. The table is small (an owner's own list), so one read serves nesting. */
export async function loadCombos(db: D1Database): Promise<Map<string, string[]>> {
  const r = await db.prepare("SELECT name, targets FROM combo").all<{ name: string; targets: string }>();
  return new Map(r.results.map((x) => [x.name, JSON.parse(x.targets) as string[]]));
}

/** What one request carries through its attempts. */
interface Run {
  c: Context<AppEnv>;
  upstream: Upstream;
  system: System;
  now: number;
  savers: Savers;
  /** Whose keys to use, when not the system's own (the console's model test). */
  keySystem?: string;
  /** Provider Thinking modes to apply where the request sets no `reasoning_effort` (FR-MDL-06). */
  providerThinking: Record<string, string>;
}

/**
 * One target: the provider's accounts in order (connections.ts), the next one after a 429, a 5xx or a refused key
 * (401/403), never after another request error. Null when the provider has no key or connection at all.
 */
async function attemptTarget(run: Run, target: Target, req: Json): Promise<Attempt | null> {
  const { c, upstream, system, now, savers } = run;
  let attempt: Attempt | null = null;
  const format = providerDef(target.provider).format;
  const mode = run.providerThinking[target.provider];
  if (mode && req.reasoning_effort === undefined) req = { ...req, reasoning_effort: mode };
  // A catalog variant (`gpt-6-astra[1m]`) is sent as the model it stands for.
  target = { provider: target.provider, model: upstreamModel(target) };
  for (const cand of await candidatesFor(c.env, target.provider, run.keySystem ?? system.id, now, upstream)) {
    if (clientGone()) return clientClosed();
    const key = await cand.key();
    if (!key) continue;
    if (typeof key !== "string") {
      // A subscription login with no usable token (401: sign in again; 502: the sign-in service is down): say
      // so, set the account aside, try the next one. An answer from an earlier account is kept.
      attempt ??= { ok: false, res: errorResponse(key.status, key.error, key.status === 401 ? "authentication_error" : "api_error", "provider_auth"), status: key.status, message: key.error, retryable: true, retryAfter: null };
      await noteFailure(c.env.DB, cand, key.status, key.error, null, now);
      continue;
    }
    // The usage row names this account (record() reads it).
    c.set("connection", cand.connection);
    try {
      // A subscription's own headers (Kimi's device id, Kilo Code's organization).
      const extra = format === "openai" && providerDef(target.provider).auth === "oauth" ? await oauthRequestHeaders(c.env, target.provider, cand.account) : {};
      // A connection's own settings (wire.ts: region, endpoint, account id) and the URL or format they decide.
      const settings = (await cand.settings?.()) ?? {};
      const send = async (k: string): Promise<Attempt> => {
        const w = await wireFor(upstream, target.provider, target.model, k, settings);
        if (!w.ok) {
          if (w.status === 500) return gatewayFailure(500, w.message, w.code);
          const type = w.status === 400 ? "invalid_request_error" : w.status === 401 ? "authentication_error" : "api_error";
          return { ok: false, res: errorResponse(w.status, w.message, type, w.code), status: w.status, message: w.message, retryable: w.status !== 400, retryAfter: null };
        }
        const wire = w.wire;
        if (wire?.kind === "responses") return callResponses(c, upstream, system, target, req, savers, wire);
        if (wire?.kind === "anthropic") return callAnthropic(c, upstream, system, k, target, req, savers, wire);
        if (wire) return callOpenAICompatible(c, upstream, system, k, target, req, savers, {}, wire);
        // Gemini CLI and Antigravity: Cloud Code, with the Code Assist project the sign-in found (cloudcode.ts).
        if (format === "cloudcode") return callOpenAICompatible(c, upstream, system, k, target, req, savers, {}, cloudCodeWire(target.provider, k, cand.account ?? "", target.model));
        return format === "anthropic"
          ? callAnthropic(c, upstream, system, k, target, req, savers)
          : format === "codex"
            ? callCodex(c, upstream, system, k, cand, target, req, savers)
            : callOpenAICompatible(c, upstream, system, k, target, req, savers, extra);
      };
      attempt = await send(key);
      // A subscription token refused before it expired (revoked, or renewed elsewhere): renew it once and send again.
      if (!attempt.ok && attempt.status === 401 && providerDef(target.provider).auth === "oauth") {
        const renewed = await cand.key(true);
        if (typeof renewed === "string") attempt = await send(renewed);
        else if (renewed) attempt = { ok: false, res: errorResponse(renewed.status, renewed.error, renewed.status === 401 ? "authentication_error" : "api_error", "provider_auth"), status: renewed.status, message: renewed.error, retryable: true, retryAfter: null };
      }
    } catch (e) {
      if (e instanceof TranslateError) return { ok: false, res: errorResponse(400, e.message, "invalid_request_error"), status: 400, message: e.message, retryable: false, retryAfter: null };
      if (clientGone()) return clientClosed();
      attempt = { ok: false, res: errorResponse(502, `could not reach ${target.provider}`, "api_error"), status: 502, message: `could not reach ${target.provider}`, retryable: true, retryAfter: null };
    }
    if (attempt.ok) {
      c.executionCtx.waitUntil(noteSuccess(c.env.DB, cand, now).catch(() => undefined));
      break;
    }
    if (attempt.gateway || !accountFailure(attempt.status)) break;
    await noteFailure(c.env.DB, cand, attempt.status, attempt.message, attempt.retryAfter, now);
  }
  return attempt;
}

const notConfigured = (target: Target) => {
  const missing = providerDef(target.provider).auth === "oauth" ? `no ${target.provider} connection; sign in from the console` : `no ${target.provider} key`;
  return errorResponse(500, `not_configured: ${missing}`, "server_error", "not_configured", { "x-should-retry": "false" });
};

/**
 * Tries `order` in turn, moving on only after a 429/5xx or a missing key. In a combo a failed target cools down
 * (COOLDOWN_S, or the provider's retry-after) and the answer names the target that gave it (`x-gateway-target`).
 * `target` is the one that answered, or null.
 */
async function runOrder(run: Run, order: readonly Target[], req: Json, combo: boolean): Promise<{ res: Response; target: Target | null }> {
  let last: Response | null = null;
  for (const [i, target] of order.entries()) {
    const attempt = await attemptTarget(run, target, req);
    if (!attempt) {
      last = notConfigured(target);
      continue;
    }
    if (attempt.ok) {
      if (combo) attempt.res.headers.set("x-gateway-target", targetName(target));
      return { res: attempt.res, target };
    }
    last = attempt.res;
    if (!attempt.retryable || !combo) return { res: attempt.res, target: null };
    const until = run.now + Math.min(MAX_COOLDOWN_S, attempt.retryAfter ?? COOLDOWN_S);
    await run.c.env.DB.prepare("INSERT INTO cooldown (target, until) VALUES (?, ?) ON CONFLICT (target) DO UPDATE SET until = excluded.until")
      .bind(targetName(target), until)
      .run();
    if (i === order.length - 1) break;
  }
  return { res: last ?? errorResponse(500, "combo has no usable target", "server_error", "not_configured"), target: null };
}

/** Cooling targets go last, in their order, unless all are cooling. */
async function coolLast(db: D1Database, order: Target[], now: number): Promise<Target[]> {
  const cooling = await coolingTargets(db, order.map(targetName), now);
  return [...order.filter((t) => !cooling.has(targetName(t))), ...order.filter((t) => cooling.has(targetName(t)))];
}

/** The text of a non-streamed chat completion's first choice. */
async function answerText(res: Response): Promise<{ body: Json; text: string } | null> {
  const body = (await res.json().catch(() => null)) as Json | null;
  const choice = Array.isArray(body?.choices) ? (body!.choices as Json[])[0] : undefined;
  const msg = choice?.message as Json | undefined;
  const text = typeof msg?.content === "string" ? msg.content : "";
  return body && text.trim() ? { body, text } : null;
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(fallback)),
    );
  });

/** Smart router: asks the router model which member fits the last user message (FR-CMB-12, 13, 32). */
async function smartOrder(run: Run, name: string, order: Target[], config: ComboConfig, req: Json, session: string | null): Promise<Target[]> {
  const members = order.map(targetName);
  const policy = config.policy ?? "smart";
  const held = policy === "per-turn" ? null : heldModel(name, session, members);
  if (held && policy === "strict") return orderByChoice(order, held);
  const routerRef = parseModel(config.router_model);
  if (routerRef?.kind !== "target") return held ? orderByChoice(order, held) : order;
  const ask = (async () => {
    const a = await attemptTarget(run, routerRef.target, routerRequest(targetName(routerRef.target), members, lastUserText(req)));
    return a?.ok ? answerText(a.res) : null;
  })();
  const got = await withTimeout(ask, ROUTER_TIMEOUT_MS, null);
  const answer = got ? parseRouterAnswer(got.text) : null;
  if (answer && members.includes(answer.choice) && answer.confidence >= thresholdOf(config)) return orderByChoice(order, answer.choice, answer.probabilities);
  return held ? orderByChoice(order, held) : order;
}

/** Fusion: every member answers, a judge writes the answer (FR-CMB-14, 15, 30). */
async function fusion(run: Run, order: Target[], config: ComboConfig, req: Json): Promise<Response> {
  if (order.length === 1) return (await runOrder(run, order, req, true)).res;
  const ask = panelRequest(req);
  const calls = order.map(async (t) => {
    const a = await attemptTarget(run, t, ask);
    if (!a?.ok) return null;
    const got = await answerText(a.res);
    return got ? { target: t, ...got } : null;
  });
  const answers = await gather(calls, { ...FUSION_DEFAULTS, ...config.fusion });
  if (answers.length === 0) return errorResponse(503, "no model in the fusion combo answered", "api_error", "fusion_no_answer");
  // One answer has nothing to merge: that model answers the client's own request (with its stream and tools).
  if (answers.length === 1) return (await runOrder(run, [answers[0].target], req, true)).res;
  const judgeRef = parseModel(config.judge_model);
  const judge = judgeRef?.kind === "target" ? judgeRef.target : order[0];
  const verdict = await attemptTarget(run, judge, judgeRequest(req, answers.map((a) => a.text)));
  if (verdict?.ok) {
    verdict.res.headers.set("x-gateway-target", targetName(judge));
    return verdict.res;
  }
  // The judge failed: the first panel answer stands. [Inference: no documented reference behaviour for this case.]
  return Response.json(answers[0].body, { headers: { "cache-control": "no-store", "x-gateway-target": targetName(answers[0].target) } });
}

/**
 * What a request's `model` names (FR-MDL-01..04): its markers taken off, then for a bare name a combo, then an
 * alias (the alias's own suffix applies unless the request has one); then provider/model, claude-* or combo/name;
 * then a bare model name with its provider guessed. `thinking` is the suffix's thinking, if any.
 */
export async function resolveModel(db: D1Database, raw: string): Promise<{ ref: ModelRef; thinking: Thinking | null; combos: Map<string, string[]> | null } | null> {
  let { model, thinking } = stripMarkers(raw);
  const bare = COMBO_NAME.test(model) && !model.includes("/");
  const combos = bare || model.startsWith("combo/") ? await loadCombos(db) : null;
  // A bare name that is a combo routes as that combo, before any other reading of the name (FR-CMB-03).
  if (bare && combos?.has(model)) return { ref: { kind: "combo", name: model }, thinking, combos };
  if (bare) {
    const target = await getAlias(db, model);
    if (target) {
      const t = stripMarkers(target);
      thinking ??= t.thinking;
      const ref = parseModel(t.model);
      return ref ? { ref, thinking, combos } : null;
    }
  }
  const ref = parseModel(model);
  if (ref) return { ref, thinking, combos };
  if (!model.includes("/") && isModelName(model)) return { ref: { kind: "target", target: { provider: inferProvider(model), model } }, thinking, combos };
  return null;
}

export interface ChatOptions {
  /** Whose keys to use instead of the system's own. */
  keySystem?: string;
  /** The savers to use instead of the system's. */
  savers?: Savers;
}

/**
 * Vision and audio adapters (vision.ts): when one applies to `name` and the request carries images (or audio clips),
 * each distinct one is described (or transcribed) by the first adapter model that answers (in the saved order,
 * disabled models and ones with no key skipped; metered like any call), and its parts are replaced by the text.
 * A 502 when no model could: the model it was meant for cannot read it.
 */
async function adapt(run: Run, kind: AdapterKind, name: string, disabled: Set<string>, req: Json): Promise<Json | Response> {
  const cfg = await getAdapter(run.c.env.DB, kind);
  if (!appliesTo(cfg, name)) return req;
  const items: { key: string; ask: (model: string) => Json }[] =
    kind === "vision"
      ? imagesIn(req).map((img) => ({ key: img.url, ask: (m) => describeRequest(m, img) }))
      : audiosIn(req).map((a) => ({ key: a.data, ask: (m) => transcribeRequest(m, a) }));
  if (items.length === 0) return req;
  const adapters: Target[] = [];
  for (const m of cfg.models) {
    const ref = parseModel(m);
    if (ref?.kind === "target" && !disabled.has(targetName(ref.target))) adapters.push(ref.target);
  }
  // The adapter's own call is sent as it is: no token saver rewrites its prompt.
  const plain: Run = { ...run, savers: OFF };
  let last = "no adapter model is on and has a key";
  const texts = await Promise.all(
    items.map(async (item) => {
      for (const t of adapters) {
        const a = await attemptTarget(plain, t, item.ask(targetName(t)));
        if (!a) continue;
        if (!a.ok) {
          last = `${targetName(t)}: ${a.message}`;
          continue;
        }
        const got = await answerText(a.res);
        if (got) return got.text.trim();
        last = `${targetName(t)}: empty answer`;
      }
      return null;
    }),
  );
  if (texts.some((d) => d === null)) {
    const what = kind === "vision" ? "describe the image" : "transcribe the audio";
    return errorResponse(502, `${kind} adapter failed: no adapter model could ${what} (last error: ${last})`, "api_error", `${kind}_adapter_failed`);
  }
  const map = new Map(items.map((item, i) => [item.key, texts[i] as string]));
  return kind === "vision" ? replaceImages(req, map) : replaceAudio(req, map);
}

/** Both adapters in turn: images first, then audio. */
async function adaptMedia(run: Run, name: string, disabled: Set<string>, req: Json): Promise<Json | Response> {
  const seen = await adapt(run, "vision", name, disabled, req);
  return seen instanceof Response ? seen : adapt(run, "audio", name, disabled, seen);
}

/**
 * Runs an OpenAI chat request for `system`: resolves `model` (resolveModel), checks it is on and the system may use
 * it, then calls it. A combo picks its order by its strategy (combo-strategy.ts): the saved order, round robin, a
 * router model's choice, or fusion; targets cooling from an earlier failure go last, disabled ones are left out.
 */
export async function runChat(c: Context<AppEnv>, upstream: Upstream, system: System, req: Json, opts: ChatOptions = {}): Promise<Response> {
  if (typeof req.model !== "string" || !req.model.trim()) return errorResponse(400, "Missing model", "invalid_request_error");
  const resolved = await resolveModel(c.env.DB, req.model.trim());
  if (!resolved) return errorResponse(404, "unknown model: use provider/model (the providers are listed in the console), claude-*, or combo/<name>", "invalid_request_error", "model_not_found");
  const { ref, thinking } = resolved;
  let combos = resolved.combos;
  if (thinking) req = applyThinking(req, thinking);
  const name = ref.kind === "combo" ? `combo/${ref.name}` : targetName(ref.target);
  const disabled = await disabledSet(c.env.DB);
  if (ref.kind === "target" && disabled.has(name)) return errorResponse(404, `model ${name} is disabled`, "invalid_request_error", "model_disabled");
  if (!allows(allowedPatterns(system.allowed_models), name)) return errorResponse(403, `this system may not use ${name}`, "permission_error", "model_not_allowed");

  const now = Math.floor(Date.now() / 1000);
  const savers = opts.savers ?? saversFor(system, c.req.raw, await getTokenSaver(c.env.DB));
  // A suffix on the model name says the thinking for this request; else each provider's mode applies.
  const providerThinking = thinking ? {} : await getProviderThinking(c.env.DB);
  const run: Run = { c, upstream, system, now, savers, keySystem: opts.keySystem, providerThinking };

  if (ref.kind === "target") {
    const adapted = await adaptMedia(run, name, disabled, req);
    if (adapted instanceof Response) return adapted;
    req = adapted;
    if (savers.headroom) req = await headroomCompress(upstream, savers.headroom, req);
    return (await runOrder(run, [ref.target], req, false)).res;
  }

  combos ??= await loadCombos(c.env.DB);
  if (!combos.has(ref.name)) return errorResponse(404, `no combo named ${ref.name}`, "invalid_request_error", "model_not_found");
  const targets = expandCombo(combos, ref.name).filter((t) => !disabled.has(targetName(t)));
  const row = await c.env.DB.prepare("SELECT strategy, config FROM combo WHERE name = ?").bind(ref.name).first<{ strategy: string | null; config: string | null }>();
  const settings = await getComboSettings(c.env.DB);
  const strategy: Strategy = isStrategy(row?.strategy) ? row.strategy : settings.strategy;
  const config = readConfig(row?.config ?? null);
  if (targets.length === 0) {
    // The answers for a combo with no models (FR-CMB-31, FR-CMB-14).
    return strategy === "fusion" ? errorResponse(400, "Fusion combo has no models", "invalid_request_error", "invalid_model") : errorResponse(400, "Invalid model format", "invalid_request_error", "invalid_model");
  }
  const adapted = await adaptMedia(run, name, disabled, req);
  if (adapted instanceof Response) return adapted;
  req = adapted;
  // Headroom takes the request in OpenAI shape, before it is translated or sent anywhere.
  if (savers.headroom) req = await headroomCompress(upstream, savers.headroom, req);

  if (strategy === "fusion") return fusion(run, targets, config, req);

  const session = c.req.header("x-session-id") ?? null;
  let order: Target[] = targets;
  if (strategy === "round-robin") order = rotate(ref.name, targets, settings.sticky_limit);
  else if (strategy === "smart") order = await smartOrder(run, ref.name, targets, config, req, session);
  order = await coolLast(c.env.DB, order, now);

  const out = await runOrder(run, order, req, true);
  if (strategy === "smart" && session) {
    if (out.target) holdModel(ref.name, session, targetName(out.target));
    else for (const t of order) dropHeld(ref.name, session, targetName(t));
  }
  return out.res;
}
