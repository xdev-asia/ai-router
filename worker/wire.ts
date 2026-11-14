import { chatToCodex } from "./codex";
import { baseUrl } from "./custom-providers";
import { ANTHROPIC_VERSION, isBuiltinProvider, providerDef, type ProviderId } from "./providers";

/**
 * How the gateway reaches the providers ported from an MIT-licensed gateway (its registry and executors read at
 * commit 54a88d04, the code written anew) whose endpoint is not one fixed `baseUrl` + `/chat/completions`:
 *
 * - lanes: a provider that answers some models in another format (OpenCode's Claude models speak Messages,
 *   Perplexity Agent speaks Responses), set in PROVIDERS as `lanes`;
 * - settings: a connection that names its endpoint (Azure's resource, Cloudflare's account, an AWS region),
 *   kept sealed with the key (connections.ts) and never returned by the API;
 * - signing: AWS Bedrock (Signature Version 4, with its binary event stream) and Vertex AI (a service account's
 *   JSON key exchanged for an access token).
 *
 * The request and answer shapes are those of that gateway's executors; none of them has been called against the live
 * services by this gateway's tests (worker/test/ported-providers.test.ts uses a fake upstream).
 */

type Json = Record<string, unknown>;
type Upstream = (req: Request) => Promise<Response>;

/** A per-connection setting. `secret`: sealed like the key and never shown (all values are never returned). */
export interface SettingDef {
  name: string;
  required?: boolean;
  secret?: boolean;
  /** Shown in the console when the setting is left empty. */
  default?: string;
  options?: readonly string[];
  test: (v: string) => boolean;
}

const AWS_REGION = /^[a-z0-9][a-z0-9-]{0,30}$/;
const awsSettings: readonly SettingDef[] = [
  { name: "access_key_id", required: true, test: (v) => /^[A-Z0-9]{4,128}$/.test(v) },
  { name: "region", default: "us-east-1", test: (v) => AWS_REGION.test(v) },
  { name: "session_token", secret: true, test: (v) => v.length <= 4096 && /^[\x21-\x7e]+$/.test(v) },
];
const VERTEX_LOCATION = /^(global|[a-z]+-[a-z]+[0-9]{1,2})$/;
const XIAOMI_REGIONS = ["sgp", "cn", "ams"] as const;
const AZURE_VERSION = "2024-10-01-preview";

export const SETTINGS: Readonly<Partial<Record<string, readonly SettingDef[]>>> = {
  "xiaomi-tokenplan": [{ name: "region", default: "sgp", options: XIAOMI_REGIONS, test: (v) => (XIAOMI_REGIONS as readonly string[]).includes(v) }],
  "cloudflare-ai": [{ name: "account_id", required: true, test: (v) => /^[A-Za-z0-9]{1,64}$/.test(v) }],
  azure: [
    { name: "endpoint", required: true, test: (v) => baseUrl(v) !== null },
    { name: "deployment", test: (v) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) },
    { name: "api_version", default: AZURE_VERSION, test: (v) => /^\d{4}-\d{2}-\d{2}(-preview)?$/.test(v) },
  ],
  bedrock: awsSettings,
  "bedrock-xai": awsSettings,
  vertex: [{ name: "location", default: "us-central1", test: (v) => VERTEX_LOCATION.test(v) }],
};

/** What the console is told about a provider's settings: names and rules, never values. */
export const settingsOf = (provider: string) =>
  SETTINGS[provider]?.map((s) => ({ name: s.name, required: s.required ?? false, secret: s.secret ?? false, default: s.default ?? null, options: s.options ?? null }));

/**
 * The settings in `raw` laid over `base` (an empty string removes one): the result, or the field that is wrong.
 * Settings of a provider that takes none, unknown names and missing required ones are refused.
 */
