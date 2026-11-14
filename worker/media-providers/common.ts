/**
 * Shared parts of the media adapters (speech.ts, transcription.ts, images.ts, embeddings.ts): each adapter turns an
 * OpenAI-shaped request into the provider's own API and its answer back into the OpenAI shape.
 */

/** One try with one account. `fetch` is the gateway's upstream (a fake one in tests). */
export interface Call {
  key: string;
  model: string;
  fetch: (req: Request) => Promise<Response>;
}

/** What an adapter answers: the OpenAI-shaped response and, for embeddings, the input tokens. */
export interface Result {
  res: Response;
  tokens?: number;
}

/**
 * A failed call. `final`: do not try the next account (the job was accepted and may have cost something, or the
 * request itself is wrong). The message never holds the key: see `scrub`.
 */
export class MediaError extends Error {
  readonly status: number;
  readonly retryAfter: number | null;
  readonly final: boolean;
  constructor(status: number, message: string, opts: { retryAfter?: number | null; final?: boolean } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = opts.retryAfter ?? null;
    this.final = opts.final ?? false;
  }
}

/** The request is wrong whatever the account: 400, no other account tried. */
export const badRequest = (message: string) => new MediaError(400, message, { final: true });

/** How long a job is waited for. Tests set `intervalMs` to 0. */
export const pollTiming = { intervalMs: 1500, timeoutMs: 120_000, maxPolls: 40 };

const MAX_MESSAGE = 300;

/** `text` with the key, and each part of a compound key (`id:secret`), replaced. */
export function scrub(text: string, key: string): string {
  const parts = [key, ...key.split(":")].filter((p) => p.length >= 8).sort((a, b) => b.length - a.length);
  let out = text;
  for (const p of parts) out = out.split(p).join("[redacted]");
  return out;
}

function messageOf(body: unknown): string | null {
  if (typeof body === "string") return body || null;
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  for (const k of ["error", "detail", "message", "status_msg", "failure", "title"]) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object") {
      const inner = messageOf(v);
      if (inner) return inner;
    }
    if (Array.isArray(v) && v.length) {
      const inner = messageOf(v[0]);
      if (inner) return inner;
    }
  }
  if (o.msg && typeof o.msg === "string") return o.msg;
  return null;
}

/** A provider's error answer as a MediaError: its own message (without the key), its status and retry-after. */
export async function upstreamError(res: Response, key: string, provider: string, final = false): Promise<MediaError> {
  const text = await res.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: the text itself
  }
  const raw = messageOf(body) ?? `${provider} answered ${res.status}`;
  const message = scrub(raw, key).slice(0, MAX_MESSAGE);
  const ra = Number(res.headers.get("retry-after"));
  return new MediaError(res.status, message, { retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null, final });
}

/** Sends `req`; a provider that cannot be reached is a 502 on this account. */
export async function send(call: Call, req: Request, provider: string): Promise<Response> {
  try {
    return await call.fetch(req);
  } catch {
    throw new MediaError(502, `could not reach ${provider}`);
  }
}

