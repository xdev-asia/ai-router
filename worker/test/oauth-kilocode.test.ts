import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

// Every token here is a made-up value: nothing in this file reaches a real service.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CODES_URL = "https://api.kilo.ai/api/device-auth/codes";
const POLL_URL = `${CODES_URL}/FAKE-KC-CODE`;
const PROFILE_URL = "https://api.kilo.ai/api/profile";
const CHAT_URL = "https://api.kilo.ai/api/openrouter/chat/completions";
const COMPLETION = { id: "c1", object: "chat.completion", model: "anthropic/claude-sonnet-4-20250514", choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } };

/** Kilo Code as the sign-in sees it: the code, its poll, the profile and chat. */
function kilo(opts: { start?: () => Response; poll?: () => Response; profile?: () => Response; chat?: (n: number) => Response } = {}): FakeUpstream {
  let chats = 0;
  return fakeUpstream((req) => {
    if (req.url === CODES_URL && req.method === "POST") return opts.start ? opts.start() : json({ code: "FAKE-KC-CODE", verificationUrl: "https://app.kilo.ai/device-auth?code=FAKE-KC-CODE", expiresIn: 600 });
    if (req.url === POLL_URL && req.method === "GET") return opts.poll ? opts.poll() : json({ status: "approved", token: "fake-kilo-token-1", userEmail: "dev@example.com" });
    if (req.url === PROFILE_URL) return opts.profile ? opts.profile() : json({ email: "dev@example.com", organizations: [{ id: "fake-org-1", name: "Team" }] });
    if (req.url === CHAT_URL) return opts.chat ? opts.chat(++chats) : json(COMPLETION);
    return json({ message: "unexpected" }, 404);
  });
}

const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function startDevice(up: FakeUpstream): Promise<{ id: string; user_code: string; verification_uri: string; interval: number; expires_in: number }> {
  const r = await adminCall(up, "POST", "/oauth/kilocode/start");
  expect(r.res.status, r.text).toBe(200);
  return JSON.parse(r.text);
}

async function signIn(up = kilo()): Promise<Record<string, unknown>> {
  const d = await startDevice(up);
  const r = await adminCall(up, "POST", "/oauth/kilocode/poll", { id: d.id });
  expect(r.res.status, r.text).toBe(201);
  return JSON.parse(r.text);
}

const chat = (token: string, body: unknown) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
async function system(): Promise<string> {
  const token = await addSystem("chat");
  await env.DB.prepare("UPDATE system SET allowed_models = '[\"kilocode/*\"]' WHERE id = 'chat'").run();
  return token;
}
const MODEL = "anthropic/claude-sonnet-4-20250514";

beforeEach(reset);