export function mergeSettings(provider: string, raw: unknown, base: Record<string, string> = {}): { ok: true; settings: Record<string, string> } | { ok: false; field: string } {
  const defs = SETTINGS[provider] ?? [];
  const out = { ...base };
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, field: "settings" };
    for (const [k, v] of Object.entries(raw as Json)) {
      const def = defs.find((d) => d.name === k);
      if (!def || typeof v !== "string") return { ok: false, field: `settings.${k}` };
      const t = v.trim();
      if (t === "") delete out[k];
      else if (!def.test(t)) return { ok: false, field: `settings.${k}` };
      else out[k] = k === "endpoint" ? (baseUrl(t) as string) : t;
    }
  }
  for (const d of defs) if (d.required && !out[d.name]) return { ok: false, field: `settings.${d.name}` };
  return { ok: true, settings: out };
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}
function serviceAccount(key: string): ServiceAccount | null {
  try {
    const v = JSON.parse(key) as Json;
    const ok = (x: unknown) => typeof x === "string" && x !== "";
    if (!ok(v.client_email) || !ok(v.project_id) || typeof v.private_key !== "string" || !v.private_key.includes("PRIVATE KEY-----")) return null;
    return { client_email: v.client_email as string, private_key: v.private_key, project_id: v.project_id as string };
  } catch {
    return null;
  }
}

/** Vertex takes a service account's JSON key as its key; other providers a plain token. */
export const keyShapeOk = (provider: string, key: string) => (provider === "vertex" || provider === "vertex-partner" ? serviceAccount(key) !== null : true);

/** A key with no useful last characters to show (a JSON document). */
export const isDocumentKey = (provider: string) => provider === "vertex" || provider === "vertex-partner";

