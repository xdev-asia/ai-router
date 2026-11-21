import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";
import type { Upstream } from "./proxy";

/**
 * Upstream timeouts (docs/srs/upstream-timeouts.md, docs/add/upstream-timeouts.md): how long the gateway waits for a
 * provider's headers (`first_byte_s`) and between two chunks of its body (`idle_s`). 0 turns a limit off.
 */
export interface Timeouts {
  first_byte_s: number;
  idle_s: number;
}
export const TIMEOUTS_DEFAULT: Timeouts = { first_byte_s: 300, idle_s: 300 };
export const TIMEOUTS_HINT = "first_byte_s, idle_s: 0 (off) or 10 to 3600 seconds";

const isLimit = (v: unknown) => typeof v === "number" && Number.isInteger(v) && (v === 0 || (v >= 10 && v <= 3600));

/** `current` with the fields of `patch`; null when a field is not a limit. */
export function mergeTimeouts(current: Timeouts, patch: Record<string, unknown>): Timeouts | null {
  const next = { ...current };
  for (const k of ["first_byte_s", "idle_s"] as const) {
    if (!(k in patch)) continue;
    if (!isLimit(patch[k])) return null;
    next[k] = patch[k] as number;
  }
  return next;
}

export async function getTimeouts(db: D1Database): Promise<Timeouts> {
  const row = await db.prepare("SELECT value FROM setting WHERE key = 'timeouts'").first<{ value: string }>();
  if (!row) return TIMEOUTS_DEFAULT;
  try {
    return mergeTimeouts(TIMEOUTS_DEFAULT, JSON.parse(row.value) as Record<string, unknown>) ?? TIMEOUTS_DEFAULT;
  } catch {
    return TIMEOUTS_DEFAULT;
  }
}

export async function saveTimeouts(db: D1Database, value: Timeouts): Promise<void> {
  await db
    .prepare("INSERT INTO setting (key, value, updated_at) VALUES ('timeouts', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(JSON.stringify(value), Math.floor(Date.now() / 1000))
    .run();
}

// ---- A combo's own limits (docs/srs/combo-timeouts.md) -------------------------------------------------------

/** The limits a combo sets; a field left out follows the gateway setting. */
export type TimeoutsPatch = Partial<Timeouts>;
export const COMBO_TIMEOUTS_HINT = "timeouts: null, or {first_byte_s, idle_s}, each 0 (off), 10 to 3600, or null (the gateway setting)";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The patch to store from an API body: null when nothing is set, "bad" when a field is wrong (FR-CTO-01, 07). */
export function timeoutsPatch(v: unknown): TimeoutsPatch | null | "bad" {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) return "bad";
  const out: TimeoutsPatch = {};
  for (const [k, x] of Object.entries(v)) {
    if (k !== "first_byte_s" && k !== "idle_s") return "bad";
    if (x === null) continue;
    if (!isLimit(x)) return "bad";
    out[k] = x as number;
  }
  return Object.keys(out).length ? out : null;
}

/** The stored column as a patch; a damaged value reads as none. */
export function readTimeoutsPatch(raw: string | null | undefined): TimeoutsPatch | null {
  if (!raw) return null;
  try {
    const p = timeoutsPatch(JSON.parse(raw));
    return p === "bad" ? null : p;
  } catch {
    return null;
  }
}

// ---- Per request ---------------------------------------------------------------------------------------------

interface Deadlines extends Timeouts {
  /** How long one second of a limit lasts: 1000, or less in tests (Deps.secondMs). */
  secondMs: number;
  /** The client's request: when it is aborted, every provider request it started is aborted too (FR-SEL-18). */
  client?: AbortSignal;
}
const perRequest = new AsyncLocalStorage<Deadlines>();
/** Outside a request (the provider sign-in callback) the defaults apply. */
const current = (): Deadlines => perRequest.getStore() ?? { ...TIMEOUTS_DEFAULT, secondMs: 1000 };

/** Runs `fn` with these limits for every `withDeadlines` call inside it, and ties those calls to `client`. */
export function runWithDeadlines<T>(t: Timeouts, secondMs: number, fn: () => T, client?: AbortSignal): T {
  return perRequest.run({ ...t, secondMs, client }, fn);
}

