import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, call, fakeUpstream, reset, type FakeUpstream } from "./helpers";
import { agedReport, groqProbeModel, parseCodexUsage } from "../quota";

// Plans, reset cycles and free-tier usage on the quota page. Fake upstreams only; no real key or token.

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const now = () => Math.floor(Date.now() / 1000);
const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function keyed(provider: string, apiKey: string): Promise<string> {
  const r = await adminCall(fakeUpstream(() => json({})), "POST", "/connections", { provider, name: `${provider} main`, api_key: apiKey });
  expect(r.res.status, r.text).toBe(201);
  return (JSON.parse(r.text) as { id: string }).id;
}

const GROQ_MODELS = { data: [{ id: "whisper-large-v3" }, { id: "meta-llama/llama-prompt-guard-2-22m" }, { id: "qwen/qwen3-32b" }, { id: "openai/gpt-oss-20b" }] };
const GROQ_LIMITS = {
  "x-ratelimit-limit-requests": "1000",
  "x-ratelimit-remaining-requests": "750",
  "x-ratelimit-reset-requests": "6h",
  "x-ratelimit-limit-tokens": "8000",
  "x-ratelimit-remaining-tokens": "7927",
  "x-ratelimit-reset-tokens": "547ms",
};
/** Groq as the probe sees it: the model list (no limits on it), then one chat answer with the limits in its headers. */
const groq = (chat: () => Response = () => json({ choices: [] }, 200, GROQ_LIMITS)) => fakeUpstream((req) => (req.url.endsWith("/models") ? json(GROQ_MODELS) : chat()));

beforeEach(reset);

describe("quota list", () => {
  it("names every provider that reports a plan or a quota", async () => {
    const r = await adminCall(fakeUpstream(() => json({})), "GET", "/quota");
    expect(JSON.parse(r.text).providers).toEqual(["codex", "groq", "openrouter", "github", "deepseek", "ollama"]);
  });
});

describe("Codex plan and cycles", () => {
  it("says how long each window is, and whether the plan is the free one", () => {
    const usage = (plan: string) => parseCodexUsage({ plan_type: plan, rate_limit: { primary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 1_900_000_000 }, secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: 1_900_500_000 } } });
    const plus = usage("plus");
    expect(plus).toMatchObject({ plan: "plus", tier: "paid" });
    expect(plus.windows.map((w) => [w.name, w.period_seconds])).toEqual([["session", 18000], ["weekly", 604800]]);
    expect(usage("free").tier).toBe("free");
    expect(parseCodexUsage({}).tier).toBeNull();
  });
});

