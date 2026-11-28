/**
 * Rate limits as providers report them with their answers: `x-ratelimit-limit-requests`, `-remaining-requests`,
 * `-reset-requests` and the same three for tokens (OpenAI's names; Groq and many OpenAI-compatible providers send
 * them). The gateway keeps the latest per account and model (table connection_limit) and routes by it
 * (connections.ts): an account at zero is set aside until its reset, and "quota-left" asks the account with the
 * largest share left first. Nothing here reads a body, a key or a token.
 */

export interface Limits {
  requests_limit: number | null;
  requests_remaining: number | null;
  /** Unix seconds; null when the provider gave none. */
  requests_reset_at: number | null;
  tokens_limit: number | null;
  tokens_remaining: number | null;
  tokens_reset_at: number | null;
  /** Unix seconds: when the provider said this. Absent on limits just read from an answer. */
  seen_at?: number | null;
}

/** A limit with no reset time is trusted this long; after that the account counts as full, so it is asked again. */
const NO_RESET_TRUST_S = 3600;

/**
 * What an account's limits are kept under (connection_limit.model): the model, as providers count limits per
 * model. OpenRouter counts the free requests of a day over all its `:free` models together, so those share one.
 */
export function limitScope(provider: string, model: string): string {
  return provider === "openrouter" && model.endsWith(":free") ? ":free" : model;
}

type Fetch = (req: Request) => Promise<Response>;

/**
 * An OpenRouter account's free-model requests of the day, from its /key (chat answers carry no limit headers).
 * OpenRouter gives no reset time. Null when it cannot be read; an error body is never read (it may quote the key).
 */
export async function openrouterFreeLimits(upstream: Fetch, key: string): Promise<Limits | null> {
  let res: Response;
  try {
    res = await upstream(new Request("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}`, accept: "application/json" } }));
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { data?: { free_model_daily_requests?: { limit?: unknown; remaining?: unknown; used?: unknown } } } | null;
  const f = body?.data?.free_model_daily_requests;
  const limit = typeof f?.limit === "number" && f.limit > 0 ? Math.floor(f.limit) : null;
  if (limit === null) return null;
  const left = typeof f?.remaining === "number" ? f.remaining : typeof f?.used === "number" ? limit - f.used : null;
  if (left === null) return null;
  return { requests_limit: limit, requests_remaining: Math.max(0, Math.floor(left)), requests_reset_at: null, tokens_limit: null, tokens_remaining: null, tokens_reset_at: null };
}

/** A Go duration ("2m30s", "500ms", "1h") in seconds; null when there is none. */
export function parseGoDuration(v: string | null): number | null {
  if (!v) return null;
  const unit: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };
  let total = 0;
  let found = false;
  for (const m of v.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(m[1]) * unit[m[2]!]!;
    found = true;
  }
  return found ? total : null;
}

const count = (v: string | null): number | null => {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

/** A reset header as unix seconds: a duration ("6m0s"), seconds from now ("60"), a unix time, or a date. */
function resetAt(v: string | null, now: number): number | null {
  if (v === null || v.trim() === "") return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 1e12) return Math.floor(n / 1000);
    return n >= 1e9 ? Math.floor(n) : Math.ceil(now + n);
  }
  const d = parseGoDuration(s);
  if (d !== null) return Math.ceil(now + d);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

/** The limits in an answer's headers; null when it names no limit at all. */
export function readLimits(h: Headers, now: number): Limits | null {
  const side = (which: "requests" | "tokens") => {
    const limit = count(h.get(`x-ratelimit-limit-${which}`));
    const remaining = count(h.get(`x-ratelimit-remaining-${which}`));
    if (limit === null || remaining === null) return null;
    return { limit, remaining, reset: resetAt(h.get(`x-ratelimit-reset-${which}`), now) };
  };
  const r = side("requests");
  const t = side("tokens");
  if (!r && !t) return null;
  return {
    requests_limit: r?.limit ?? null,
    requests_remaining: r?.remaining ?? null,
    requests_reset_at: r?.reset ?? null,
    tokens_limit: t?.limit ?? null,
    tokens_remaining: t?.remaining ?? null,
    tokens_reset_at: t?.reset ?? null,
  };
}

export async function saveLimits(db: D1Database, connection: string, model: string, l: Limits, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connection_limit (connection, model, requests_limit, requests_remaining, requests_reset_at, tokens_limit, tokens_remaining, tokens_reset_at, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection, model) DO UPDATE SET requests_limit = excluded.requests_limit, requests_remaining = excluded.requests_remaining,
         requests_reset_at = excluded.requests_reset_at, tokens_limit = excluded.tokens_limit, tokens_remaining = excluded.tokens_remaining,
         tokens_reset_at = excluded.tokens_reset_at, seen_at = excluded.seen_at`,
    )
    .bind(connection, model, l.requests_limit, l.requests_remaining, l.requests_reset_at, l.tokens_limit, l.tokens_remaining, l.tokens_reset_at, now)
    .run();
}

/** Drops what is remembered about a connection that is gone. */
export async function forgetLimits(db: D1Database, connection: string): Promise<void> {
  await db.prepare("DELETE FROM connection_limit WHERE connection = ?").bind(connection).run();
}

/** The model an account was last heard from on, with its limits; null when it was never heard from. */
export async function latestLimits(db: D1Database, connection: string): Promise<(Limits & { model: string; seen_at: number }) | null> {
  return db
    .prepare("SELECT model, requests_limit, requests_remaining, requests_reset_at, tokens_limit, tokens_remaining, tokens_reset_at, seen_at FROM connection_limit WHERE connection = ? ORDER BY seen_at DESC LIMIT 1")
    .bind(connection)
    .first<Limits & { model: string; seen_at: number }>();
}

/**
 * Until when the account is out (unix seconds), 0 when it can be asked: a limit at zero whose reset is still
 * ahead. A limit at zero with no reset time says nothing about when, so it does not set the account aside.
 */
export function exhaustedUntil(l: Limits | null, now: number): number {
  if (!l) return 0;
  let until = 0;
  for (const [left, reset] of [
    [l.requests_remaining, l.requests_reset_at],
    [l.tokens_remaining, l.tokens_reset_at],
  ] as const) {
    if (left !== null && left <= 0 && reset !== null && reset > now) until = Math.max(until, reset);
  }
  return until;
}

/**
 * The share of its tighter limit the account has left, 0 to 1. A limit past its reset is full again; an account
 * never heard from counts as full, so it is asked and its limits become known. A limit with no reset time is
 * trusted for an hour from when it was seen.
 */
export function shareLeft(l: Limits | null, now: number): number {
  if (!l) return 1;
  const seen = l.seen_at ?? null;
  const one = (limit: number | null, left: number | null, reset: number | null): number => {
    if (limit === null || left === null || limit <= 0) return 1;
    if (reset !== null && reset <= now) return 1;
    if (reset === null && seen !== null && now - seen > NO_RESET_TRUST_S) return 1;
    return Math.min(1, Math.max(0, left / limit));
  };
  return Math.min(one(l.requests_limit, l.requests_remaining, l.requests_reset_at), one(l.tokens_limit, l.tokens_remaining, l.tokens_reset_at));
}
