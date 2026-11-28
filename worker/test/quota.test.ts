import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, call, fakeUpstream, reset, type FakeUpstream } from "./helpers";

// The quota page (FR-QUO-01..13): what each provider says is left. Fake upstreams only; no real key or token.

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (account: string) => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email: "dev@example.com", "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "plus" } }))}.sig`;
const tokens = (n: number) => ({ access_token: `at-${n}`, refresh_token: `rt-${n}`, id_token: idToken("acc_1"), expires_in: 3600 });
const now = () => Math.floor(Date.now() / 1000);

const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown, envOverride?: Record<string, unknown>) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, envOverride);

/** A Codex connection signed in through the console, as in codex.test.ts. */
async function codex(): Promise<string> {
  const up = fakeUpstream(() => json(tokens(1)));
  const start = JSON.parse((await adminCall(up, "POST", "/oauth/codex/start")).text) as { authorize_url: string };
  const state = new URL(start.authorize_url).searchParams.get("state");
  const r = await adminCall(up, "POST", "/oauth/codex/finish", { callback_url: `http://localhost:1455/auth/callback?code=c&state=${state}` });
  expect(r.res.status, r.text).toBe(201);
  return (JSON.parse(r.text) as { id: string }).id;
}

async function keyed(provider: string, apiKey: string): Promise<string> {
  const r = await adminCall(fakeUpstream(() => json({})), "POST", "/connections", { provider, name: `${provider} main`, api_key: apiKey });
  expect(r.res.status, r.text).toBe(201);
  return (JSON.parse(r.text) as { id: string }).id;
}

const USAGE = {
  plan_type: "plus",
  rate_limit: {
    limit_reached: false,
    primary_window: { used_percent: 25, reset_at: 1_900_000_000 },
    secondary_window: { used_percent: 80.5, reset_at: 1_900_500_000_000 },
  },
  code_review_rate_limit: { primary_window: { used_percent: 10, reset_at: 1_900_000_100 } },
  rate_limit_reset_credits: { available_count: 2 },
};

beforeEach(reset);

describe("quota list", () => {
  it("lists only the connections whose provider reports a quota, with no secret, and the hidden rows", async () => {
    const id = await codex();
    const groq = await keyed("groq", "gsk_test_quota_list_0001");
    await keyed("openai", "sk-test-not-a-quota-provider");
    const r = await adminCall(fakeUpstream(() => json({})), "GET", "/quota");
    expect(r.res.status).toBe(200);
    const body = JSON.parse(r.text) as { providers: string[]; connections: { id: string; provider: string }[]; hidden: Record<string, string[]> };
    expect(body.providers).toEqual(["codex", "groq", "openrouter", "github", "deepseek", "ollama"]);
    expect(body.connections.map((c) => c.id).sort()).toEqual([id, groq].sort());
    expect(body.hidden).toEqual({});
    expect((body as unknown as { others: unknown }).others).toEqual([{ provider: "openai", accounts: 1 }]);
    expect(r.text).not.toContain("secret");
    expect(r.text).not.toContain("gsk_test");
  });

  it("stores the hidden rows per provider, and refuses a bad body", async () => {
    const up = fakeUpstream(() => json({}));
    const put = await adminCall(up, "PUT", "/quota/hidden", { provider: "codex", names: ["review_session", "review_weekly"] });
    expect(put.res.status, put.text).toBe(200);
    expect(JSON.parse(put.text)).toEqual({ codex: ["review_session", "review_weekly"] });
    await adminCall(up, "PUT", "/quota/hidden", { provider: "groq", names: [] });
    expect(JSON.parse((await adminCall(up, "GET", "/quota")).text).hidden).toEqual({ codex: ["review_session", "review_weekly"] });
    for (const bad of [{ provider: "openai", names: [] }, { provider: "codex", names: "x" }, { provider: "codex", names: [1] }, { provider: "codex", names: Array(51).fill("a") }]) {
      expect((await adminCall(up, "PUT", "/quota/hidden", bad)).res.status).toBe(400);
    }
  });
});

