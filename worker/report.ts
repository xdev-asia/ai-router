import type { Hono } from "hono";
import type { AppEnv } from "./env";

/**
 * The Usage page's data (the idea of 9router's Usage & Analytics, written anew): totals for a period, by provider,
 * model and system, the latest requests, one row per request, and a cost estimate from prices the owner enters.
 * The cost is an estimate: it is not what a provider bills.
 */

const PERIODS = { today: 0, "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400, "60d": 60 * 86_400, all: -1 } as const;
type Period = keyof typeof PERIODS;
const isPeriod = (v: string): v is Period => Object.hasOwn(PERIODS, v);

/** Unix seconds the period starts at: UTC midnight for "today", 0 for "all". */
function periodStart(period: Period, nowMs: number): number {
  if (period === "all") return 0;
  if (period === "today") return Math.floor(nowMs / 86_400_000) * 86_400;
  return Math.floor(nowMs / 1000) - PERIODS[period];
}

const TARGET = /^[a-z][a-z0-9-]*\/[A-Za-z0-9._:\/@+-]{1,200}$/;

interface Price {
  target: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

interface Tokens {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}
type Group = Tokens & { system_id: string; provider: string; model: string | null };
type Costed = Tokens & { cost: number | null };

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
const costOf = (t: Tokens, p: Price) =>
  (t.input_tokens * p.input + t.output_tokens * p.output + t.cache_read_input_tokens * p.cache_read + t.cache_creation_input_tokens * p.cache_write) / 1_000_000;

const ZERO: Costed = { requests: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost: null };

function add(into: Costed, g: Tokens, cost: number | null): Costed {
  return {
    requests: into.requests + g.requests,
    input_tokens: into.input_tokens + g.input_tokens,
    output_tokens: into.output_tokens + g.output_tokens,
    cache_creation_input_tokens: into.cache_creation_input_tokens + g.cache_creation_input_tokens,
    cache_read_input_tokens: into.cache_read_input_tokens + g.cache_read_input_tokens,
    cost: cost === null ? into.cost : (into.cost ?? 0) + cost,
  };
}

const allTokens = (t: Tokens) => t.input_tokens + t.output_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;

/** Sums `groups` by `key`, most requests first (then most tokens). */
function rollup<K extends Record<string, string | null>>(groups: (Group & { cost: number | null })[], key: (g: Group) => K): (K & Costed)[] {
  const out = new Map<string, K & Costed>();
  for (const g of groups) {
    const k = key(g);
    const id = JSON.stringify(k);
    out.set(id, { ...k, ...add(out.get(id) ?? ZERO, g, g.cost) });
  }
  return [...out.values()].sort((a, b) => b.requests - a.requests || allTokens(b) - allTokens(a));
}

const intParam = (raw: string | undefined, min: number): number | null | undefined => {
  if (raw === undefined) return undefined;
  return /^\d+$/.test(raw) && Number(raw) >= min && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
};

const REQUEST_COLUMNS =
  "id, at, system_id, provider, model, status, streamed, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, latency_ms";
type RequestRow = Omit<Group, "requests"> & { id: number; at: number; status: number; streamed: number; latency_ms: number | null };

export function reportRoutes(a: Hono<AppEnv>): void {
  const loadPrices = async (db: D1Database) => (await db.prepare("SELECT target, input, output, cache_read, cache_write FROM price").all<Price>()).results;

  /** `?period=today|24h|7d|30d|60d|all` (default 24h). */
  a.get("/usage/summary", async (c) => {
    const period = c.req.query("period") ?? "24h";
    if (!isPeriod(period)) return c.json({ error: "invalid_period", hint: Object.keys(PERIODS).join(", ") }, 400);
    const from = periodStart(period, Date.now());
    const [grouped, recent, prices] = await Promise.all([
      c.env.DB.prepare(
        `SELECT system_id, provider, model, COUNT(*) AS requests,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
                SUM(cache_read_input_tokens) AS cache_read_input_tokens
         FROM usage WHERE at >= ? GROUP BY system_id, provider, model`,
      )
        .bind(from)
        .all<Group>(),
      c.env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM usage WHERE at >= ? ORDER BY id DESC LIMIT 10`).bind(from).all<RequestRow>(),
      loadPrices(c.env.DB),
    ]);
    const groups = grouped.results.map((g) => {
      const price = priceOf(prices, g.provider, g.model);
      return { ...g, cost: price ? costOf(g, price) : null };
    });
    const totals = groups.reduce((sum, g) => add(sum, g, g.cost), ZERO);
    return c.json({
      period,
      from,
      totals: { ...totals, unpriced_requests: groups.filter((g) => g.cost === null).reduce((n, g) => n + g.requests, 0) },
      by_provider: rollup(groups, (g) => ({ provider: g.provider })),
      by_model: rollup(groups, (g) => ({ provider: g.provider, model: g.model })),
      by_system: rollup(groups, (g) => ({ system_id: g.system_id })),
      recent: recent.results.map((r) => ({ ...r, streamed: r.streamed === 1 })),
    });
  });

  /** One row per request, newest first. `?provider=&system=&from=&to=` (unix seconds), `limit` (1-200, default 50), `before` (a row id, for the next page). */
  a.get("/usage/requests", async (c) => {
    const limit = intParam(c.req.query("limit"), 1);
    const from = intParam(c.req.query("from"), 0);
    const to = intParam(c.req.query("to"), 0);
    const before = intParam(c.req.query("before"), 1);
    if (limit === null || from === null || to === null || before === null || (limit ?? 0) > 200) {
      return c.json({ error: "invalid_input", hint: "limit: 1-200, from, to: unix seconds, before: a row id" }, 400);
    }
    const where: string[] = [];
    const args: (string | number)[] = [];
    const filter = (sql: string, v: string | number | undefined) => {
      if (v === undefined || v === "") return;
      where.push(sql);
      args.push(v);
    };
    filter("provider = ?", c.req.query("provider"));
    filter("system_id = ?", c.req.query("system"));
    filter("at >= ?", from);
    filter("at <= ?", to);
    filter("id < ?", before);
    const r = await c.env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM usage ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .bind(...args, limit ?? 50)
      .all<RequestRow>();
    return c.json({ rows: r.results.map((x) => ({ ...x, streamed: x.streamed === 1 })) });
  });

  /** Prices for the cost estimate, in US dollars per million tokens. */
  a.get("/pricing", async (c) => c.json((await loadPrices(c.env.DB)).sort((x, y) => x.target.localeCompare(y.target))));

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

  a.delete("/pricing", async (c) => {
    const r = await c.env.DB.prepare("DELETE FROM price WHERE target = ?").bind(c.req.query("target") ?? "").run();
    if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });
}
