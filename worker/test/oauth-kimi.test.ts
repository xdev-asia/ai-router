import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

// Every token here is a made-up value: nothing in this file reaches a real service.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const now = () => Math.floor(Date.now() / 1000);
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fakeJwt = (claims: Record<string, unknown>) => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(claims))}.fake-signature`;

const DEVICE_URL = "https://auth.kimi.com/api/oauth/device_authorization";
const TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const CHAT_URL = "https://api.kimi.com/coding/v1/chat/completions";
const CLIENT = "17e5f671-d194-4dfb-9706-5516cb48c098";
const ACCESS_1 = fakeJwt({ sub: "fake-kimi-user-1", exp: 0 });
const COMPLETION = { id: "c1", object: "chat.completion", model: "kimi-for-coding", choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } };

/** Kimi as the sign-in sees it: the device code, the token endpoint (poll and refresh) and chat. */
function kimi(opts: { device?: unknown; token?: (body: URLSearchParams) => Response; chat?: (n: number) => Response } = {}): FakeUpstream {
  let chats = 0;
  return fakeUpstream(async (req) => {
    if (req.url === DEVICE_URL) return json(opts.device ?? { device_code: "fake-device-code", user_code: "KIMI-1234", verification_uri: "https://www.kimi.com/code/authorize_device", expires_in: 1800, interval: 5 });
    if (req.url === TOKEN_URL) {
      const body = new URLSearchParams(await req.clone().text());
      if (opts.token) return opts.token(body);
      return json({ access_token: ACCESS_1, refresh_token: "fake-kimi-rt-1", expires_in: 3600, token_type: "Bearer" });
    }
    if (req.url === CHAT_URL) return opts.chat ? opts.chat(++chats) : json(COMPLETION);
    return json({ message: "unexpected" }, 404);
  });
}

const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function startDevice(up: FakeUpstream): Promise<{ id: string; user_code: string; verification_uri: string; verification_uri_complete?: string; interval: number }> {
  const r = await adminCall(up, "POST", "/oauth/kimi/start");
  expect(r.res.status, r.text).toBe(200);
  return JSON.parse(r.text);
}

async function signIn(up = kimi()): Promise<Record<string, unknown>> {
  const d = await startDevice(up);
  const r = await adminCall(up, "POST", "/oauth/kimi/poll", { id: d.id });
  expect(r.res.status, r.text).toBe(201);
  return JSON.parse(r.text);
}

const chat = (token: string, body: unknown) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
async function system(): Promise<string> {
  const token = await addSystem("chat");
  await env.DB.prepare("UPDATE system SET allowed_models = '[\"kimi/*\"]' WHERE id = 'chat'").run();
  return token;
}

beforeEach(reset);

describe("Kimi Code sign-in (device code)", () => {
  it("asks for a device code with the client id only and the Kimi device headers", async () => {
    const up = kimi();
    const d = await startDevice(up);
    expect(d).toMatchObject({ flow: "device", user_code: "KIMI-1234", verification_uri: "https://www.kimi.com/code/authorize_device", interval: 5 });
    expect(JSON.stringify(d)).not.toContain("fake-device-code");
    expect(up.calls[0]!.url).toBe(DEVICE_URL);
    expect(Object.fromEntries(new URLSearchParams(up.bodies[0]!))).toEqual({ client_id: CLIENT });
    expect(up.calls[0]!.headers.get("x-msh-device-id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(up.calls[0]!.headers.get("x-msh-platform")).toBeTruthy();
  });

  it("falls back to Kimi's authorize page when the answer names none", async () => {
    const up = kimi({ device: { device_code: "fake-device-code", user_code: "KIMI-5678" } });
    const d = await startDevice(up);
    expect(d.verification_uri).toBe("https://www.kimi.com/code/authorize_device");
    expect(d.verification_uri_complete).toBe("https://www.kimi.com/code/authorize_device?user_code=KIMI-5678");
    expect(d.interval).toBe(5);
  });

  it("answers 202 while Kimi says the sign-in is pending (a 200 carrying an error)", async () => {
    const up = kimi({ token: () => json({ error: "authorization_pending" }) });
    const d = await startDevice(up);
    const r = await adminCall(up, "POST", "/oauth/kimi/poll", { id: d.id });
    expect(r.res.status).toBe(202);
    expect(Object.fromEntries(new URLSearchParams(up.bodies[1]!))).toEqual({ client_id: CLIENT, device_code: "fake-device-code", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    // The same device id on every call: Kimi ties the sign-in to the device.
    expect(up.calls[1]!.headers.get("x-msh-device-id")).toBe(up.calls[0]!.headers.get("x-msh-device-id"));
  });

  it("stores the tokens sealed and answers nothing secret", async () => {
    const up = kimi();
    const connection = await signIn(up);
    expect(connection).toMatchObject({ provider: "kimi", auth_type: "oauth", name: "Kimi account" });
    expect(Number(connection.expires_at)).toBeGreaterThan(now() + 3000);
    // The user id (subject) may show; no token or device code may.
    const secret = /fake-kimi-rt|fake-device-code|eyJ/;
    expect(JSON.stringify(connection)).not.toMatch(secret);
    const row = await env.DB.prepare("SELECT * FROM connection WHERE id = ?").bind(connection.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toMatch(secret);
  });

  it("signing in again as the same Kimi user replaces the tokens", async () => {
    const first = await signIn();
    const again = await signIn();
    expect(again.id).toBe(first.id);
  });
});

describe("requests through a Kimi Code subscription", () => {
  it("sends chat completions to Kimi Code with the token and the same device headers", async () => {
    const token = await system();
    const signUp = kimi();
    await signIn(signUp);
    const up = kimi();
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "kimi/kimi-for-coding", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status, text).toBe(200);
    const sent = up.calls[0]!;
    expect(sent.url).toBe(CHAT_URL);
    expect(sent.headers.get("authorization")).toBe(`Bearer ${ACCESS_1}`);
    expect(sent.headers.get("x-msh-device-id")).toBe(signUp.calls[0]!.headers.get("x-msh-device-id"));
    expect(JSON.parse(up.bodies[0]!)).toMatchObject({ model: "kimi-for-coding" });
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "kimi", model: "kimi-for-coding", status: 200 })]);
  });

  it("renews a token about to expire with a form refresh grant carrying the device headers", async () => {
    const token = await system();
    const connection = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() + 30, connection.id).run();
    const up = kimi({ token: () => json({ access_token: "fake-kimi-at-2", refresh_token: "fake-kimi-rt-2", expires_in: 3600 }) });
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "kimi/kimi-for-coding", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => r.url)).toEqual([TOKEN_URL, CHAT_URL]);
    expect(up.calls[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(up.bodies[0]!))).toEqual({ client_id: CLIENT, grant_type: "refresh_token", refresh_token: "fake-kimi-rt-1" });
    expect(up.calls[0]!.headers.get("x-msh-device-id")).toBe(up.calls[1]!.headers.get("x-msh-device-id"));
    expect(up.calls[1]!.headers.get("authorization")).toBe("Bearer fake-kimi-at-2");
  });

  it("a refused renewal says to sign in again, without a token in the answer", async () => {
    const token = await system();
    const connection = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() - 10, connection.id).run();
    const up = kimi({ token: () => json({ error: "invalid_grant", error_description: "refresh token revoked" }, 400) });
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "kimi/kimi-for-coding", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(401);
    expect(JSON.parse(text).error.message).toBe("sign in again: refresh token revoked");
    expect(text).not.toMatch(/fake-|eyJ/);
  });
});
