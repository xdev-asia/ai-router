import type { Context, Hono } from "hono";
import type { System } from "./auth";
import { accountFailure, candidatesFor, createApiKeyConnection, noteFailure, noteSuccess } from "./connections";
import type { AppEnv } from "./env";
import { MediaError, badRequest, scrub, type Call, type Result } from "./media-providers/common";
import { MEDIA_PROVIDERS, UNSUPPORTED_MEDIA, keyFormatError, kindsOf, mediaProvider, mediaProviderOfPrefix, type MediaKindName, type MediaProvider } from "./media-providers/registry";
import { PROVIDERS, allowedPatterns, allows, hasEnvKey, isModelName, parseModel, providerDef, targetName, usageOfOpenAI, type ProviderId } from "./providers";
import { checkSystem, record, type GateFailure, type Upstream } from "./proxy";
import { errorResponse } from "./route";
import { EMPTY, type Usage } from "./usage";
import { errorBody } from "./errors";

/**
 * Media endpoints (embeddings, images, video, speech and transcription): passed through to an
 * OpenAI-compatible provider as they are, with the gateway's accounts and fallback between them. `model` is
 * `<provider>/<model>`: no combos (a combo's targets are chat models) and no provider that does not speak OpenAI.
 */

export const MEDIA_KINDS = [
  { kind: "embeddings", path: "/v1/embeddings", upstream: "/embeddings", body: "json" },
  { kind: "images", path: "/v1/images/generations", upstream: "/images/generations", body: "json" },
  { kind: "video", path: "/v1/videos", upstream: "/videos", body: "json" },
  { kind: "speech", path: "/v1/audio/speech", upstream: "/audio/speech", body: "json" },
  { kind: "transcription", path: "/v1/audio/transcriptions", upstream: "/audio/transcriptions", body: "multipart" },
] as const;
type Kind = (typeof MEDIA_KINDS)[number];

const DROP_RESPONSE = ["content-length", "content-encoding", "transfer-encoding", "set-cookie"];
const MAX_UPLOAD = 25 * 1024 * 1024;

type Body = { kind: "json"; data: Record<string, unknown> } | { kind: "multipart"; data: FormData };

async function readBody(c: Context<AppEnv>, kind: Kind): Promise<Body | Response> {
  if (kind.body === "multipart") {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_UPLOAD) return errorResponse(413, `uploads are at most ${MAX_UPLOAD / 1024 / 1024} MB`, "invalid_request_error");
    try {
      return { kind: "multipart", data: await c.req.formData() };
    } catch {
      return errorResponse(400, "body must be multipart/form-data", "invalid_request_error");
    }
  }
  const data = (await c.req.json().catch(() => null)) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) return errorResponse(400, "body must be a JSON object", "invalid_request_error");
  return { kind: "json", data: data as Record<string, unknown> };
}

const modelOf = (b: Body): unknown => (b.kind === "json" ? b.data.model : b.data.get("model"));

/** The body sent to the provider: its own model name in place of `<provider>/<model>`. Built anew for each try. */
function bodyFor(b: Body, model: string): { body: BodyInit; contentType: string | null } {
  if (b.kind === "json") return { body: JSON.stringify({ ...b.data, model }), contentType: "application/json" };
  const f = new FormData();
  for (const [k, v] of b.data.entries()) if (k !== "model") f.append(k, v);
  f.set("model", model);
  return { body: f, contentType: null }; // fetch sets the multipart boundary
}

async function errorMessage(up: Response): Promise<string> {
  const body = errorBody(await up.clone().json().catch(() => null)) as { error?: { message?: unknown } | string } | null;
  const e = body?.error;
  return typeof e === "string" ? e : typeof e?.message === "string" ? e.message : `upstream error ${up.status}`;
}

function passThrough(up: Response): Response {
  const h = new Headers(up.headers);
  for (const k of DROP_RESPONSE) h.delete(k);
  h.set("cache-control", "no-store");
  return new Response(up.body, { status: up.status, headers: h });
}

async function handle(c: Context<AppEnv>, upstream: Upstream, kind: Kind, gateError: (g: GateFailure) => Response): Promise<Response> {
  const g = await checkSystem(c.env, c.req.raw, true);
  if (!g.ok) return gateError(g);
  const body = await readBody(c, kind);
  if (body instanceof Response) return body;
  return send(c, upstream, g.system, kind, body);
}

/**
 * An OpenAI embeddings request (`model` is `<provider>/<model>`) sent for `system` as /v1/embeddings sends it:
 * the provider's answer as it came, or an error in the OpenAI shape. The Gemini surface's embedContent uses it.
 */
export function sendEmbeddings(c: Context<AppEnv>, upstream: Upstream, system: System, data: Record<string, unknown>): Promise<Response> {
  return send(c, upstream, system, MEDIA_KINDS[0], { kind: "json", data });
}

