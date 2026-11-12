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

type Row = { system?: string; provider: string; model: string | null; status?: number; ago: number; input?: number; output?: number; cacheWrite?: number; cacheRead?: number; latency?: number | null };
async function usage(r: Row): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage (system_id, provider, request_id, model, status, streamed, input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, at, latency_ms) VALUES (?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(r.system ?? "chat", r.provider, r.model, r.status ?? 200, r.input ?? 0, r.output ?? 0, r.cacheWrite ?? 0, r.cacheRead ?? 0, now() - r.ago, r.latency ?? null)
    .run();
}

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
    await admin("PUT", "/pricing", { target: "openai/gpt-5", input: 2, output: 10 });
    await admin("PUT", "/pricing", { target: "openai/gpt-5", input: 3, output: 12, cache_write: 4 });
    expect(await get("/pricing")).toEqual([expect.objectContaining({ target: "openai/gpt-5", input: 3, output: 12, cache_read: 0, cache_write: 4 })]);
    for (const bad of [{ target: "gpt-5", input: 1, output: 1 }, { target: "openai/gpt-5", input: -1, output: 1 }, { target: "openai/gpt-5", input: 1 }, { target: "openai/gpt-5", input: "1", output: 1 }]) {
      expect((await admin("PUT", "/pricing", bad)).res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await admin("DELETE", "/pricing?target=openai%2Fgpt-5")).res.status).toBe(204);
    expect((await admin("DELETE", "/pricing?target=openai%2Fgpt-5")).res.status).toBe(404);
    expect(await get("/pricing")).toEqual([]);
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