// --- AWS Signature Version 4 (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html)

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The headers that sign one request: `authorization`, `x-amz-date` and the session token when there is one. */
export async function sigV4(r: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  date?: Date;
}): Promise<Record<string, string>> {
  const u = new URL(r.url);
  const amzDate = (r.date ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const extra: Record<string, string> = { "x-amz-date": amzDate };
  if (r.sessionToken) extra["x-amz-security-token"] = r.sessionToken;
  const all: Record<string, string> = { host: u.host, ...extra };
  for (const [k, v] of Object.entries(r.headers)) all[k.toLowerCase()] = v;
  const names = Object.keys(all).sort();
  // Services other than S3 encode each path segment twice: once in the URL, once here.
  const path = u.pathname.split("/").map(rfc3986).join("/");
  const query = [...u.searchParams].map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).sort().join("&");
  const canonical = [r.method, path, query, names.map((n) => `${n}:${(all[n] as string).trim().replace(/\s+/g, " ")}\n`).join(""), names.join(";"), await sha256(r.body)].join("\n");
  const scope = `${day}/${r.region}/${r.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let k = await hmac(enc.encode(`AWS4${r.secretAccessKey}`), day);
  for (const part of [r.region, r.service, "aws4_request"]) k = await hmac(k, part);
  const signature = hex(await hmac(k, toSign));
  return { ...extra, authorization: `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/**
 * Bedrock's streamed answer (application/vnd.amazon.eventstream: binary messages, each a JSON `{bytes}` holding
 * one event of the model's own format) as SSE: Anthropic events (`event:` and `data:`) or OpenAI chunks ending
 * with `[DONE]`. The messages' CRC checksums are not checked (TLS already guards the bytes).
 */
export function eventStreamToSse(kind: "anthropic" | "openai"): TransformStream<Uint8Array, Uint8Array> {
  let buf = new Uint8Array(0);
  const dec = new TextDecoder();
  const emit = (ctrl: TransformStreamDefaultController<Uint8Array>, s: string) => ctrl.enqueue(enc.encode(s));
  const fail = (ctrl: TransformStreamDefaultController<Uint8Array>, message: string) =>
    emit(ctrl, kind === "anthropic" ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n` : `data: ${JSON.stringify({ error: { message, type: "api_error" } })}\n\n`);
  const message = (m: Uint8Array, ctrl: TransformStreamDefaultController<Uint8Array>) => {
    const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
    const headersEnd = 12 + dv.getUint32(4);
    const headers: Record<string, string> = {};
    let i = 12;
    while (i < headersEnd) {
      const nameLen = m[i] as number;
      const name = dec.decode(m.subarray(i + 1, i + 1 + nameLen));
      i += 1 + nameLen;
      const type = m[i++] as number;
      // Value sizes by type: 0/1 true/false (none), 2 byte, 3 short, 4 int, 5 long, 6 bytes, 7 string, 8 timestamp, 9 uuid.
      if (type === 6 || type === 7) {
        const len = dv.getUint16(i);
        if (type === 7) headers[name] = dec.decode(m.subarray(i + 2, i + 2 + len));
        i += 2 + len;
      } else i += [0, 0, 1, 2, 4, 8, 0, 0, 8, 16][type] ?? 0;
    }
    const payload = dec.decode(m.subarray(headersEnd, m.length - 4));
    if (headers[":message-type"] !== "event") {
      let text = headers[":exception-type"] ?? headers[":error-code"] ?? "the provider reported an error";
      try {
        const p = JSON.parse(payload) as Json;
        if (typeof p.message === "string") text = p.message;
        else if (typeof p.Message === "string") text = p.Message;
      } catch {
        // keep the type as the message
      }
      return fail(ctrl, text);
    }
    if (headers[":event-type"] !== "chunk") return;
    let inner: string;
    try {
      const bytes = (JSON.parse(payload) as { bytes?: unknown }).bytes;
      if (typeof bytes !== "string") return;
      inner = dec.decode(Uint8Array.from(atob(bytes), (ch) => ch.charCodeAt(0)));
    } catch {
      return fail(ctrl, "the provider sent a chunk that could not be read");
    }
    if (kind === "openai") return emit(ctrl, `data: ${inner}\n\n`);
    let type = "message";
    try {
      const t = (JSON.parse(inner) as { type?: unknown }).type;
      if (typeof t === "string") type = t;
    } catch {
      return fail(ctrl, "the provider sent a chunk that could not be read");
    }
    emit(ctrl, `event: ${type}\ndata: ${inner}\n\n`);
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, ctrl) {
      const next = new Uint8Array(buf.length + bytes.length);
      next.set(buf);
      next.set(bytes, buf.length);
      buf = next;
      while (buf.length >= 12) {
        const total = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0);
        if (total < 16) {
          buf = new Uint8Array(0);
          return fail(ctrl, "the provider's event stream could not be read");
        }
        if (buf.length < total) break;
        message(buf.subarray(0, total), ctrl);
        buf = buf.slice(total);
      }
    },
    flush(ctrl) {
      if (kind === "openai") emit(ctrl, "data: [DONE]\n\n");
    },
  });
}

// --- Vertex AI: a service account's key signs a JWT, exchanged at Google for an access token
// (https://developers.google.com/identity/protocols/oauth2/service-account#httprest).

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const tokens = new Map<string, { token: string; until: number }>();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function vertexToken(upstream: Upstream, key: string, sa: ServiceAccount): Promise<{ token: string } | { status: number; message: string }> {
  const id = await sha256(key);
  const now = Math.floor(Date.now() / 1000);
  const kept = tokens.get(id);
  if (kept && kept.until > now + 60) return { token: kept.token };
  let signer: CryptoKey;
  try {
    const der = Uint8Array.from(atob(sa.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")), (ch) => ch.charCodeAt(0));
    signer = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    return { status: 401, message: "the service account's private key cannot be read" };
  }
  const part = (v: Json) => b64url(enc.encode(JSON.stringify(v)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const signature = b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, enc.encode(unsigned))));
  // Always Google's own endpoint: a `token_uri` in the JSON is not followed (it would receive the signed JWT).
  let res: Response;
  try {
    res = await upstream(
      new Request(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
      }),
    );
  } catch {
    return { status: 502, message: "could not reach Google's token service" };
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };
  if (!res.ok || typeof body.access_token !== "string") {
    const why = typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : `error ${res.status}`;
    return { status: res.status >= 500 ? 502 : 401, message: `Google refused the service account: ${why}` };
  }
  const ttl = typeof body.expires_in === "number" ? body.expires_in : 3600;
  tokens.set(id, { token: body.access_token, until: now + ttl });
  return { token: body.access_token };
}

// --- Where a request goes

/**
 * How one request is sent. `kind`: the format of the body the gateway builds and of the answer it reads.
 * `request` builds the request from that body; `response` turns the answer into that format (Bedrock's stream).
 */
export interface Wire {
  kind: "anthropic" | "openai" | "responses";
  request: (body: Json) => Promise<Request>;
  response?: (res: Response, stream: boolean) => Response;
}

/** `wire` null: the provider's plain path (its `format` and `baseUrl`). */
export type WireResult = { ok: true; wire: Wire | null } | { ok: false; status: number; message: string; code: string };

const post = (url: string, headers: Record<string, string>) => (body: Json) =>
  Promise.resolve(new Request(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }));
const missing = (provider: string, name: string): WireResult => ({ ok: false, status: 500, message: `not_configured: the ${provider} connection has no ${name}`, code: "not_configured" });

const NEEDS_WIRE = new Set(["xiaomi-tokenplan", "cloudflare-ai", "azure", "bedrock", "bedrock-xai", "vertex", "vertex-partner"]);

export async function wireFor(upstream: Upstream, provider: ProviderId, model: string, key: string, settings: Record<string, string>): Promise<WireResult> {
  if (!isBuiltinProvider(provider)) return { ok: true, wire: null };
  const def = providerDef(provider);
  const lanes = def.lanes;
  if (lanes?.anthropic?.models.test(model)) {
    return { ok: true, wire: { kind: "anthropic", request: post(lanes.anthropic.url, { ...def.headers, "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION }) } };
  }
  if (lanes?.responses?.models.test(model)) {
    return { ok: true, wire: { kind: "responses", request: post(lanes.responses.url, { ...def.headers, authorization: `Bearer ${key}`, accept: "text/event-stream" }) } };
  }
  if (!NEEDS_WIRE.has(provider)) return { ok: true, wire: null };
  const bearer = (url: string): WireResult => ({ ok: true, wire: { kind: "openai", request: post(url, { authorization: `Bearer ${key}` }) } });
  switch (provider) {
    case "xiaomi-tokenplan":
      return bearer(`https://token-plan-${settings.region ?? "sgp"}.xiaomimimo.com/v1/chat/completions`);
    case "cloudflare-ai":
      if (!settings.account_id) return missing(provider, "account_id");
      return bearer(`https://api.cloudflare.com/client/v4/accounts/${settings.account_id}/ai/v1/chat/completions`);
    case "azure": {
      if (!settings.endpoint) return missing(provider, "endpoint");
      const url = `${settings.endpoint}/openai/deployments/${encodeURIComponent(settings.deployment ?? model)}/chat/completions?api-version=${settings.api_version ?? AZURE_VERSION}`;
      return { ok: true, wire: { kind: "openai", request: post(url, { "api-key": key }) } };
    }
    case "bedrock":
    case "bedrock-xai": {
      if (!settings.access_key_id) return missing(provider, "access_key_id");
      const claude = provider === "bedrock";
      if (!(claude ? /(^|[./])anthropic\./ : /(^|[./])xai\./).test(model)) {
        return { ok: false, status: 400, message: `${provider} serves ${claude ? "Anthropic (anthropic.*)" : "xAI (xai.*)"} models only`, code: "model_not_supported" };
      }
      const region = settings.region ?? "us-east-1";
      return {
        ok: true,
        wire: {
          kind: claude ? "anthropic" : "openai",
          request: async (b) => {
            const { model: _m, stream, stream_options: _o, ...rest } = b;
            const body = JSON.stringify(claude ? { ...rest, anthropic_version: "bedrock-2023-05-31" } : rest);
            const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/${stream === true ? "invoke-with-response-stream" : "invoke"}`;
            const headers = { "content-type": "application/json" };
            const signed = await sigV4({ method: "POST", url, headers, body, accessKeyId: settings.access_key_id as string, secretAccessKey: key, sessionToken: settings.session_token, region, service: "bedrock" });
            return new Request(url, { method: "POST", headers: { ...headers, ...signed }, body });
          },
          response: (res, stream) =>
            stream && res.ok && res.body ? new Response(res.body.pipeThrough(eventStreamToSse(claude ? "anthropic" : "openai")), { status: res.status, headers: { "content-type": "text/event-stream" } }) : res,
        },
      };
    }
    case "vertex":
    case "vertex-partner": {
      const sa = serviceAccount(key);
      if (!sa) return { ok: false, status: 401, message: `the ${provider} key is not a service account JSON key`, code: "provider_auth" };
      const t = await vertexToken(upstream, key, sa);
      if (!("token" in t)) return { ok: false, status: t.status, message: t.message, code: "provider_auth" };
      // Partner models (DeepSeek, Qwen, ...) are served from the global location.
      const loc = provider === "vertex-partner" ? "global" : (settings.location ?? "us-central1");
      const host = loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`;
      const url = `https://${host}/v1/projects/${encodeURIComponent(sa.project_id)}/locations/${loc}/endpoints/openapi/chat/completions`;
      const req = post(url, { authorization: `Bearer ${t.token}` });
      // Vertex's OpenAI-compatible endpoint names Google's own models `google/<id>`.
      return { ok: true, wire: { kind: "openai", request: provider === "vertex" && !model.includes("/") ? (b) => req({ ...b, model: `google/${model}` }) : req } };
    }
  }
  return { ok: true, wire: null };
}

/** The body of a Responses request for a chat request: the Codex translation, without Codex's own defaults. */
export function responsesBody(req: Json, model: string): Json {
  const body = chatToCodex(req, model);
  body.model = model;
  const hasSystem = Array.isArray(req.messages) && req.messages.some((m) => m && typeof m === "object" && ((m as Json).role === "system" || (m as Json).role === "developer"));
  if (!hasSystem) delete body.instructions;
  if (typeof req.reasoning_effort !== "string") {
    delete body.reasoning;
    delete body.include;
  }
  const max = req.max_completion_tokens ?? req.max_tokens;
  if (typeof max === "number") body.max_output_tokens = max;
  for (const k of ["temperature", "top_p"] as const) if (typeof req[k] === "number") body[k] = req[k];
  return body;
}

/**
 * The request that checks a key for the providers above (no tokens spent); null: the provider's model list.
 * A Vertex key is checked by getting an access token.
 */
export async function checkRequest(upstream: Upstream, provider: ProviderId, key: string, settings: Record<string, string>): Promise<Request | { ok: boolean; status: number; message: string } | null> {
  switch (provider) {
    case "xiaomi-tokenplan":
      return new Request(`https://token-plan-${settings.region ?? "sgp"}.xiaomimimo.com/v1/models`, { headers: { authorization: `Bearer ${key}` } });
    case "cloudflare-ai":
      if (!settings.account_id) return { ok: false, status: 400, message: "account_id is required" };
      return new Request(`https://api.cloudflare.com/client/v4/accounts/${settings.account_id}/ai/models/search?per_page=1`, { headers: { authorization: `Bearer ${key}` } });
    case "azure":
      if (!settings.endpoint) return { ok: false, status: 400, message: "endpoint is required" };
      return new Request(`${settings.endpoint}/openai/models?api-version=${settings.api_version ?? AZURE_VERSION}`, { headers: { "api-key": key } });
    case "bedrock":
    case "bedrock-xai": {
      if (!settings.access_key_id) return { ok: false, status: 400, message: "access_key_id is required" };
      const region = settings.region ?? "us-east-1";
      const url = `https://bedrock.${region}.amazonaws.com/foundation-models`;
      const signed = await sigV4({ method: "GET", url, headers: {}, body: "", accessKeyId: settings.access_key_id, secretAccessKey: key, sessionToken: settings.session_token, region, service: "bedrock" });
      return new Request(url, { headers: signed });
    }
    case "vertex":
    case "vertex-partner": {
      const sa = serviceAccount(key);
      if (!sa) return { ok: false, status: 400, message: "the key is not a service account JSON key" };
      const t = await vertexToken(upstream, key, sa);
      return "token" in t ? { ok: true, status: 200, message: "" } : { ok: false, status: t.status, message: t.message };
    }
  }
  return null;
}