/** An OpenAI images request sent for `system` as /v1/images/generations sends it (the console's playground). */
export function sendImages(c: Context<AppEnv>, upstream: Upstream, system: System, data: Record<string, unknown>): Promise<Response> {
  return send(c, upstream, system, MEDIA_KINDS[1], { kind: "json", data });
}

async function send(c: Context<AppEnv>, upstream: Upstream, system: System, kind: Kind, body: Body): Promise<Response> {
  const raw = modelOf(body);
  const media = mediaTarget(raw, kind.kind);
  if (media instanceof Response) return media;
  if (media) return sendMedia(c, upstream, system, media, body);
  const ref = typeof raw === "string" ? parseModel(raw) : null;
  if (!ref) return errorResponse(400, "model: <provider>/<model>", "invalid_request_error", "model_not_found");
  if (ref.kind !== "target") return errorResponse(400, `${kind.kind}: a combo cannot be used here, name a <provider>/<model>`, "invalid_request_error", "model_not_supported");
  const { provider, model } = ref.target;
  const def = providerDef(provider);
  if (def.format !== "openai" || !def.baseUrl) return errorResponse(400, `${provider} does not offer an OpenAI-compatible ${kind.kind} endpoint here`, "invalid_request_error", "model_not_supported");
  if (!allows(allowedPatterns(system.allowed_models), targetName(ref.target))) return errorResponse(403, "this system may not use this model", "permission_error", "model_not_allowed");

  const now = Math.floor(Date.now() / 1000);
  const cands = await candidatesFor(c.env, provider, system.id, now, upstream);
  let last: Response | null = null;
  for (const cand of cands) {
    const key = await cand.key();
    if (typeof key !== "string") continue;
    const { body: payload, contentType } = bodyFor(body, model);
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (contentType) headers["content-type"] = contentType;
    let up: Response;
    try {
      up = await upstream(new Request(`${def.baseUrl}${kind.upstream}`, { method: "POST", headers, body: payload }));
    } catch {
      await noteFailure(c.env.DB, cand, 502, `could not reach ${provider}`, null, now);
      last = errorResponse(502, `could not reach ${provider}`, "api_error");
      continue;
    }
    if (up.ok) {
      c.executionCtx.waitUntil(noteSuccess(c.env.DB, cand, now));
      const usage: Promise<Usage> =
        kind.kind === "embeddings"
          ? up
              .clone()
              .json()
              .then((j) => usageOfOpenAI(targetName(ref.target), (j as { usage?: unknown }).usage))
          : Promise.resolve({ ...EMPTY, model: targetName(ref.target) });
      record(c, system, up, false, usage, provider);
      return passThrough(up);
    }
    if (accountFailure(up.status)) {
      const retryAfter = Number(up.headers.get("retry-after"));
      await noteFailure(c.env.DB, cand, up.status, await errorMessage(up), Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null, now);
      last = passThrough(up);
      continue;
    }
    record(c, system, up, false, Promise.resolve({ ...EMPTY, model: targetName(ref.target) }), provider);
    return passThrough(up);
  }
  return last ?? errorResponse(500, `not_configured: no key for ${provider}`, "server_error", "not_configured", { "x-should-retry": "false" });
}

interface MediaTarget {
  provider: MediaProvider;
  model: string;
  kind: MediaKindName;
}

/**
 * `<id or alias>/<model>` of a media-only provider (media-providers/registry.ts), or null for the passthrough. A
 * chat provider's prefix wins over a media alias; a media id that is also a chat provider serves the kinds it has
 * an adapter for and passes the rest through. A kind the provider does not serve is a 400.
 */
function mediaTarget(raw: unknown, kind: Kind["kind"]): MediaTarget | Response | null {
  if (!isModelName(raw)) return null;
  const i = raw.indexOf("/");
  if (i <= 0) return null;
  const head = raw.slice(0, i);
  const model = raw.slice(i + 1);
  const found = mediaProviderOfPrefix(head);
  if (!found || !model) return null;
  const chat = parseModel(raw);
  if (found.byAlias && chat) return null;
  const k = kind as MediaKindName;
  if (kind === "video" || !found.provider.kinds[k]) {
    if (chat) return null;
    return errorResponse(400, `${found.provider.name} does not offer ${kind} here`, "invalid_request_error", "model_not_supported");
  }
  return { provider: found.provider, model, kind: k };
}

const errorType = (status: number) =>
  status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 429 ? "rate_limit_error" : status < 500 ? "invalid_request_error" : "api_error";