describe("Kilo Code sign-in (device code)", () => {
  it("asks Kilo for a code with an empty JSON POST and shows the code and page", async () => {
    const up = kilo();
    const d = await startDevice(up);
    expect(d).toMatchObject({ flow: "device", user_code: "FAKE-KC-CODE", verification_uri: "https://app.kilo.ai/device-auth?code=FAKE-KC-CODE", interval: 3, expires_in: 600 });
    expect(up.calls[0]!.url).toBe(CODES_URL);
    expect(up.calls[0]!.method).toBe("POST");
    expect(up.calls[0]!.headers.get("content-type")).toBe("application/json");
  });

  it("too many pending sign-ins is said plainly", async () => {
    const up = kilo({ start: () => json({ error: "rate limited" }, 429) });
    const r = await adminCall(up, "POST", "/oauth/kilocode/start");
    expect(r.res.status).toBe(502);
    expect(JSON.parse(r.text).message).toContain("too many");
  });

  it("answers 202 while Kilo answers 202", async () => {
    const up = kilo({ poll: () => new Response(null, { status: 202 }) });
    const d = await startDevice(up);
    const r = await adminCall(up, "POST", "/oauth/kilocode/poll", { id: d.id });
    expect(r.res.status).toBe(202);
    expect(JSON.parse(r.text)).toMatchObject({ status: "pending", interval: 3 });
    expect(up.calls[1]!.url).toBe(POLL_URL);
    expect(up.calls[1]!.method).toBe("GET");
  });

  it("a denied or expired code ends the sign-in", async () => {
    for (const [status, says] of [[403, "denied"], [410, "expired"]] as const) {
      const up = kilo({ poll: () => new Response(null, { status }) });
      const d = await startDevice(up);
      const r = await adminCall(up, "POST", "/oauth/kilocode/poll", { id: d.id });
      expect(r.res.status).toBe(502);
      expect(JSON.parse(r.text).message).toContain(says);
      expect((await adminCall(up, "POST", "/oauth/kilocode/poll", { id: d.id })).res.status).toBe(400);
    }
  });

  it("once approved, stores the token sealed, the organization as the account, and names it after the email", async () => {
    const up = kilo();
    const connection = await signIn(up);
    expect(up.calls.map((r) => r.url)).toEqual([CODES_URL, POLL_URL, PROFILE_URL]);
    expect(up.calls[2]!.headers.get("authorization")).toBe("Bearer fake-kilo-token-1");
    expect(connection).toMatchObject({ provider: "kilocode", auth_type: "oauth", name: "dev@example.com", account: "fake-org-1" });
    expect(JSON.stringify(connection)).not.toContain("fake-kilo-token");
    const row = await env.DB.prepare("SELECT * FROM connection WHERE id = ?").bind(connection.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain("fake-kilo-token");
  });

  it("signing in again as the same person replaces the token", async () => {
    const first = await signIn();
    const again = await signIn(kilo({ poll: () => json({ status: "approved", token: "fake-kilo-token-2", userEmail: "dev@example.com" }) }));
    expect(again.id).toBe(first.id);
  });
});

describe("requests through a Kilo Code account", () => {
  it("sends chat completions to Kilo's OpenRouter endpoint with the token and the organization", async () => {
    const token = await system();
    await signIn();
    const up = kilo();
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: `kilocode/${MODEL}`, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status, text).toBe(200);
    const sent = up.calls[0]!;
    expect(sent.url).toBe(CHAT_URL);
    expect(sent.headers.get("authorization")).toBe("Bearer fake-kilo-token-1");
    expect(sent.headers.get("x-kilocode-organizationid")).toBe("fake-org-1");
    expect(JSON.parse(up.bodies[0]!)).toMatchObject({ model: MODEL });
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "kilocode", model: MODEL, status: 200 })]);
  });

  it("a personal account (no organization) sends no organization header; the `kc/` prefix reaches it", async () => {
    const token = await system();
    await signIn(kilo({ profile: () => json({ email: "dev@example.com", organizations: [] }) }));
    const up = kilo();
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: `kc/${MODEL}`, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.headers.has("x-kilocode-organizationid")).toBe(false);
  });

  it("a refused token says to sign in again, without the token in the answer", async () => {
    const token = await system();
    await signIn();
    const up = kilo({ chat: () => json({ error: { message: "invalid token" } }, 401), profile: () => json({ error: "unauthorized" }, 401) });
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: `kilocode/${MODEL}`, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(401);
    expect(JSON.parse(text).error.message).toMatch(/^sign in again/);
    expect(text).not.toContain("fake-kilo-token");
  });

  it("the console's test checks the token against the profile", async () => {
    const connection = await signIn();
    const ok = await adminCall(kilo(), "POST", `/connections/${connection.id}/test`);
    expect(ok.res.status, ok.text).toBe(200);
    const bad = await adminCall(kilo({ profile: () => json({ error: "unauthorized" }, 401) }), "POST", `/connections/${connection.id}/test`);
    expect(JSON.parse(bad.text)).toMatchObject({ ok: false });
  });
});