describe("Codex quota", () => {
  it("reads wham/usage with the account's token and turns the windows into rows", async () => {
    const id = await codex();
    const up = fakeUpstream(() => json(USAGE));
    const r = await adminCall(up, "GET", `/quota/${id}`);
    expect(r.res.status, r.text).toBe(200);
    const sent = up.calls[0]!;
    expect(sent.method).toBe("GET");
    expect(sent.url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(sent.headers.get("authorization")).toBe("Bearer at-1");
    expect(sent.headers.get("chatgpt-account-id")).toBe("acc_1");
    const q = JSON.parse(r.text);
    expect(q).toMatchObject({ plan: "plus", limit_reached: false, reset_credits: 2, message: null, error: null });
    expect(q.windows).toEqual([
      { name: "session", kind: "percent", used: 25, total: 100, remaining_percent: 75, reset_at: 1_900_000_000, period_seconds: null },
      { name: "weekly", kind: "percent", used: 80.5, total: 100, remaining_percent: 19.5, reset_at: 1_900_500_000, period_seconds: null },
      { name: "review_session", kind: "percent", used: 10, total: 100, remaining_percent: 90, reset_at: 1_900_000_100, period_seconds: null },
    ]);
    expect(r.text).not.toContain("at-1");
  });

  it("reads the other shapes: rate_limits_by_limit_id and additional_rate_limits", async () => {
    const id = await codex();
    const up = fakeUpstream(() =>
      json({
        summary: { plan: "pro" },
        rate_limits_by_limit_id: { codex: { rate_limit: { limit_reached: true, primary: { percent_used: 100, resets_at: "2030-01-01T00:00:00Z" } } } },
        additional_rate_limits: [{ limit_name: "gpt-5.3-codex-spark", primary_window: { used_percent: 5 } }],
      }),
    );
    const q = JSON.parse((await adminCall(up, "GET", `/quota/${id}`)).text);
    expect(q.plan).toBe("pro");
    expect(q.limit_reached).toBe(true);
    expect(q.windows).toEqual([
      { name: "session", kind: "percent", used: 100, total: 100, remaining_percent: 0, reset_at: 1_893_456_000, period_seconds: null },
      { name: "spark_session", kind: "percent", used: 5, total: 100, remaining_percent: 95, reset_at: null, period_seconds: null },
    ]);
  });

  it("tells a Business Standard seat (5-hour window) from a Premium one (weekly only)", async () => {
    const id = await codex();
    const H5 = 5 * 3600;
    const WEEK = 7 * 86400;
    const standard = { plan_type: "team", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: H5 }, secondary_window: { used_percent: 20, limit_window_seconds: WEEK } } };
    const q1 = JSON.parse((await adminCall(fakeUpstream(() => json(standard)), "GET", `/quota/${id}`)).text);
    expect(q1).toMatchObject({ plan: "team", seat: "standard" });
    expect(q1.windows.map((w: { name: string }) => w.name)).toEqual(["session", "weekly"]);

    // A Premium seat has no 5-hour window; its weekly one comes as primary and must not be called a session.
    const premium = { plan_type: "team", rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: WEEK } } };
    const q2 = JSON.parse((await adminCall(fakeUpstream(() => json(premium)), "GET", `/quota/${id}`)).text);
    expect(q2).toMatchObject({ plan: "team", seat: "premium" });
    expect(q2.windows.map((w: { name: string }) => w.name)).toEqual(["weekly"]);

    const minutes = { plan_type: "business", rate_limit: { primary_window: { used_percent: 1, window_minutes: 10080 } } };
    expect(JSON.parse((await adminCall(fakeUpstream(() => json(minutes)), "GET", `/quota/${id}`)).text).seat).toBe("premium");
  });

  it("says no seat when the plan is not Business or the windows' lengths are unknown", async () => {
    const id = await codex();
    expect(JSON.parse((await adminCall(fakeUpstream(() => json(USAGE)), "GET", `/quota/${id}`)).text).seat).toBeNull();
    const team = { ...USAGE, plan_type: "team" };
    expect(JSON.parse((await adminCall(fakeUpstream(() => json(team)), "GET", `/quota/${id}`)).text).seat).toBeNull();
  });

  it("says the usage API is unavailable when it fails, without rows", async () => {
    const id = await codex();
    const q = JSON.parse((await adminCall(fakeUpstream(() => json({ detail: "x" }, 500)), "GET", `/quota/${id}`)).text);
    expect(q).toMatchObject({ windows: [], message: "Codex connected. Usage API temporarily unavailable (500).", error: null });
  });

  it("renews a refused token once and asks again; a second refusal is an error", async () => {
    const id = await codex();
    let usage = 0;
    const up = fakeUpstream((req) => {
      if (req.url.includes("/oauth/token")) return json(tokens(2));
      usage++;
      return req.headers.get("authorization") === "Bearer at-2" ? json(USAGE) : json({ detail: "expired" }, 401);
    });
    const q = JSON.parse((await adminCall(up, "GET", `/quota/${id}`)).text);
    expect(usage).toBe(2);
    expect(q.windows).toHaveLength(3);

    const refused = fakeUpstream((req) => (req.url.includes("/oauth/token") ? json(tokens(3)) : json({ detail: "no" }, 401)));
    const e = JSON.parse((await adminCall(refused, "GET", `/quota/${id}`)).text);
    expect(e.error).toEqual({ status: 401, message: "Codex refused the account's token: sign in again" });
  });

  it("goes through the Codex relay when one is set", async () => {
    const id = await codex();
    const up = fakeUpstream(() => json(USAGE));
    await adminCall(up, "GET", `/quota/${id}`, undefined, { CODEX_RELAY_URL: "https://relay.test/", CODEX_RELAY_SECRET: "test-relay-secret" });
    expect(up.calls[0]!.url).toBe("https://relay.test/wham/usage");
    expect(up.calls[0]!.headers.get("x-relay-secret")).toBe("test-relay-secret");
  });

  it("reports chatgpt.com's block page as such", async () => {
    const id = await codex();
    const up = fakeUpstream(() => new Response("<html>blocked</html>", { status: 403, headers: { "content-type": "text/html" } }));
    const q = JSON.parse((await adminCall(up, "GET", `/quota/${id}`)).text);
    expect(q.error.status).toBe(502);
    expect(q.error.message).toContain("CODEX_RELAY_URL");
  });

  it("lists the reset credits with their dates", async () => {
    const id = await codex();
    const up = fakeUpstream(() => json({ available_count: 1, credits: [{ status: "available", granted_at: 1_900_000_000, expires_at: "2030-01-01T00:00:00Z" }] }));
    const r = await adminCall(up, "GET", `/quota/${id}/reset-credits`);
    expect(r.res.status, r.text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
    expect(up.calls[0]!.headers.get("openai-beta")).toBe("codex-1");
    expect(up.calls[0]!.headers.get("originator")).toBe("codex_cli_rs");
    expect(JSON.parse(r.text)).toEqual({ available_count: 1, credits: [{ status: "available", granted_at: 1_900_000_000, expires_at: 1_893_456_000 }] });
  });

  it("spends one reset credit; 409 when there is none", async () => {
    const id = await codex();
    const up = fakeUpstream(() => json({ code: "reset", windows_reset: 2 }));
    const r = await adminCall(up, "POST", `/quota/${id}/reset-credit`);
    expect(r.res.status, r.text).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ windows_reset: 2 });
    expect(up.calls[0]!.method).toBe("POST");
    expect(up.calls[0]!.url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
    expect(JSON.parse(up.bodies[0]!).redeem_request_id).toMatch(/^[0-9a-f-]{36}$/);

    const none = await adminCall(fakeUpstream(() => json({ code: "no_credit" })), "POST", `/quota/${id}/reset-credit`);
    expect(none.res.status).toBe(409);
    expect(JSON.parse(none.text)).toEqual({ error: "no_credit" });
  });
});

