import type { Context } from "hono";
import type { System } from "./auth";
import { accountFailure, candidatesFor, noteFailure, noteSuccess } from "./connections";
import type { AppEnv } from "./env";
import { PROVIDERS, allowedPatterns, allows, parseModel, targetName, usageOfOpenAI, type Target } from "./providers";
import { record, type Upstream } from "./proxy";
import { chatToMessages, messageToChat, openaiErrorBody, streamToChat, TranslateError } from "./translate/openai-anthropic";
import { EMPTY, usageOfMessage, usageOfStream, type Usage } from "./usage";
import { applySavers, saversFor, type Savers } from "./savers";

/** The Messages API version this gateway speaks when it builds the upstream request itself. */
export const ANTHROPIC_VERSION = "2023-06-01";

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

type Attempt = { ok: true; res: Response } | { ok: false; res: Response; status: number; message: string; retryable: boolean; retryAfter: number | null };

/** Rebuilds an upstream error (Anthropic or OpenAI shape) as an OpenAI error with the same status. */
async function failure(up: Response): Promise<Attempt> {
  const body = (await up.json().catch(() => ({}))) as { error?: { type?: unknown; message?: unknown; code?: unknown } | string };
  const e = typeof body.error === "object" && body.error ? body.error : {};
  const message = typeof e.message === "string" ? e.message : typeof body.error === "string" ? body.error : `upstream error ${up.status}`;
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

async function callAnthropic(c: Context<AppEnv>, upstream: Upstream, system: System, key: string, target: Target, req: Json, savers: Savers): Promise<Attempt> {
  const messages = chatToMessages({ ...req, model: target.model });
  const saved = applySavers(messages, "anthropic", savers);
  const stream = messages.stream === true;
  const includeUsage = stream && (req.stream_options as Json | undefined)?.include_usage === true;
  const up = await upstream(
    new Request(c.env.ANTHROPIC_BASE_URL.replace(/\/+$/, "") + "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: JSON.stringify(messages),
    }),
  );
  if (!up.ok || !up.body) {
    record(c, system, up, false, Promise.resolve({ ...EMPTY, model: target.model }), "anthropic", saved);
    return failure(up);
  }
  const [toClient, toMeter] = up.body.tee();
  if (stream) {
    record(c, system, up, true, usageOfStream(toMeter), "anthropic", saved);
    return {
      ok: true,
      res: new Response(toClient.pipeThrough(streamToChat(target.model, includeUsage)), {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
      }),
    };
  }
  const msg: unknown = await new Response(toClient).json();
  record(c, system, up, false, new Response(toMeter).json().then(usageOfMessage), "anthropic", saved);
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
  const client = body.pipeThrough(
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

async function callOpenAICompatible(c: Context<AppEnv>, upstream: Upstream, system: System, key: string, target: Target, req: Json, savers: Savers): Promise<Attempt> {
  const p = PROVIDERS[target.provider] as { baseUrl: string };
  const stream = req.stream === true;
  const keepUsage = (req.stream_options as Json | undefined)?.include_usage === true;
  // A deep copy: savers rewrite messages in place, and a combo may send the same request to another target.
  const body: Json = { ...(structuredClone(req) as Json), model: target.model };
  const saved = applySavers(body, "openai", savers);
  if (stream) body.stream_options = { ...((req.stream_options as Json | undefined) ?? {}), include_usage: true };
  const up = await upstream(
    new Request(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
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

async function coolingTargets(db: D1Database, names: string[], now: number): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const r = await db
    .prepare(`SELECT target FROM cooldown WHERE until > ? AND target IN (${names.map(() => "?").join(",")})`)
    .bind(now, ...names)
    .all<{ target: string }>();
  return new Set(r.results.map((x) => x.target));
}

/**
 * Runs an OpenAI chat request for `system`: resolves `model` (provider/model, claude-*, or combo/name), checks the
 * system may use it, then calls the target. A combo tries its targets in order, moving on only after a 429/5xx
 * or a missing key, and skips targets cooling down from an earlier failure (unless all are).
 * Within one target the provider's accounts are tried in order (connections.ts): the next one after a 429, a 5xx
 * or a refused key (401/403), never after another request error.
 */
export async function runChat(c: Context<AppEnv>, upstream: Upstream, system: System, req: Json): Promise<Response> {
  const ref = parseModel(req.model);
  if (!ref) return errorResponse(404, `unknown model: use provider/model (${Object.keys(PROVIDERS).join(", ")}), claude-*, or combo/<name>`, "invalid_request_error", "model_not_found");
  const name = ref.kind === "combo" ? `combo/${ref.name}` : targetName(ref.target);
  if (!allows(allowedPatterns(system.allowed_models), name)) return errorResponse(403, `this system may not use ${name}`, "permission_error", "model_not_allowed");

  let targets: Target[];
  if (ref.kind === "target") targets = [ref.target];
  else {
    const row = await c.env.DB.prepare("SELECT targets FROM combo WHERE name = ?").bind(ref.name).first<{ targets: string }>();
    if (!row) return errorResponse(404, `no combo named ${ref.name}`, "invalid_request_error", "model_not_found");
    targets = (JSON.parse(row.targets) as string[]).map((t) => parseModel(t)).flatMap((r) => (r?.kind === "target" ? [r.target] : []));
  }

  const now = Math.floor(Date.now() / 1000);
  const cooling = ref.kind === "combo" ? await coolingTargets(c.env.DB, targets.map(targetName), now) : new Set<string>();
  const order = [...targets.filter((t) => !cooling.has(targetName(t))), ...targets.filter((t) => cooling.has(targetName(t)))];

  const savers = saversFor(system, c.req.raw);
  let last: Response | null = null;
  for (const [i, target] of order.entries()) {
    let attempt: Attempt | null = null;
    for (const cand of await candidatesFor(c.env, target.provider, system.id, now)) {
      const key = await cand.key();
      if (!key) continue;
      try {
        attempt = PROVIDERS[target.provider].format === "anthropic"
          ? await callAnthropic(c, upstream, system, key, target, req, savers)
          : await callOpenAICompatible(c, upstream, system, key, target, req, savers);
      } catch (e) {
        if (e instanceof TranslateError) return errorResponse(400, e.message, "invalid_request_error");
        attempt = { ok: false, res: errorResponse(502, `could not reach ${target.provider}`, "api_error"), status: 502, message: `could not reach ${target.provider}`, retryable: true, retryAfter: null };
      }
      if (attempt.ok) {
        c.executionCtx.waitUntil(noteSuccess(c.env.DB, cand, now).catch(() => undefined));
        break;
      }
      if (!accountFailure(attempt.status)) break;
      await noteFailure(c.env.DB, cand, attempt.status, attempt.message, attempt.retryAfter, now);
    }
    if (!attempt) {
      last = errorResponse(500, `not_configured: no ${target.provider} key`, "server_error", "not_configured", { "x-should-retry": "false" });
      continue;
    }
    if (attempt.ok) {
      if (ref.kind === "combo") attempt.res.headers.set("x-gateway-target", targetName(target));
      return attempt.res;
    }
    last = attempt.res;
    if (!attempt.retryable || ref.kind !== "combo") return attempt.res;
    const until = now + Math.min(MAX_COOLDOWN_S, attempt.retryAfter ?? COOLDOWN_S);
    await c.env.DB.prepare("INSERT INTO cooldown (target, until) VALUES (?, ?) ON CONFLICT (target) DO UPDATE SET until = excluded.until")
      .bind(targetName(target), until)
      .run();
    if (i === order.length - 1) break;
  }
  return last ?? errorResponse(500, "combo has no usable target", "server_error", "not_configured");
}
