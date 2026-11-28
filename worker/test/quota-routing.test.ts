import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset } from "./helpers";
import { exhaustedUntil, readLimits, shareLeft } from "../limits";

// Routing by what is left (limits.ts): the gateway remembers the rate-limit headers a provider sends with its
// answers, sets an account that is out aside until its reset, and can order accounts by the share they have left.

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const COMPLETION = { id: "c1", object: "chat.completion", model: "m1", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } };
const admin = (method: string, path: string, body?: unknown) =>
  call(fakeUpstream(() => json({})), `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const chat = (token: string, model: string) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) });
const allow = (id: string, patterns: string[]) => env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(patterns), id).run();
const now = () => Math.floor(Date.now() / 1000);
const bearer = (req: Request) => req.headers.get("authorization")!.replace("Bearer gsk-", "");

async function connect(name: string): Promise<string> {
  const r = await admin("POST", "/connections", { provider: "groq", name, api_key: `gsk-${name}` });
  expect(r.res.status, r.text).toBe(201);
  return (JSON.parse(r.text) as { id: string }).id;
}

/** Groq-style limit headers: `left` of `limit` requests, back in `reset`. */
const limits = (left: number, limit = 1000, reset = "1h", tokensLeft = 7000) => ({
  "x-ratelimit-limit-requests": String(limit),
  "x-ratelimit-remaining-requests": String(left),
  "x-ratelimit-reset-requests": reset,
  "x-ratelimit-limit-tokens": "8000",
  "x-ratelimit-remaining-tokens": String(tokensLeft),
  "x-ratelimit-reset-tokens": "30s",
});
const limitRow = (id: string, model = "m1") => env.DB.prepare("SELECT * FROM connection_limit WHERE connection = ? AND model = ?").bind(id, model).first<Record<string, number | string | null>>();
const seed = (id: string, model: string, left: number, limit: number, resetAt: number) =>
  env.DB.prepare("INSERT OR REPLACE INTO connection_limit (connection, model, requests_limit, requests_remaining, requests_reset_at, tokens_limit, tokens_remaining, tokens_reset_at, seen_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)")
    .bind(id, model, limit, left, resetAt, now())
    .run();

async function setup(names: string[]): Promise<{ token: string; ids: Record<string, string> }> {
  const token = await addSystem("chat");
  await allow("chat", ["groq/*"]);
  const ids: Record<string, string> = {};
  for (const n of names) ids[n] = await connect(n);
  return { token, ids };
}

/** Sends `n` chats; `answer` decides each account's reply. Returns which account each upstream call used. */
async function send(token: string, n: number, answer: (account: string) => Response, model = "groq/m1"): Promise<string[]> {
  const up = fakeUpstream((req) => answer(bearer(req)));
  for (let i = 0; i < n; i++) await call(up, "/openai/v1/chat/completions", chat(token, model));
  return up.calls.map(bearer);
}

beforeEach(reset);

describe("reading a provider's limit headers", () => {
  it("takes requests and tokens, with the reset as a duration, seconds, a unix time or a date", () => {
    const t = 1_800_000_000;
    expect(readLimits(new Headers(limits(750, 1000, "2m30s", 7927)), t)).toEqual({ requests_limit: 1000, requests_remaining: 750, requests_reset_at: t + 150, tokens_limit: 8000, tokens_remaining: 7927, tokens_reset_at: t + 30 });
    const reset = (v: string) => readLimits(new Headers({ "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "1", "x-ratelimit-reset-requests": v }), t)!.requests_reset_at;
    expect(reset("547ms")).toBe(t + 1);
    expect(reset("60")).toBe(t + 60);
    expect(reset("1800000500")).toBe(1_800_000_500);
    expect(reset("2027-01-15T08:00:00Z")).toBe(Math.floor(Date.parse("2027-01-15T08:00:00Z") / 1000));
    expect(reset("soon")).toBeNull();
    // Requests only: the token side stays unknown.
    expect(readLimits(new Headers({ "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "4" }), t)).toEqual({ requests_limit: 10, requests_remaining: 4, requests_reset_at: null, tokens_limit: null, tokens_remaining: null, tokens_reset_at: null });
    expect(readLimits(new Headers({ "content-type": "application/json" }), t)).toBeNull();
  });

  it("an account is out while a limit is at zero and its reset is still ahead", () => {
    const l = { requests_limit: 1000, requests_remaining: 0, requests_reset_at: 500, tokens_limit: 8000, tokens_remaining: 100, tokens_reset_at: 130 };
    expect(exhaustedUntil(l, 100)).toBe(500);
    expect(exhaustedUntil(l, 600)).toBe(0);
    expect(exhaustedUntil({ ...l, requests_remaining: 5, tokens_remaining: 0 }, 100)).toBe(130);
    expect(exhaustedUntil({ ...l, requests_remaining: 5 }, 100)).toBe(0);
    // Out with no reset time: nothing says until when, so it is not set aside on that alone.
    expect(exhaustedUntil({ ...l, requests_reset_at: null }, 100)).toBe(0);
    expect(exhaustedUntil(null, 100)).toBe(0);
  });

  it("the share left is the tighter of the two limits; unknown or past its reset counts as full", () => {
    const l = { requests_limit: 1000, requests_remaining: 250, requests_reset_at: 500, tokens_limit: 8000, tokens_remaining: 6000, tokens_reset_at: 130 };
    expect(shareLeft(l, 100)).toBe(0.25);
    expect(shareLeft({ ...l, tokens_remaining: 800 }, 100)).toBe(0.1);
    // The token minute is over: only requests count.
    expect(shareLeft({ ...l, tokens_remaining: 800 }, 200)).toBe(0.25);
    expect(shareLeft(l, 600)).toBe(1);
    expect(shareLeft(null, 100)).toBe(1);
  });
});

describe("remembering limits from traffic", () => {
  it("keeps what the provider said with its answer, per account and model, and nothing when it says nothing", async () => {
    const { token, ids } = await setup(["a"]);
    const before = now();
    await send(token, 1, () => json(COMPLETION, 200, limits(750, 1000, "2m30s", 7927)));
    const l = (await limitRow(ids.a!))!;
    expect(l).toMatchObject({ requests_limit: 1000, requests_remaining: 750, tokens_limit: 8000, tokens_remaining: 7927 });
    expect(l.requests_reset_at as number).toBeGreaterThanOrEqual(before + 150);
    expect(l.seen_at as number).toBeGreaterThanOrEqual(before);
    // Another model of the same account has limits of its own.
    await send(token, 1, () => json(COMPLETION, 200, limits(10, 30)), "groq/m2");
    expect(await limitRow(ids.a!, "m2")).toMatchObject({ requests_limit: 30, requests_remaining: 10 });
    expect(await limitRow(ids.a!)).toMatchObject({ requests_remaining: 750 });
    // The next answer replaces it.
    await send(token, 1, () => json(COMPLETION, 200, limits(749)));
    expect(await limitRow(ids.a!)).toMatchObject({ requests_remaining: 749 });
    const { token: t2, ids: other } = { token, ids: { b: await connect("b") } };
    await env.DB.prepare("UPDATE connection SET disabled = 1 WHERE id = ?").bind(ids.a!).run();
    await send(t2, 1, () => json(COMPLETION));
    expect(await limitRow(other.b!)).toBeNull();
  });

  it("keeps the limits of a refusal too, and forgets them with the connection", async () => {
    const { token, ids } = await setup(["a"]);
    await send(token, 1, () => json({ error: { message: "rate limit" } }, 429, { ...limits(0), "retry-after": "30" }));
    expect(await limitRow(ids.a!)).toMatchObject({ requests_remaining: 0 });
    expect((await admin("DELETE", `/connections/${ids.a!}`)).res.status).toBe(204);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM connection_limit").first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe("accounts that are out", () => {
  it("are set aside until their reset, without waiting for a refusal", async () => {
    const { token, ids } = await setup(["a", "b"]);
    // a answers, and says that was its last request for an hour.
    expect(await send(token, 1, (acc) => json(COMPLETION, 200, acc === "a" ? limits(0) : limits(900)))).toEqual(["a"]);
    // The next requests go straight to b: a is not asked.
    expect(await send(token, 2, () => json(COMPLETION, 200, limits(900)))).toEqual(["b", "b"]);
    // Its reset has come: a is first again.
    await env.DB.prepare("UPDATE connection_limit SET requests_reset_at = ? WHERE connection = ?").bind(now() - 5, ids.a!).run();
    expect(await send(token, 1, () => json(COMPLETION, 200, limits(1000)))).toEqual(["a"]);
  });

  it("are still tried, soonest reset first, when every account is out", async () => {
    const { token, ids } = await setup(["a", "b"]);
    await seed(ids.a!, "m1", 0, 1000, now() + 3600);
    await seed(ids.b!, "m1", 0, 1000, now() + 60);
    // The key in the environment (vitest.config.ts has one for groq) comes before accounts that are set aside;
    // once it is refused, the account whose reset is nearest is asked.
    const used = await send(token, 1, (acc) => (acc === "test-groq" ? json({ error: { message: "rate limit" } }, 429) : json(COMPLETION, 200, limits(5))));
    expect(used.slice(-1)).toEqual(["b"]);
    expect(used).not.toContain("a");
  });

  it("only for the model that is out", async () => {
    const { token, ids } = await setup(["a", "b"]);
    await seed(ids.a!, "m2", 0, 1000, now() + 3600);
    expect(await send(token, 1, () => json(COMPLETION))).toEqual(["a"]);
    expect(await send(token, 1, () => json(COMPLETION), "groq/m2")).toEqual(["b"]);
  });
});

describe("quota-left order", () => {
  it("is a provider strategy next to fill-first and round-robin", async () => {
    const set = await admin("PUT", "/providers/groq/strategy", { strategy: "quota-left" });
    expect(set.res.status, set.text).toBe(200);
    expect(JSON.parse(set.text)).toEqual({ provider: "groq", strategy: "quota-left" });
    const list = JSON.parse((await admin("GET", "/providers")).text) as { id: string; strategy: string }[];
    expect(list.find((p) => p.id === "groq")!.strategy).toBe("quota-left");
  });

  it("asks the account with the largest share left; one not heard from yet counts as full", async () => {
    const { token, ids } = await setup(["a", "b", "c"]);
    await admin("PUT", "/providers/groq/strategy", { strategy: "quota-left" });
    await seed(ids.a!, "m1", 100, 1000, now() + 3600);
    await seed(ids.b!, "m1", 800, 1000, now() + 3600);
    const left: Record<string, number> = { a: 100, b: 800, c: 500 };
    // c is unknown, so it goes first and reports 50%; then b (80%) until it falls under c.
    const used = await send(token, 3, (acc) => json(COMPLETION, 200, limits(acc === "b" ? (left.b -= 400) : left[acc]!)));
    expect(used).toEqual(["c", "b", "c"]);
  });

  it("keeps the priority order among accounts with the same share", async () => {
    const { token } = await setup(["a", "b"]);
    await admin("PUT", "/providers/groq/strategy", { strategy: "quota-left" });
    expect(await send(token, 2, () => json(COMPLETION))).toEqual(["a", "a"]);
  });
});

describe("Groq quota page", () => {
  it("shows what traffic last said instead of spending a request, when that is newer", async () => {
    const { token, ids } = await setup(["a"]);
    await send(token, 1, () => json(COMPLETION, 200, limits(640, 1000, "6h", 7000)));
    const up = fakeUpstream(() => json({}));
    const q = JSON.parse((await call(up, `/admin/quota/${ids.a!}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).text);
    expect(up.calls).toHaveLength(0);
    expect(q).toMatchObject({ scope: "m1", limit_reached: false, error: null });
    expect(q.windows[0]).toMatchObject({ name: "Requests", kind: "count", used: 360, total: 1000, remaining_percent: 64, period_seconds: 86400 });
    expect(q.windows[1]).toMatchObject({ name: "Tokens", used: 1000, total: 8000, period_seconds: 60 });
  });
});
