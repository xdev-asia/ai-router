import type { Hono } from "hono";
import type { AppEnv } from "./env";
import { DEFAULT_PRICES } from "./pricing-defaults";

/**
 * The Usage page's data: totals for a period, by provider,
 * model, account and system, a series over time for the charts, the latest requests, one row per request, and a
 * cost estimate from default prices (pricing-defaults.ts) the owner may override. The cost is an estimate: it is not
 * what a provider bills. Accounts and systems are named by their name and key hint only, never their key.
 * A failed request is one with status 400 or above; latency is the mean of the requests that recorded one.
 */

const PERIODS = { today: 0, "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400, "60d": 60 * 86_400, all: -1 } as const;
type Period = keyof typeof PERIODS;
const isPeriod = (v: string): v is Period => Object.hasOwn(PERIODS, v);

const HOUR = 3600;
const DAY = 86_400;
/** At most this many daily buckets for "all"; older requests still count in the totals. */
const MAX_DAYS = 366;

/** Unix seconds of the caller's midnight on the day of `nowSec`; `tzMin` is minutes east of UTC. */
const midnight = (nowSec: number, tzMin: number) => Math.floor((nowSec + tzMin * 60) / DAY) * DAY - tzMin * 60;

/** Unix seconds the period starts at: the caller's midnight for "today", 0 for "all". */
function periodStart(period: Period, nowMs: number, tzMin = 0): number {
  const nowSec = Math.floor(nowMs / 1000);
  if (period === "all") return 0;
  if (period === "today") return midnight(nowSec, tzMin);
  return nowSec - PERIODS[period];
}

/** `?tz=` minutes east of UTC (UTC+7 is 420), -840..840; 0 when absent, null when bad. */
function tzParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return 0;
  if (!/^-?\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= -840 && n <= 840 ? n : null;
}

const TARGET = /^[a-z][a-z0-9-]*\/[A-Za-z0-9._:\/@+-]{1,200}$/;

interface Price {
  target: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}
type Rates = Omit<Price, "target">;

const DEFAULTS = new Map<string, Rates>(DEFAULT_PRICES.map(([target, input, output, cache_read, cache_write]) => [target, { input, output, cache_read, cache_write }]));

interface Tokens {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** Requests with status 400 or above. */
  errors: number;
  /** Sum and count of the latencies recorded (older rows have none), for the mean. */
  latency_sum: number;
  latency_n: number;
}
type Group = Tokens & { system_id: string; provider: string; model: string | null; connection_id: string | null; last_at: number };
type Costed = Tokens & { cost: number | null; last_at: number | null };

/** The price of `provider/model`: its exact target, else the longest target the name starts with. */
function priceOf(prices: Price[], provider: string, model: string | null): Price | null {
  const name = `${provider}/${model ?? ""}`;
  let best: Price | null = null;
  for (const p of prices) {
    if (name.startsWith(p.target) && (!best || p.target.length > best.target.length)) best = p;
  }
  return best;
}

/** US dollars for these tokens at prices per million tokens. */
const costOf = (t: Tokens, p: Rates) =>
  (t.input_tokens * p.input + t.output_tokens * p.output + t.cache_read_input_tokens * p.cache_read + t.cache_creation_input_tokens * p.cache_write) / 1_000_000;

const ZERO: Costed = {
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  errors: 0,
  latency_sum: 0,
  latency_n: 0,
  cost: null,
  last_at: null,
};

function add(into: Costed, g: Tokens & { last_at?: number }, cost: number | null): Costed {
  return {
    requests: into.requests + g.requests,
    input_tokens: into.input_tokens + g.input_tokens,
    output_tokens: into.output_tokens + g.output_tokens,
    cache_creation_input_tokens: into.cache_creation_input_tokens + g.cache_creation_input_tokens,
    cache_read_input_tokens: into.cache_read_input_tokens + g.cache_read_input_tokens,
    errors: into.errors + g.errors,
    latency_sum: into.latency_sum + g.latency_sum,
    latency_n: into.latency_n + g.latency_n,
    cost: cost === null ? into.cost : (into.cost ?? 0) + cost,
    last_at: g.last_at === undefined ? into.last_at : Math.max(into.last_at ?? 0, g.last_at),
  };
}

/** A group as the API answers it: the mean latency in place of its sum and count (null when none was timed). */
function present<T extends Tokens>({ latency_sum, latency_n, ...rest }: T): Omit<T, "latency_sum" | "latency_n"> & { latency_ms: number | null } {
  return { ...rest, latency_ms: latency_n > 0 ? Math.round(latency_sum / latency_n) : null };
}

const allTokens = (t: Tokens) => t.input_tokens + t.output_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;

/** Sums `groups` by `key`, most requests first (then most tokens). */
function rollup<K extends Record<string, string | null>>(groups: (Group & { cost: number | null })[], key: (g: Group) => K) {
  const out = new Map<string, K & Costed>();
  for (const g of groups) {
    const k = key(g);
    const id = JSON.stringify(k);
    out.set(id, { ...k, ...add(out.get(id) ?? ZERO, g, g.cost) });
  }
  return [...out.values()].sort((a, b) => b.requests - a.requests || allTokens(b) - allTokens(a)).map(present);
}

const intParam = (raw: string | undefined, min: number): number | null | undefined => {
  if (raw === undefined) return undefined;
  return /^\d+$/.test(raw) && Number(raw) >= min && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
};

const REQUEST_COLUMNS =
  "id, at, system_id, provider, model, status, streamed, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, latency_ms";
type RequestRow = Omit<Group, "requests" | "connection_id" | "last_at"> & { id: number; at: number; status: number; streamed: number; latency_ms: number | null };

const SUMS = `COUNT(*) AS requests,
  COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
  COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
  COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
  COALESCE(SUM(latency_ms), 0) AS latency_sum, COUNT(latency_ms) AS latency_n`;

/** The prices in effect: the defaults, with what the owner entered on top. */
async function loadPrices(db: D1Database): Promise<Price[]> {
  const entered = (await db.prepare("SELECT target, input, output, cache_read, cache_write FROM price").all<Price>()).results;
  const out = new Map<string, Price>([...DEFAULTS].map(([target, r]) => [target, { target, ...r }]));
  for (const p of entered) out.set(p.target, p);
  return [...out.values()];
}

/**
 * The span just before a period, of the same length, for the change beside each total: yesterday from midnight to
 * this time of day for "today", none for "all". [from, to) in unix seconds.
 */
function previousWindow(period: Period, from: number, nowMs: number): { from: number; to: number } | null {
  if (period === "all") return null;
  if (period === "today") return { from: from - DAY, to: Math.floor(nowMs / 1000) - DAY };
  return { from: from - PERIODS[period], to: from };
}

/** The chart's buckets for a period: their start (unix seconds) and width. */
async function bucketsOf(db: D1Database, period: Period, nowSec: number, tzMin: number): Promise<{ start: number; step: number; count: number }> {
  if (period === "today") return { start: midnight(nowSec, tzMin), step: HOUR, count: 24 };
  if (period === "24h") return { start: Math.floor(nowSec / HOUR) * HOUR - 23 * HOUR, step: HOUR, count: 24 };
  const today = midnight(nowSec, tzMin);
  if (period !== "all") {
    const days = PERIODS[period] / DAY;
    return { start: today - (days - 1) * DAY, step: DAY, count: days };
  }
  const first = await db.prepare("SELECT MIN(at) AS at FROM usage").first<{ at: number | null }>();
  const days = first?.at == null ? 1 : Math.min(MAX_DAYS, Math.floor((today - midnight(first.at, tzMin)) / DAY) + 1);
  return { start: today - (days - 1) * DAY, step: DAY, count: Math.max(1, days) };
}

export function reportRoutes(a: Hono<AppEnv>): void {
  /** `?period=today|24h|7d|30d|60d|all` (default 24h), `tz` (minutes east of UTC, for "today"). */
  a.get("/usage/summary", async (c) => {
    const period = c.req.query("period") ?? "24h";
    if (!isPeriod(period)) return c.json({ error: "invalid_period", hint: Object.keys(PERIODS).join(", ") }, 400);
    const tz = tzParam(c.req.query("tz"));
    if (tz === null) return c.json({ error: "invalid_input", hint: "tz: minutes east of UTC, -840..840" }, 400);
    const nowMs = Date.now();
    const from = periodStart(period, nowMs, tz);
    const before = previousWindow(period, from, nowMs);
    const [grouped, recent, prices, systems, accounts, earlier] = await Promise.all([
      c.env.DB.prepare(
        `SELECT system_id, provider, model, connection_id, ${SUMS}, MAX(at) AS last_at
         FROM usage WHERE at >= ? GROUP BY system_id, provider, model, connection_id`,
      )
        .bind(from)
        .all<Group>(),
      c.env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM usage WHERE at >= ? ORDER BY id DESC LIMIT 10`).bind(from).all<RequestRow>(),
      loadPrices(c.env.DB),
      // Names only: never the token's hash.
      c.env.DB.prepare("SELECT id, name FROM system").all<{ id: string; name: string }>(),
      // Name and the key's last 4 characters only: never the sealed secret.
      c.env.DB.prepare("SELECT id, name, hint FROM connection").all<{ id: string; name: string; hint: string | null }>(),
      before
        ? c.env.DB.prepare(`SELECT provider, model, ${SUMS} FROM usage WHERE at >= ? AND at < ? GROUP BY provider, model`)
            .bind(before.from, before.to)
            .all<Tokens & { provider: string; model: string | null }>()
        : null,
    ]);
    const systemName = new Map(systems.results.map((s) => [s.id, s.name]));
    const account = new Map(accounts.results.map((a) => [a.id, a]));
    const groups = grouped.results.map((g) => {
      const price = priceOf(prices, g.provider, g.model);
      return { ...g, cost: price ? costOf(g, price) : null };
    });
    const totals = groups.reduce((sum, g) => add(sum, g, g.cost), ZERO);
    const previous = earlier?.results.reduce((sum, g) => {
      const price = priceOf(prices, g.provider, g.model);
      return add(sum, g, price ? costOf(g, price) : null);
    }, ZERO);
    return c.json({
      period,
      from,
      // The same span just before, for the change beside each total; null for "all".
      previous: previous ? present(previous) : null,
      totals: { ...present(totals), unpriced_requests: groups.filter((g) => g.cost === null).reduce((n, g) => n + g.requests, 0) },
      by_provider: rollup(groups, (g) => ({ provider: g.provider })),
      by_model: rollup(groups, (g) => ({ provider: g.provider, model: g.model })),
      // A secret-file key has no account: those rows group by provider, with no name.
      by_connection: rollup(groups, (g) => {
        const acc = g.connection_id ? account.get(g.connection_id) : undefined;
        return { connection_id: g.connection_id, provider: g.provider, name: acc?.name ?? null, hint: acc?.hint ?? null };
      }),
      by_system: rollup(groups, (g) => ({ system_id: g.system_id, name: systemName.get(g.system_id) ?? null })),
      recent: recent.results.map((r) => ({ ...r, streamed: r.streamed === 1 })),
    });
  });

  /**
   * The charts' series: `?period=` as for the summary, `tz` (minutes east of UTC). Today and 24h: 24 hourly
   * buckets; the others: one per day of the caller's calendar, ending today. Each bucket: its start `t` (unix
   * seconds), requests, failed requests (errors), tokens (all four kinds) and cost (null when none of its requests has a price).
   */
  a.get("/usage/chart", async (c) => {
    const period = c.req.query("period") ?? "24h";
    if (!isPeriod(period)) return c.json({ error: "invalid_period", hint: Object.keys(PERIODS).join(", ") }, 400);
    const tz = tzParam(c.req.query("tz"));
    if (tz === null) return c.json({ error: "invalid_input", hint: "tz: minutes east of UTC, -840..840" }, 400);
    const nowSec = Math.floor(Date.now() / 1000);
    const { start, step, count } = await bucketsOf(c.env.DB, period, nowSec, tz);
    const [grouped, prices] = await Promise.all([
      c.env.DB.prepare(
        `SELECT CAST((at - ?1) / ?2 AS INTEGER) AS b, provider, model, ${SUMS}
         FROM usage WHERE at >= ?1 AND at < ?1 + ?2 * ?3 GROUP BY b, provider, model`,
      )
        .bind(start, step, count)
        .all<Tokens & { b: number; provider: string; model: string | null }>(),
      loadPrices(c.env.DB),
    ]);
    const buckets = Array.from({ length: count }, (_, i) => ({ t: start + i * step, requests: 0, errors: 0, tokens: 0, cost: 0 as number | null, priced: false }));
    for (const g of grouped.results) {
      const b = buckets[Math.floor(g.b)];
      if (!b) continue;
      const price = priceOf(prices, g.provider, g.model);
      b.requests += g.requests;
      b.errors += g.errors;
      b.tokens += allTokens(g);
      if (price) {
        b.cost = (b.cost ?? 0) + costOf(g, price);
        b.priced = true;
      }
    }
    return c.json({
      period,
      step,
      buckets: buckets.map(({ priced, ...b }) => ({ ...b, cost: b.requests > 0 && !priced ? null : b.cost })),
    });
  });

  /**
   * One row per request, newest first. `?provider=&model=&system=&from=&to=` (unix seconds), `status=ok|error`
   * (below 400, or 400 and up), `limit` (1-200, default 50), `before` (a row id, for the next page).
   */
  a.get("/usage/requests", async (c) => {
    const limit = intParam(c.req.query("limit"), 1);
    const from = intParam(c.req.query("from"), 0);
    const to = intParam(c.req.query("to"), 0);
    const before = intParam(c.req.query("before"), 1);
    const status = c.req.query("status") ?? "";
    if (limit === null || from === null || to === null || before === null || (limit ?? 0) > 200 || !["", "ok", "error"].includes(status)) {
      return c.json({ error: "invalid_input", hint: "limit: 1-200, from, to: unix seconds, before: a row id, status: ok or error" }, 400);
    }
    const where: string[] = [];
    const args: (string | number)[] = [];
    const filter = (sql: string, v: string | number | undefined) => {
      if (v === undefined || v === "") return;
      where.push(sql);
      args.push(v);
    };
    filter("provider = ?", c.req.query("provider"));
    filter("model = ?", c.req.query("model"));
    if (status) where.push(status === "ok" ? "status < 400" : "status >= 400");
    filter("system_id = ?", c.req.query("system"));
    filter("at >= ?", from);
    filter("at <= ?", to);
    filter("id < ?", before);
    const r = await c.env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM usage ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .bind(...args, limit ?? 50)
      .all<RequestRow>();
    return c.json({ rows: r.results.map((x) => ({ ...x, streamed: x.streamed === 1 })) });
  });

  /**
   * Prices in effect, in US dollars per million tokens, sorted by target: each with `custom` (the owner entered
   * it) and `default` (its price in pricing-defaults.ts, or null when it has none).
   */
  a.get("/pricing", async (c) => {
    const entered = new Set((await c.env.DB.prepare("SELECT target FROM price").all<{ target: string }>()).results.map((r) => r.target));
    const list = (await loadPrices(c.env.DB)).map((p) => ({ ...p, custom: entered.has(p.target), default: DEFAULTS.get(p.target) ?? null }));
    return c.json(list.sort((x, y) => x.target.localeCompare(y.target)));
  });

  a.put("/pricing", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const price = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
    const optional = (v: unknown) => v === undefined || price(v);
    if (!b || typeof b.target !== "string" || !TARGET.test(b.target) || !price(b.input) || !price(b.output) || !optional(b.cache_read) || !optional(b.cache_write)) {
      return c.json({ error: "invalid_input", hint: "target: provider/model; input, output, cache_read, cache_write: dollars per million tokens, >= 0" }, 400);
    }
    const row: Price = { target: b.target, input: b.input as number, output: b.output as number, cache_read: (b.cache_read as number | undefined) ?? 0, cache_write: (b.cache_write as number | undefined) ?? 0 };
    await c.env.DB.prepare(
      `INSERT INTO price (target, input, output, cache_read, cache_write, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (target) DO UPDATE SET input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
         cache_write = excluded.cache_write, updated_at = excluded.updated_at`,
    )
      .bind(row.target, row.input, row.output, row.cache_read, row.cache_write, Math.floor(Date.now() / 1000))
      .run();
    return c.json(row);
  });

  /** Removes the price the owner entered: the default, if there is one, applies again. 404 when nothing was entered. */
  a.delete("/pricing", async (c) => {
    const r = await c.env.DB.prepare("DELETE FROM price WHERE target = ?").bind(c.req.query("target") ?? "").run();
    if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });
}