/** A media-only provider through its adapter: each account in turn, as `send` does for the passthrough. */
async function sendMedia(c: Context<AppEnv>, upstream: Upstream, system: System, t: MediaTarget, body: Body): Promise<Response> {
  const { provider: p, model, kind } = t;
  const name = `${p.id}/${model}`;
  if (!allows(allowedPatterns(system.allowed_models), name)) return errorResponse(403, "this system may not use this model", "permission_error", "model_not_allowed");
  const run = (call: Call): Promise<Result> => {
    if (kind === "transcription") {
      if (body.kind !== "multipart") throw badRequest("body must be multipart/form-data");
      return p.kinds.transcription!.run(body.data, call);
    }
    if (body.kind !== "json") throw badRequest("body must be a JSON object");
    return p.kinds[kind]!.run(body.data, call);
  };

  const now = Math.floor(Date.now() / 1000);
  const cands = await candidatesFor(c.env, p.id, system.id, now, upstream);
  let last: Response | null = null;
  for (const cand of cands) {
    const key = await cand.key();
    if (typeof key !== "string") continue;
    c.set("connection", cand.connection);
    let result: Result;
    try {
      result = await run({ key, model, fetch: upstream });
    } catch (e) {
      // An error that is not the adapter's own is not passed on (it could hold anything); it is not retried either.
      const err = e instanceof MediaError ? e : new MediaError(502, `${p.name} answered something unexpected`, { final: true });
      const message = scrub(err.message, key);
      const res = errorResponse(err.status, message, errorType(err.status), err.status === 504 ? "timeout" : null);
      if (!err.final && accountFailure(err.status)) {
        await noteFailure(c.env.DB, cand, err.status, message, err.retryAfter, now);
        last = res;
        continue;
      }
      record(c, system, res, false, Promise.resolve({ ...EMPTY, model: name }), p.id);
      return res;
    }
    c.executionCtx.waitUntil(noteSuccess(c.env.DB, cand, now));
    record(c, system, result.res, false, Promise.resolve({ ...EMPTY, model: name, input_tokens: result.tokens ?? 0 }), p.id);
    return result.res;
  }
  return last ?? errorResponse(500, `not_configured: no key for ${p.id}`, "server_error", "not_configured", { "x-should-retry": "false" });
}

/** Registers the media paths on the OpenAI surface (openai.ts), before its 404. */
export function mediaRoutes(r: Hono<AppEnv>, upstream: Upstream, gateError: (g: GateFailure) => Response): void {
  for (const kind of MEDIA_KINDS) r.post(kind.path, (c) => handle(c, upstream, kind, gateError));
}

/** The console's Media page: the endpoints and the providers that can serve them. */
export function mediaAdminRoutes(a: Hono<AppEnv>): void {
  a.get("/media", async (c) => {
    const rows = await c.env.DB.prepare("SELECT provider, COUNT(*) AS n FROM connection WHERE disabled = 0 GROUP BY provider").all<{ provider: string; n: number }>();
    const accounts = new Map(rows.results.map((r) => [r.provider, r.n]));
    return c.json({
      kinds: MEDIA_KINDS.map((k) => ({ kind: k.kind, path: k.path, body: k.body })),
      // The same rule as the call above: OpenAI format with a fixed base URL (azure, vertex and cloudflare-ai have none).
      providers: (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => providerDef(p).format === "openai" && !!providerDef(p).baseUrl),
      media_providers: MEDIA_PROVIDERS.map((p) => {
        const env_key = hasEnvKey(c.env, p.id);
        const n = accounts.get(p.id) ?? 0;
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          mark: p.mark,
          alias: p.alias ?? null,
          key_url: p.keyUrl,
          key_format: p.keyFormat,
          kinds: kindsOf(p),
          models: Object.fromEntries(kindsOf(p).map((k) => [k, p.kinds[k]!.models])),
          connections: n,
          env_key,
          configured: n > 0 || env_key,
        };
      }),
      unsupported: UNSUPPORTED_MEDIA,
    });
  });

  /** Adds a key for a media-only provider; it is changed and removed with /connections/:id like any other. */
  a.post("/media/connections", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { provider?: unknown; name?: unknown; api_key?: unknown } | null;
    const p = typeof b?.provider === "string" ? mediaProvider(b.provider) : null;
    if (!p) return c.json({ error: "not_found", hint: "provider: a media provider id from GET /media" }, 404);
    const name = typeof b?.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 100) return c.json({ error: "invalid_input", hint: "name: 1 to 100 characters" }, 400);
    const key = typeof b?.api_key === "string" ? b.api_key.trim() : "";
    if (!key || key.length > 4096) return c.json({ error: "invalid_input", hint: "api_key: the provider's key" }, 400);
    const bad = keyFormatError(p, key);
    if (bad) return c.json({ error: "invalid_input", hint: bad }, 400);
    const conn = await createApiKeyConnection(c.env, p.id, name, key);
    if (!conn) return c.json({ error: "not_configured", hint: "set the CONNECTIONS_KEY secret: 32 random bytes, base64" }, 500);
    return c.json(conn, 201);
  });
}