/**
 * Runs `fn` with the current request's limits, each field of `patch` in place of the gateway one (FR-CTO-02). The
 * second length and the client signal stay. With no patch, `fn` runs as it is.
 */
export function withTimeoutsPatch<T>(patch: TimeoutsPatch | null, fn: () => T): T {
  if (!patch) return fn();
  return perRequest.run({ ...current(), ...patch }, fn);
}

/** True when the client of the current request has gone away: its failure is not the provider's. */
export const clientGone = (): boolean => perRequest.getStore()?.client?.aborted === true;

/** Reads the setting once per request; the gateway and admin routes run inside it (app.ts). */
export const withTimeouts =
  (secondMs = 1000): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    let t = TIMEOUTS_DEFAULT;
    try {
      t = await getTimeouts(c.env.DB);
    } catch {
      // no setting table yet: the defaults
    }
    await runWithDeadlines(t, secondMs, next, c.req.raw.signal);
  };

// ---- The wrapper ---------------------------------------------------------------------------------------------

export class UpstreamTimeout extends Error {
  constructor(
    readonly kind: "first_byte" | "idle",
    readonly host: string,
    readonly seconds: number,
  ) {
    super(`${host} did not answer within ${seconds} s`);
    this.name = "UpstreamTimeout";
  }
}

/** One line per timeout: the kind, the host and the limit. Never a path, a query or a key. */
const log = (e: UpstreamTimeout) => console.warn(JSON.stringify({ level: "warn", event: "upstream_timeout", kind: e.kind, host: e.host, seconds: e.seconds }));

/**
 * `fetcher` with the current request's limits. Past the first-byte limit it answers 504 (a 5xx, so the routers move to
 * the next account or combo target); past the idle limit it ends the body with an `UpstreamTimeout`. Either way it
 * aborts the request to the provider. The caller's own `req.signal`, and the client's request, still abort it.
 */
export function withDeadlines(fetcher: Upstream): Upstream {
  return async (req) => {
    const d = current();
    if (!d.first_byte_s && !d.idle_s && !d.client) return fetcher(req);
    const host = new URL(req.url).host;
    const ctl = new AbortController();
    for (const signal of [req.signal, d.client]) {
      if (!signal) continue;
      if (signal.aborted) ctl.abort(signal.reason);
      else signal.addEventListener("abort", () => ctl.abort(signal.reason), { once: true });
    }
    const sent = fetcher(new Request(req, { signal: ctl.signal }));

    let res: Response;
    if (d.first_byte_s) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), d.first_byte_s * d.secondMs)));
      const first = await Promise.race([sent, late]).finally(() => clearTimeout(timer));
      if (first === null) {
        const e = new UpstreamTimeout("first_byte", host, d.first_byte_s);
        ctl.abort(e);
        sent.then((r) => r.body?.cancel(e)).catch(() => {});
        log(e);
        return Response.json({ type: "error", error: { type: "api_error", message: e.message } }, { status: 504, headers: { "x-gateway-timeout": "first_byte" } });
      }
      res = first;
    } else {
      res = await sent;
    }
    if (!d.idle_s || !res.body) return res;
    return new Response(watch(res.body, d.idle_s * d.secondMs, () => new UpstreamTimeout("idle", host, d.idle_s), ctl), res);
  };
}

/** `body`, ended with `timeout()` when a read waits longer than `ms`. Only waiting reads count, not a slow client. */
function watch(body: ReadableStream<Uint8Array>, ms: number, timeout: () => UpstreamTimeout, ctl: AbortController): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
      const read = reader.read();
      let r: ReadableStreamReadResult<Uint8Array> | null;
      try {
        r = await Promise.race([read, late]);
      } catch (e) {
        c.error(e);
        return;
      } finally {
        clearTimeout(timer);
      }
      if (r === null) {
        const e = timeout();
        read.catch(() => {});
        reader.cancel(e).catch(() => {});
        ctl.abort(e);
        log(e);
        c.error(e);
      } else if (r.done) {
        c.close();
      } else {
        c.enqueue(r.value);
      }
    },
    cancel(reason) {
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
}
