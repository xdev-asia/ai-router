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

// ---- Per request ---------------------------------------------------------------------------------------------

interface Deadlines extends Timeouts {
  /** How long one second of a limit lasts: 1000, or less in tests (Deps.secondMs). */
  secondMs: number;
}
const perRequest = new AsyncLocalStorage<Deadlines>();
/** Outside a request (the provider sign-in callback) the defaults apply. */
const current = (): Deadlines => perRequest.getStore() ?? { ...TIMEOUTS_DEFAULT, secondMs: 1000 };

/** Runs `fn` with these limits for every `withDeadlines` call inside it. */
export function runWithDeadlines<T>(t: Timeouts, secondMs: number, fn: () => T): T {
  return perRequest.run({ ...t, secondMs }, fn);
}

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
    await runWithDeadlines(t, secondMs, next);
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
 * aborts the request to the provider. The caller's own `req.signal` still aborts it.
 */
export function withDeadlines(fetcher: Upstream): Upstream {
  return async (req) => {
    const d = current();
    if (!d.first_byte_s && !d.idle_s) return fetcher(req);
    const host = new URL(req.url).host;
    const ctl = new AbortController();
    if (req.signal.aborted) ctl.abort(req.signal.reason);
    else req.signal.addEventListener("abort", () => ctl.abort(req.signal.reason), { once: true });
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