describe("Groq quota", () => {
  it("probes a small chat model, never a speech, guard or embedding one", () => {
    expect(groqProbeModel(["whisper-large-v3", "qwen/qwen3-32b", "llama-3.1-8b-instant"])).toBe("llama-3.1-8b-instant");
    expect(groqProbeModel(["canopylabs/orpheus-v1-english", "meta-llama/llama-prompt-guard-2-86m", "qwen/qwen3-32b"])).toBe("qwen/qwen3-32b");
    expect(groqProbeModel(["whisper-large-v3"])).toBeNull();
  });

  it("a kept answer stays limited only while a window is still empty", () => {
    const w = { name: "Requests", kind: "count" as const, used: 1000, total: 1000, remaining_percent: 0, reset_at: 500, period_seconds: 86400 };
    const kept = { plan: null, tier: null, seat: null, windows: [w], limit_reached: true, reset_credits: null, scope: "m", checked_at: 100, message: null, error: null };
    expect(agedReport(kept, 400).limit_reached).toBe(true);
    expect(agedReport(kept, 600)).toMatchObject({ limit_reached: false, windows: [{ used: 0, remaining_percent: 100, reset_at: null }], checked_at: 100 });
  });

  it("asks one chat answer of one token for the limits, which the model list does not carry", async () => {
    const id = await keyed("groq", "gsk_test_quota_plan_0001");
    const up = groq();
    const before = now();
    const r = await adminCall(up, "GET", `/quota/${id}`);
    const q = JSON.parse(r.text);
    expect(up.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://api.groq.com/openai/v1/models", "POST https://api.groq.com/openai/v1/chat/completions"]);
    expect(up.calls[1]!.headers.get("authorization")).toBe("Bearer gsk_test_quota_plan_0001");
    // A chat model the key has, never a speech or guard model.
    expect(JSON.parse(up.bodies[1]!)).toEqual({ model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
    expect(q).toMatchObject({ plan: null, tier: null, scope: "openai/gpt-oss-20b", limit_reached: false, error: null, message: null });
    expect(q.windows[0]).toMatchObject({ name: "Requests", kind: "count", used: 250, total: 1000, remaining_percent: 75, period_seconds: 86400 });
    expect(q.windows[0].reset_at).toBeGreaterThanOrEqual(before + 21600);
    expect(q.windows[1]).toMatchObject({ name: "Tokens", kind: "count", used: 73, total: 8000, period_seconds: 60 });
    expect(q.checked_at).toBeGreaterThanOrEqual(before);
    expect(r.text).not.toContain("gsk_test");
  });

  it("keeps the answer: a second look costs no request, and refresh=1 asks again", async () => {
    const id = await keyed("groq", "gsk_test_quota_plan_0002");
    const first = JSON.parse((await adminCall(groq(), "GET", `/quota/${id}`)).text);
    const again = groq();
    const kept = JSON.parse((await adminCall(again, "GET", `/quota/${id}`)).text);
    expect(again.calls).toHaveLength(0);
    expect(kept).toEqual(first);
    const fresh = groq(() => json({ choices: [] }, 200, { ...GROQ_LIMITS, "x-ratelimit-remaining-requests": "700" }));
    const q = JSON.parse((await adminCall(fresh, "GET", `/quota/${id}?refresh=1`)).text);
    expect(fresh.calls).toHaveLength(2);
    expect(q.windows[0].used).toBe(300);
  });

  it("a kept window whose reset time has passed is full again", async () => {
    const id = await keyed("groq", "gsk_test_quota_plan_0003");
    await adminCall(groq(), "GET", `/quota/${id}`);
    const row = await env.DB.prepare("SELECT report FROM quota_snapshot WHERE connection = ?").bind(id).first<{ report: string }>();
    const old = JSON.parse(row!.report);
    old.windows[0].reset_at = now() - 10;
    old.windows[1].reset_at = now() - 10;
    await env.DB.prepare("UPDATE quota_snapshot SET report = ? WHERE connection = ?").bind(JSON.stringify(old), id).run();
    const q = JSON.parse((await adminCall(groq(), "GET", `/quota/${id}`)).text);
    expect(q.windows[0]).toMatchObject({ used: 0, remaining_percent: 100, reset_at: null });
    expect(q.windows[1]).toMatchObject({ used: 0, remaining_percent: 100, reset_at: null });
  });

  it("a 429 on the probe says the limit is reached and still shows the windows", async () => {
    const id = await keyed("groq", "gsk_test_quota_plan_0004");
    const up = groq(() => json({ error: { message: "rate limit" } }, 429, { ...GROQ_LIMITS, "x-ratelimit-remaining-requests": "0", "retry-after": "30" }));
    const q = JSON.parse((await adminCall(up, "GET", `/quota/${id}`)).text);
    expect(q.limit_reached).toBe(true);
    expect(q.windows[0]).toMatchObject({ used: 1000, total: 1000, remaining_percent: 0 });
  });

  it("a refused key or a failed probe is an error that is not kept, and no body comes back", async () => {
    const id = await keyed("groq", "gsk_test_quota_plan_0005");
    const refused = JSON.parse((await adminCall(fakeUpstream(() => json({ error: { message: "bad key gsk_test_quota_plan_0005" } }, 401)), "GET", `/quota/${id}`)).text);
    expect(refused.error).toEqual({ status: 401, message: "Groq authentication failed. Check the API key." });
    expect(JSON.stringify(refused)).not.toContain("gsk_test");
    const broken = JSON.parse((await adminCall(groq(() => json({ error: { message: "gsk_test_quota_plan_0005 boom" } }, 500)), "GET", `/quota/${id}`)).text);
    expect(broken.error).toEqual({ status: 500, message: "Groq answered 500" });
    expect(JSON.stringify(broken)).not.toContain("gsk_test");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM quota_snapshot").first<{ n: number }>()).toEqual({ n: 0 });
    const none = JSON.parse((await adminCall(fakeUpstream(() => json({ data: [{ id: "whisper-large-v3" }] })), "GET", `/quota/${id}`)).text);
    expect(none.message).toBe("Groq connected. This key has no chat model to read the limits from.");
  });

  it("forgets the kept answer with the connection", async () => {
    const id = await keyed("groq", "gsk_test_quota_plan_0006");
    await adminCall(groq(), "GET", `/quota/${id}`);
    expect((await adminCall(groq(), "DELETE", `/connections/${id}`)).res.status).toBe(204);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM quota_snapshot").first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe("OpenRouter quota", () => {
  const KEY = (over: Record<string, unknown> = {}) => ({
    data: { label: "sk-or-v1-abc...123", limit: null, limit_reset: null, limit_remaining: null, usage: 0, is_free_tier: true, free_model_daily_requests: { used: 12, limit: 50, remaining: 38 }, ...over },
  });
  const openrouter = (key: unknown, credits: unknown = { data: { total_credits: 0, total_usage: 0 } }) => fakeUpstream((req) => (req.url.endsWith("/key") ? json(key) : json(credits)));

  it("free tier: the plan and today's free-model requests", async () => {
    const id = await keyed("openrouter", "sk-or-test-quota-plan-0001");
    const up = openrouter(KEY());
    const r = await adminCall(up, "GET", `/quota/${id}`);
    const q = JSON.parse(r.text);
    expect(up.calls.map((c) => c.url).sort()).toEqual(["https://openrouter.ai/api/v1/credits", "https://openrouter.ai/api/v1/key"]);
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer sk-or-test-quota-plan-0001");
    expect(q).toMatchObject({ plan: "Free", tier: "free", limit_reached: false, error: null });
    expect(q.windows).toEqual([{ name: "free_requests", kind: "count", used: 12, total: 50, remaining_percent: 76, reset_at: null, period_seconds: 86400 }]);
    expect(r.text).not.toContain("sk-or-");
  });

  it("paid: credits left, and the key's own spending limit with its cycle", async () => {
    const id = await keyed("openrouter", "sk-or-test-quota-plan-0002");
    const up = openrouter(KEY({ is_free_tier: false, limit: 20, limit_remaining: 5, usage: 15, limit_reset: "monthly", free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 } }), { data: { total_credits: 50, total_usage: 12.5 } });
    const q = JSON.parse((await adminCall(up, "GET", `/quota/${id}`)).text);
    expect(q).toMatchObject({ plan: "Paid", tier: "paid" });
    expect(q.windows).toEqual([
      { name: "free_requests", kind: "count", used: 0, total: 1000, remaining_percent: 100, reset_at: null, period_seconds: 86400 },
      { name: "key_limit", kind: "spend", used: 15, total: 20, remaining_percent: 25, reset_at: null, period_seconds: 2592000, currency: "USD" },
      { name: "credits", kind: "balance", used: 12.5, total: 37.5, remaining_percent: 75, reset_at: null, period_seconds: null, currency: "USD" },
    ]);
  });

  it("free requests used up with no credits: the limit is reached", async () => {
    const id = await keyed("openrouter", "sk-or-test-quota-plan-0003");
    const q = JSON.parse((await adminCall(openrouter(KEY({ free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } })), "GET", `/quota/${id}`)).text);
    expect(q.limit_reached).toBe(true);
    expect(q.windows[0].remaining_percent).toBe(0);
  });

  it("a refused key is an error, and the body never comes back", async () => {
    const id = await keyed("openrouter", "sk-or-test-quota-plan-0004");
    const q = JSON.parse((await adminCall(fakeUpstream(() => json({ error: { message: "no sk-or-test-quota-plan-0004" } }, 401)), "GET", `/quota/${id}`)).text);
    expect(q.error).toEqual({ status: 401, message: "OpenRouter authentication failed. Check the API key." });
    expect(JSON.stringify(q)).not.toContain("sk-or-");
  });
});

describe("GitHub Copilot quota", () => {
  const USER = {
    login: "octo",
    copilot_plan: "individual",
    access_type_sku: "free_educational_quota",
    quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
    quota_snapshots: {
      chat: { unlimited: true, percent_remaining: 100, entitlement: 0, remaining: 0 },
      completions: { unlimited: true, percent_remaining: 100, entitlement: 0, remaining: 0 },
      premium_interactions: { unlimited: false, percent_remaining: 99.1, entitlement: 200, remaining: 198, quota_remaining: 198.2 },
    },
  };
  /** Signs in with the device flow, then answers copilot_internal/user with `user`. */
  async function copilot(user: () => Response): Promise<{ id: string; up: FakeUpstream }> {
    const up = fakeUpstream((req) => {
      if (req.url === "https://github.com/login/device/code") return json({ device_code: "fake-device-code", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      if (req.url === "https://github.com/login/oauth/access_token") return json({ access_token: "fake-gh-at-1", token_type: "bearer", scope: "read:user" });
      if (req.url === "https://api.github.com/copilot_internal/v2/token") return json({ token: "fake-copilot-1", expires_at: now() + 1500 });
      if (req.url === "https://api.github.com/user") return json({ id: 42, login: "octo", name: "Octo Cat" });
      if (req.url === "https://api.github.com/copilot_internal/user") return user();
      return json({ message: "unexpected" }, 404);
    });
    const start = JSON.parse((await adminCall(up, "POST", "/oauth/github/start")).text) as { id: string };
    const done = await adminCall(up, "POST", "/oauth/github/poll", { id: start.id });
    expect(done.res.status, done.text).toBe(201);
    return { id: (JSON.parse(done.text) as { id: string }).id, up };
  }

  it("the plan, the premium requests of the month and the day they start again", async () => {
    const { id, up } = await copilot(() => json(USER));
    const r = await adminCall(up, "GET", `/quota/${id}`);
    const q = JSON.parse(r.text);
    const sent = up.calls.find((c) => c.url === "https://api.github.com/copilot_internal/user")!;
    // GitHub's own token, not the short-lived Copilot one.
    expect(sent.headers.get("authorization")).toBe("token fake-gh-at-1");
    expect(q).toMatchObject({ plan: "individual (free_educational_quota)", tier: "free", limit_reached: false, error: null });
    // Unlimited quotas are not rows.
    expect(q.windows).toEqual([{ name: "premium_interactions", kind: "count", used: 2, total: 200, remaining_percent: 99.1, reset_at: 1796083200, period_seconds: 30 * 86400 }]);
    expect(r.text).not.toContain("fake-gh-at-1");
  });

  it("a paid plan, and a month's quota used up", async () => {
    const { id, up } = await copilot(() => json({ ...USER, copilot_plan: "business", access_type_sku: "copilot_for_business_seat", quota_snapshots: { premium_interactions: { unlimited: false, percent_remaining: 0, entitlement: 300, remaining: 0 } } }));
    const q = JSON.parse((await adminCall(up, "GET", `/quota/${id}`)).text);
    expect(q).toMatchObject({ plan: "business (copilot_for_business_seat)", tier: "paid", limit_reached: true });
    expect(q.windows[0]).toMatchObject({ used: 300, total: 300, remaining_percent: 0 });
  });

  it("a refused token says to sign in again", async () => {
    const { id, up } = await copilot(() => json({ message: "Bad credentials fake-gh-at-1" }, 401));
    const q = JSON.parse((await adminCall(up, "GET", `/quota/${id}`)).text);
    expect(q.error).toEqual({ status: 401, message: "GitHub refused the account's token: sign in again" });
    expect(JSON.stringify(q)).not.toContain("fake-gh-at-1");
  });
});

describe("Ollama Cloud quota", () => {
  it("reports the plan; Ollama says nothing about limits", async () => {
    const id = await keyed("ollama", "ollama-test-quota-plan-0001");
    const up = fakeUpstream(() => json({ ID: "u1", Email: "dev@example.com", Name: "dev", Plan: "free" }));
    const r = await adminCall(up, "GET", `/quota/${id}`);
    const q = JSON.parse(r.text);
    expect(`${up.calls[0]!.method} ${up.calls[0]!.url}`).toBe("POST https://ollama.com/api/me");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer ollama-test-quota-plan-0001");
    expect(q).toMatchObject({ plan: "free", tier: "free", windows: [], error: null, message: null });
    expect(r.text).not.toContain("dev@example.com");
    const pro = JSON.parse((await adminCall(fakeUpstream(() => json({ Plan: "pro" })), "GET", `/quota/${id}`)).text);
    expect(pro).toMatchObject({ plan: "pro", tier: "paid" });
  });
});