/** Sends and reads a JSON answer; a refusal becomes a MediaError. */
export async function sendJson<T>(call: Call, req: Request, provider: string, final = false): Promise<T> {
  const res = await send(call, req, provider).catch((e: unknown) => {
    if (e instanceof MediaError && final) throw new MediaError(e.status, e.message, { final });
    throw e;
  });
  if (!res.ok) throw await upstreamError(res, call.key, provider, final);
  const j = (await res.json().catch(() => null)) as T | null;
  if (j === null) throw new MediaError(502, `${provider} answered something that is not JSON`, { final });
  return j;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Asks for a job's state until `check` says it is done (`{done}`) or failed (`{fail}`), waiting between asks.
 * Every failure here is final: the job was accepted, so another account would start (and pay for) a second one.
 */
export async function poll<T, J = Record<string, unknown>>(
  call: Call,
  provider: string,
  request: () => Request,
  check: (j: J) => { done: T } | { fail: string } | null,
): Promise<T> {
  const deadline = Date.now() + pollTiming.timeoutMs;
  for (let i = 0; i < pollTiming.maxPolls && Date.now() < deadline; i++) {
    await sleep(pollTiming.intervalMs);
    const j = await sendJson<J>(call, request(), provider, true);
    const r = check(j);
    if (r && "done" in r) return r.done;
    if (r && "fail" in r) throw new MediaError(502, scrub(`${provider}: ${r.fail}`, call.key).slice(0, MAX_MESSAGE), { final: true });
  }
  throw new MediaError(504, `${provider} did not finish in time`, { final: true });
}

/** `url` when it is https on `host` or one of its subdomains: a job URL from a provider is only followed (with the key) there. */
export function assertHost(url: unknown, hosts: readonly string[], provider: string): string {
  let u: URL | null = null;
  try {
    u = typeof url === "string" ? new URL(url) : null;
  } catch {
    u = null;
  }
  if (!u || u.protocol !== "https:" || !hosts.some((h) => u!.hostname === h || u!.hostname.endsWith(`.${h}`))) {
    throw new MediaError(502, `${provider} answered a job URL on a host it does not use`, { final: true });
  }
  return u.toString();
}

export function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error("not hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** OpenAI's voice names: for a provider with voices of its own they mean "no voice chosen". */
const OPENAI_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"]);

/** The provider's voice id from the request, or null when none (or an OpenAI voice name) was given. */
export function voiceOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 300 || OPENAI_VOICES.has(s.toLowerCase())) return null;
  return s;
}

/** `WxH` from an OpenAI `size`, or null. */
export function sizeOf(size: unknown): { width: number; height: number } | null {
  if (typeof size !== "string") return null;
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size.trim());
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** The ratio from `allowed` ("16:9", or "1920:1080") nearest to `size`; the first one when there is no size. */
export function nearestRatio(size: unknown, allowed: readonly string[]): string {
  const s = sizeOf(size);
  if (!s) return allowed[0]!;
  const want = Math.log(s.width / s.height);
  let best = allowed[0]!;
  let gap = Infinity;
  for (const a of allowed) {
    const [w, h] = a.split(":").map(Number);
    const g = Math.abs(Math.log(w! / h!) - want);
    if (g < gap) {
      gap = g;
      best = a;
    }
  }
  return best;
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const audioResponse = (bytes: Uint8Array | ArrayBuffer | ReadableStream | null, type: string) =>
  new Response(bytes, { headers: { "content-type": type, "cache-control": "no-store" } });

/** The model name inside a URL path: no empty part, no "." or "..", nothing but path-safe characters. */
export function safePath(model: string): string {
  const parts = model.split("/");
  if (!parts.length || parts.some((p) => !p || p === "." || p === ".." || !/^[A-Za-z0-9._@+-]+$/.test(p))) throw badRequest("model: not a valid model name");
  return parts.map(encodeURIComponent).join("/");
}

const MAX_IMAGE = 20 * 1024 * 1024;

/** An image a provider left at a URL, fetched (without the key) for `b64_json`. */
export async function imageAsB64(call: Call, url: string, provider: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new MediaError(502, `${provider} answered an image URL that is not valid`, { final: true });
  }
  if (u.protocol !== "https:") throw new MediaError(502, `${provider} answered an image URL that is not https`, { final: true });
  let res: Response;
  try {
    res = await call.fetch(new Request(u.toString()));
  } catch {
    throw new MediaError(502, `could not fetch the image from ${provider}`, { final: true });
  }
  if (!res.ok) throw new MediaError(502, `could not fetch the image from ${provider} (${res.status})`, { final: true });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE) throw new MediaError(502, `the image from ${provider} is larger than 20 MB`, { final: true });
  return bytesToB64(buf);
}
