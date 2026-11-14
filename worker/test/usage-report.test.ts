import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const admin = (method: string, path: string, body?: unknown) =>
  call(fakeUpstream(() => json({})), `/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = async (path: string) => JSON.parse((await admin("GET", path)).text);
const now = () => Math.floor(Date.now() / 1000);

type Row = { system?: string; provider: string; model: string | null; status?: number; ago: number; input?: number; output?: number; cacheWrite?: number; cacheRead?: number; latency?: number | null; connection?: string | null };
async function usage(r: Row): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage (system_id, provider, request_id, model, status, streamed, input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, at, latency_ms, connection_id) VALUES (?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(r.system ?? "chat", r.provider, r.model, r.status ?? 200, r.input ?? 0, r.output ?? 0, r.cacheWrite ?? 0, r.cacheRead ?? 0, now() - r.ago, r.latency ?? null, r.connection ?? null)
    .run();
}

/** Adds an API-key account through the admin API and returns its id. Fake keys only. */
async function connect(provider: string, name: string, apiKey: string): Promise<string> {
  const r = await admin("POST", "/connections", { provider, name, api_key: apiKey });
  expect(r.res.status, r.text).toBe(201);
  return (JSON.parse(r.text) as { id: string }).id;
}

type PriceRow = { target: string; input: number; output: number; cache_read: number; cache_write: number; custom: boolean; default: { input: number; output: number; cache_read: number; cache_write: number } | null };
const priceOf = async (target: string) => ((await get("/pricing")) as PriceRow[]).find((p) => p.target === target);

beforeEach(async () => {
  await reset();
  await addSystem("chat");
  await addSystem("xdevd");
});

describe("usage summary", () => {
  beforeEach(async () => {
    await usage({ provider: "openai", model: "gpt-5", ago: 100, input: 1000, output: 500, cacheRead: 200 });
    await usage({ provider: "openai", model: "gpt-5", ago: 50, input: 3000, output: 100, status: 429 });
    await usage({ system: "xdevd", provider: "anthropic", model: "claude-opus-5-5", ago: 10, input: 10, output: 20, cacheWrite: 30, cacheRead: 40 });
    await usage({ provider: "groq", model: "llama", ago: 90_000, input: 7, output: 3 }); // 25 hours ago
    await usage({ provider: "groq", model: "llama", ago: 40 * 86_400, input: 1, output: 1 }); // 40 days ago
  });

  it("adds up the requests of the period, in total and by provider, model and system", async () => {
    const s = await get("/usage/summary?period=24h");
    expect(s.period).toBe("24h");
    expect(s.totals).toMatchObject({ requests: 3, input_tokens: 4010, output_tokens: 620, cache_creation_input_tokens: 30, cache_read_input_tokens: 240 });
    expect(s.by_provider).toEqual([
      expect.objectContaining({ provider: "openai", requests: 2, input_tokens: 4000, output_tokens: 600 }),
      expect.objectContaining({ provider: "anthropic", requests: 1, input_tokens: 10, output_tokens: 20 }),
    ]);
    expect(s.by_model.map((m: { provider: string; model: string; requests: number }) => [m.provider, m.model, m.requests])).toEqual([
      ["openai", "gpt-5", 2],
      ["anthropic", "claude-opus-5-5", 1],
    ]);
    expect(s.by_system.map((m: { system_id: string; requests: number }) => [m.system_id, m.requests])).toEqual([
      ["chat", 2],
      ["xdevd", 1],
    ]);
  });

  it("widens with the period: 7d takes yesterday's request, 60d and all take the oldest", async () => {
    expect((await get("/usage/summary?period=7d")).totals.requests).toBe(4);
    expect((await get("/usage/summary?period=30d")).totals.requests).toBe(4);
    expect((await get("/usage/summary?period=60d")).totals.requests).toBe(5);
    expect((await get("/usage/summary?period=all")).totals.requests).toBe(5);
    expect((await get("/usage/summary")).period).toBe("24h");
    expect((await admin("GET", "/usage/summary?period=1y")).res.status).toBe(400);
  });

  it("lists the latest requests first, at most ten", async () => {
    for (let i = 0; i < 12; i++) await usage({ provider: "groq", model: "llama", ago: 5, input: i });
    const s = await get("/usage/summary?period=24h");
    expect(s.recent).toHaveLength(10);
    expect(s.recent[0]).toMatchObject({ provider: "groq", model: "llama", input_tokens: 11, status: 200 });
    expect(s.recent[9]).toMatchObject({ input_tokens: 2 });
  });
});

describe("cost estimate", () => {
  it("prices a model by its exact target, else by the longest target its name starts with", async () => {
    await usage({ provider: "openai", model: "gpt-5-2026", ago: 10, input: 1_000_000, output: 100_000, cacheRead: 500_000 });
    await usage({ provider: "openai", model: "gpt-5-mini-2026", ago: 10, input: 1_000_000, output: 0 });
    await usage({ provider: "groq", model: "llama", ago: 10, input: 1_000_000, output: 1_000_000 });
    expect((await admin("PUT", "/pricing", { target: "openai/gpt-5", input: 2, output: 10, cache_read: 0.2 })).res.status).toBe(200);
    expect((await admin("PUT", "/pricing", { target: "openai/gpt-5-mini", input: 0.5, output: 1 })).res.status).toBe(200);

    const s = await get("/usage/summary?period=24h");
    const cost = Object.fromEntries(s.by_model.map((m: { model: string; cost: number | null }) => [m.model, m.cost]));
    // 1M in at $2 + 0.1M out at $10 + 0.5M cache read at $0.2
    expect(cost["gpt-5-2026"]).toBeCloseTo(3.1, 6);
    expect(cost["gpt-5-mini-2026"]).toBeCloseTo(0.5, 6);
    expect(cost.llama).toBeNull();
    expect(s.totals.cost).toBeCloseTo(3.6, 6);
    expect(s.totals.unpriced_requests).toBe(1);
    expect(s.by_provider.find((p: { provider: string }) => p.provider === "groq").cost).toBeNull();
  });

  it("stores, lists, replaces and removes prices, and refuses bad ones", async () => {
    await admin("PUT", "/pricing", { target: "openai/my-tuned", input: 2, output: 10 });
    await admin("PUT", "/pricing", { target: "openai/my-tuned", input: 3, output: 12, cache_write: 4 });
    expect(await priceOf("openai/my-tuned")).toEqual({ target: "openai/my-tuned", input: 3, output: 12, cache_read: 0, cache_write: 4, custom: true, default: null });
    for (const bad of [{ target: "gpt-5", input: 1, output: 1 }, { target: "openai/gpt-5", input: -1, output: 1 }, { target: "openai/gpt-5", input: 1 }, { target: "openai/gpt-5", input: "1", output: 1 }]) {
      expect((await admin("PUT", "/pricing", bad)).res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await admin("DELETE", "/pricing?target=openai%2Fmy-tuned")).res.status).toBe(204);
    expect((await admin("DELETE", "/pricing?target=openai%2Fmy-tuned")).res.status).toBe(404);
    expect(await priceOf("openai/my-tuned")).toBeUndefined();
  });

  it("lists a default price for catalog models, sorted, before anything is entered", async () => {
    const list = (await get("/pricing")) as PriceRow[];
    expect(list.length).toBeGreaterThan(50);
    expect(list.map((p) => p.target)).toEqual([...list.map((p) => p.target)].sort((a, b) => a.localeCompare(b)));
    const sonnet = list.find((p) => p.target === "anthropic/claude-sonnet-4-20250514")!;
    expect(sonnet).toMatchObject({ input: 3, output: 15, cache_read: 1.5, cache_write: 3, custom: false });
    expect(sonnet.default).toEqual({ input: 3, output: 15, cache_read: 1.5, cache_write: 3 });
    expect(list.every((p) => p.custom === false)).toBe(true);
  });

  it("a default prices usage with nothing entered; an edit overrides it; reset brings the default back", async () => {
    await usage({ provider: "anthropic", model: "claude-sonnet-4-20250514", ago: 10, input: 1_000_000, output: 1_000_000 });
    expect((await get("/usage/summary?period=24h")).totals.cost).toBeCloseTo(18, 6);

    expect((await admin("PUT", "/pricing", { target: "anthropic/claude-sonnet-4-20250514", input: 1, output: 2 })).res.status).toBe(200);
    expect(await priceOf("anthropic/claude-sonnet-4-20250514")).toMatchObject({ input: 1, output: 2, cache_read: 0, custom: true, default: { input: 3, output: 15 } });
    expect((await get("/usage/summary?period=24h")).totals.cost).toBeCloseTo(3, 6);

    expect((await admin("DELETE", "/pricing?target=anthropic%2Fclaude-sonnet-4-20250514")).res.status).toBe(204);
    expect(await priceOf("anthropic/claude-sonnet-4-20250514")).toMatchObject({ input: 3, output: 15, custom: false });
    expect((await get("/usage/summary?period=24h")).totals.cost).toBeCloseTo(18, 6);
    // Nothing entered for it any more: a second reset has nothing to remove.
    expect((await admin("DELETE", "/pricing?target=anthropic%2Fclaude-sonnet-4-20250514")).res.status).toBe(404);
  });
});

describe("chart over time", () => {
  type Bucket = { t: number; requests: number; tokens: number; cost: number | null };
  const sum = (b: Bucket[], k: "requests" | "tokens") => b.reduce((n, x) => n + x[k], 0);

  beforeEach(async () => {
    await usage({ provider: "openai", model: "gpt-5", ago: 100, input: 1000, output: 500, cacheRead: 200 });
    await usage({ system: "xdevd", provider: "anthropic", model: "claude-sonnet-4-20250514", ago: 10, input: 1_000_000, output: 0 });
    await usage({ provider: "groq", model: "llama", ago: 90_000, input: 7, output: 3 }); // 25 hours ago
    await usage({ provider: "groq", model: "llama", ago: 40 * 86_400, input: 1, output: 1 }); // 40 days ago
  });

  it("24h: 24 hourly buckets ending with the current hour", async () => {
    const c = await get("/usage/chart?period=24h");
    expect(c).toMatchObject({ period: "24h", step: 3600 });
    expect(c.buckets).toHaveLength(24);
    for (let i = 1; i < 24; i++) expect(c.buckets[i].t - c.buckets[i - 1].t).toBe(3600);
    const last = c.buckets[23] as Bucket;
    expect(last.t).toBeLessThanOrEqual(now());
    expect(last.t + 3600).toBeGreaterThan(now());
    expect(sum(c.buckets, "requests")).toBe(2);
    expect(sum(c.buckets, "tokens")).toBe(1_001_700);
  });

  it("prices each bucket; a bucket with only unpriced requests has no cost", async () => {
    const c = await get("/usage/chart?period=7d");
    const costs = (c.buckets as Bucket[]).filter((b) => b.cost !== null).reduce((n, b) => n + (b.cost ?? 0), 0);
    // 1M input tokens of Claude Sonnet 4 at the default $3, plus gpt-5's default price for its few tokens.
    expect(costs).toBeGreaterThan(3);
    expect(costs).toBeLessThan(3.1);
    const empty = (c.buckets as Bucket[]).find((b) => b.requests === 0);
    expect(empty?.cost).toBe(0);
    // groq/llama has no price: the day of the request 25 hours ago holds only that one.
    expect((c.buckets as Bucket[]).find((b) => b.tokens === 10)?.cost).toBeNull();
  });

  it("7d, 30d and 60d: daily buckets ending today, in the caller's time zone", async () => {
    const tz = 420; // UTC+7
    const today = Math.floor((now() + tz * 60) / 86_400) * 86_400 - tz * 60;
    for (const [period, days, requests] of [["7d", 7, 3], ["30d", 30, 3], ["60d", 60, 4]] as const) {
      const c = await get(`/usage/chart?period=${period}&tz=${tz}`);
      expect(c.step).toBe(86_400);
      expect(c.buckets, period).toHaveLength(days);
      expect(c.buckets[days - 1].t).toBe(today);
      expect(sum(c.buckets, "requests"), period).toBe(requests);
    }
  });

  it("today: 24 hourly buckets from the caller's midnight; all: daily from the first request", async () => {
    const tz = -300; // UTC-5
    const midnight = Math.floor((now() + tz * 60) / 86_400) * 86_400 - tz * 60;
    const t = await get(`/usage/chart?period=today&tz=${tz}`);
    expect(t.buckets).toHaveLength(24);
    expect(t.buckets[0].t).toBe(midnight);
    const all = await get("/usage/chart?period=all");
    expect(sum(all.buckets, "requests")).toBe(4);
    expect(all.buckets.length).toBeGreaterThanOrEqual(40);
    expect(all.buckets.length).toBeLessThanOrEqual(42);
  });

  it("refuses an unknown period or time zone", async () => {
    for (const q of ["period=1y", "period=24h&tz=abc", "period=24h&tz=2000"]) expect((await admin("GET", `/usage/chart?${q}`)).res.status, q).toBe(400);
  });
});

describe("usage by account and by API key", () => {
  it("names each account (provider, name, key hint), never its key; secret-file keys have no account", async () => {
    const work = await connect("openai", "work", "sk-fake-work-00001111");
    const home = await connect("openai", "home", "sk-fake-home-00002222");
    await usage({ provider: "openai", model: "gpt-5", ago: 30, input: 10, connection: work });
    await usage({ provider: "openai", model: "gpt-5", ago: 20, input: 20, connection: work });
    await usage({ provider: "openai", model: "gpt-5", ago: 10, input: 30, connection: home });
    await usage({ provider: "groq", model: "llama", ago: 10, input: 5 });
    const r = await admin("GET", "/usage/summary?period=24h");
    expect(r.text).not.toContain("sk-fake");
    const s = JSON.parse(r.text);
    expect(s.by_connection).toEqual([
      expect.objectContaining({ connection_id: work, name: "work", provider: "openai", hint: "1111", requests: 2, input_tokens: 30 }),
      expect.objectContaining({ connection_id: home, name: "home", provider: "openai", hint: "2222", requests: 1 }),
      expect.objectContaining({ connection_id: null, name: null, provider: "groq", hint: null, requests: 1 }),
    ]);
  });

  it("names each system (gateway token) and says when it, a model and an account were last used", async () => {
    await usage({ provider: "openai", model: "gpt-5", ago: 300 });
    await usage({ provider: "openai", model: "gpt-5", ago: 30 });
    await usage({ system: "xdevd", provider: "openai", model: "gpt-5", ago: 200 });
    const s = await get("/usage/summary?period=24h");
    const names = await env.DB.prepare("SELECT id, name FROM system").all<{ id: string; name: string }>();
    const name = Object.fromEntries(names.results.map((x) => [x.id, x.name]));
    expect(s.by_system).toEqual([
      expect.objectContaining({ system_id: "chat", name: name.chat, requests: 2 }),
      expect.objectContaining({ system_id: "xdevd", name: name.xdevd, requests: 1 }),
    ]);
    expect(now() - s.by_system[0].last_at).toBeGreaterThanOrEqual(30);
    expect(now() - s.by_system[0].last_at).toBeLessThan(60);
    expect(now() - s.by_model[0].last_at).toBeLessThan(60);
    expect(JSON.stringify(s)).not.toContain("token_sha256");
  });

  it("a forwarded request records the account that answered it, also after a failover", async () => {
    const token = await addSystem("acct");
    await env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = 'acct'").bind(JSON.stringify(["openai/*"])).run();
    const a = await connect("openai", "a", "sk-fake-a-00000001");
    const b = await connect("openai", "b", "sk-fake-b-00000002");
    const up = fakeUpstream((req) =>
      req.headers.get("authorization") === "Bearer sk-fake-a-00000001"
        ? json({ error: { message: "slow down", type: "rate_limit_error" } }, 429)
        : json({ id: "c", object: "chat.completion", model: "gpt-5", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }),
    );
    const r = await call(up, "/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.res.status).toBe(200);
    const rows = await env.DB.prepare("SELECT status, connection_id FROM usage WHERE system_id = 'acct' ORDER BY id").all<{ status: number; connection_id: string | null }>();
    expect(rows.results).toEqual([
      { status: 429, connection_id: a },
      { status: 200, connection_id: b },
    ]);
  });
});

describe("request list", () => {
  beforeEach(async () => {
    await usage({ provider: "openai", model: "gpt-5", ago: 300, input: 1, latency: 900 });
    await usage({ provider: "groq", model: "llama", ago: 200, input: 2, status: 429, latency: 40 });
    await usage({ system: "xdevd", provider: "openai", model: "gpt-5", ago: 100, input: 3, latency: null });
  });

  it("lists requests newest first with their status, tokens and latency", async () => {
    const r = await get("/usage/requests");
    expect(r.rows.map((x: { input_tokens: number }) => x.input_tokens)).toEqual([3, 2, 1]);
    expect(r.rows[1]).toMatchObject({ system_id: "chat", provider: "groq", model: "llama", status: 429, streamed: false, latency_ms: 40 });
    expect(r.rows[0].latency_ms).toBeNull();
    expect(now() - r.rows[0].at).toBeGreaterThanOrEqual(100);
  });

  it("filters by provider, system and time, and pages with `before`", async () => {
    expect((await get("/usage/requests?provider=openai")).rows.map((x: { input_tokens: number }) => x.input_tokens)).toEqual([3, 1]);
    expect((await get("/usage/requests?system=xdevd")).rows.map((x: { input_tokens: number }) => x.input_tokens)).toEqual([3]);
    expect((await get(`/usage/requests?from=${now() - 250}&to=${now() - 150}`)).rows.map((x: { input_tokens: number }) => x.input_tokens)).toEqual([2]);
    const first = await get("/usage/requests?limit=2");
    expect(first.rows).toHaveLength(2);
    const next = await get(`/usage/requests?limit=2&before=${first.rows[1].id}`);
    expect(next.rows.map((x: { input_tokens: number }) => x.input_tokens)).toEqual([1]);
    for (const bad of ["limit=0", "limit=abc", "from=x", "before=-1"]) expect((await admin("GET", `/usage/requests?${bad}`)).res.status, bad).toBe(400);
  });

  it("a forwarded request records how long it took", async () => {
    // "off" is one of the systems vitest.config.ts gives an Anthropic key.
    const token = await addSystem("off");
    const up = fakeUpstream(() => json({ model: "claude-opus-5-5", usage: { input_tokens: 2, output_tokens: 1 } }));
    await call(up, "/anthropic/v1/messages", { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 1, messages: [] }) });
    const row = await env.DB.prepare("SELECT latency_ms FROM usage WHERE system_id = 'off'").first<{ latency_ms: number | null }>();
    expect(row).not.toBeNull();
    expect(typeof row!.latency_ms).toBe("number");
    expect(row!.latency_ms).toBeGreaterThanOrEqual(0);
    expect(row!.latency_ms).toBeLessThan(5000);
  });
});