describe("API-key quotas", () => {
  it("DeepSeek: the balance per currency", async () => {
    const id = await keyed("deepseek", "sk-test-quota-deepseek-01");
    const up = fakeUpstream(() => json({ is_available: false, balance_infos: [{ currency: "usd", total_balance: "4.20", granted_balance: "0", topped_up_balance: "4.20" }] }));
    const q = JSON.parse((await adminCall(up, "GET", `/quota/${id}`)).text);
    expect(up.calls[0]!.url).toBe("https://api.deepseek.com/user/balance");
    expect(q.plan).toBe("DeepSeek (Insufficient Balance)");
    expect(q.windows).toEqual([{ name: "Balance (USD)", kind: "balance", used: 0, total: 4.2, remaining_percent: 100, reset_at: null, period_seconds: null, currency: "USD" }]);
  });

  it("answers 404 for a connection whose provider reports no quota, or none at all", async () => {
    const id = await keyed("openai", "sk-test-no-quota-here-01");
    const up = fakeUpstream(() => json({}));
    expect((await adminCall(up, "GET", `/quota/${id}`)).res.status).toBe(404);
    expect((await adminCall(up, "GET", "/quota/nope")).res.status).toBe(404);
    const groq = await keyed("groq", "gsk_test_quota_groq_0003");
    expect((await adminCall(up, "GET", `/quota/${groq}/reset-credits`)).res.status).toBe(404);
    expect((await adminCall(up, "POST", `/quota/${groq}/reset-credit`)).res.status).toBe(404);
    expect(up.calls).toHaveLength(0);
  });

  it("says when the stored key cannot be opened", async () => {
    const id = await keyed("deepseek", "sk-test-quota-deepseek-02");
    await env.DB.prepare("UPDATE connection SET secret = 'broken' WHERE id = ?").bind(id).run();
    const q = JSON.parse((await adminCall(fakeUpstream(() => json({})), "GET", `/quota/${id}`)).text);
    expect(q.error).toEqual({ status: 0, message: "the stored key cannot be opened (CONNECTIONS_KEY changed)" });
  });
});
