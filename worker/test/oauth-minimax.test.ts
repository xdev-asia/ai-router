import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

// Every token here is a made-up value: nothing in this file reaches a real service.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const now = () => Math.floor(Date.now() / 1000);
const MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "MiniMax-M3", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 2 } };

async function s256(verifier: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const SITES = [
  { provider: "minimax-code", account: "https://account.minimax.cn", llm: "https://agent.minimax.cn/mavis/api/v1/llm/v1/messages" },
  { provider: "minimax-code-global", account: "https://account.minimax.io", llm: "https://agent.minimax.io/mavis/api/v1/llm/v1/messages" },
] as const;

describe.each(SITES)("MiniMax Code sign-in ($provider): device code with PKCE", ({ provider, account, llm }) => {
  const DEVICE_URL = `${account}/oauth2/device/code`;
  const TOKEN_URL = `${account}/oauth2/token`;
  const STANDARD = { device_code: "fake-device-code", user_code: "MMX-1234", verification_uri: `${account}/device`, verification_uri_complete: `${account}/device?code=MMX-1234`, expires_in: 600, interval: 5 };

  /** MiniMax's account host (device code, token poll, refresh) and its agent gateway. */
  function minimax(opts: { device?: Record<string, unknown>; token?: (body: URLSearchParams, n: number) => Response } = {}): FakeUpstream {
    let polls = 0;
    return fakeUpstream(async (req) => {
      if (req.url === DEVICE_URL) return json(opts.device ?? STANDARD);
      if (req.url === TOKEN_URL) {
        const body = new URLSearchParams(await req.clone().text());
        if (opts.token) return opts.token(body, ++polls);
        return json({ access_token: "fake-mm-at-1", refresh_token: "fake-mm-rt-1", expires_in: 3600, token_type: "Bearer" });
      }
      if (req.url === llm) return json(MESSAGE);
      return json({ message: "unexpected" }, 404);
    });
  }

  const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
    call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const start = (up: FakeUpstream) => adminCall(up, "POST", `/oauth/${provider}/start`);
  const poll = (up: FakeUpstream, id: string) => adminCall(up, "POST", `/oauth/${provider}/poll`, { id });

  async function signIn(): Promise<Record<string, unknown>> {
    const up = minimax();
    const s = await start(up);
    expect(s.res.status, s.text).toBe(200);
    const r = await poll(up, JSON.parse(s.text).id);
    expect(r.res.status, r.text).toBe(201);
    return JSON.parse(r.text);
  }

  const chat = (token: string) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: `${provider}/MiniMax-M3`, messages: [{ role: "user", content: "hi" }] }) });
  async function system(): Promise<string> {
    const token = await addSystem("chat");
    await env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = 'chat'").bind(JSON.stringify([`${provider}/*`])).run();
    return token;
  }

  beforeEach(reset);

  it("asks for a device code with MiniMax Code's client, audience and a PKCE challenge, then polls with the verifier", async () => {
    const up = minimax({ token: (_b, n) => (n === 1 ? json({ status: "pending" }) : json({ access_token: "fake-mm-at-1", refresh_token: "fake-mm-rt-1", expires_in: 3600 })) });
    const s = await start(up);
    expect(s.res.status, s.text).toBe(200);
    expect(JSON.parse(s.text)).toMatchObject({ flow: "device", user_code: "MMX-1234", verification_uri: `${account}/device?code=MMX-1234`, interval: 5 });
    expect(s.text).not.toMatch(/fake-device-code|verifier/);
    const asked = Object.fromEntries(new URLSearchParams(up.bodies[0]!));
    expect(asked).toMatchObject({ client_id: "mcode-public", scope: "agent.default", audience: "agent-backend", code_challenge_method: "S256" });

    const id = JSON.parse(s.text).id;
    const p1 = await poll(up, id);
    expect(JSON.parse(p1.text)).toMatchObject({ status: "pending" });
    const p2 = await poll(up, id);
    expect(p2.res.status, p2.text).toBe(201);
    const polled = Object.fromEntries(new URLSearchParams(up.bodies[1]!));
    expect(polled).toMatchObject({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "fake-device-code", client_id: "mcode-public" });
    expect(await s256(polled.code_verifier!)).toBe(asked.code_challenge);
  });

  it("polls with the user code when MiniMax sends no device code (its interval then in milliseconds)", async () => {
    const up = minimax({ device: { user_code: "MMX-5678", verification_uri: `${account}/device`, expired_in: 600, interval: 5000 } });
    const s = await start(up);
    expect(s.res.status, s.text).toBe(200);
    expect(JSON.parse(s.text)).toMatchObject({ user_code: "MMX-5678", interval: 5, expires_in: 600 });
    const r = await poll(up, JSON.parse(s.text).id);
    expect(r.res.status, r.text).toBe(201);
    const polled = Object.fromEntries(new URLSearchParams(up.bodies[1]!));
    expect(polled.user_code).toBe("MMX-5678");
    expect(polled.device_code).toBeUndefined();
  });

  it("a denied sign-in ends it", async () => {
    const up = minimax({ token: () => json({ status: "denied" }) });
    const s = await start(up);
    const r = await poll(up, JSON.parse(s.text).id);
    expect(r.res.status).toBe(502);
    expect(JSON.parse(r.text)).toMatchObject({ error: "provider_refused", message: expect.stringMatching(/denied/) });
    const again = await poll(up, JSON.parse(s.text).id);
    expect(again.res.status).toBe(400);
  });

  it("stores the tokens sealed; neither the answer nor the row holds them", async () => {
    const connection = await signIn();
    expect(connection).toMatchObject({ provider, auth_type: "oauth", name: "MiniMax Code account" });
    const row = await env.DB.prepare("SELECT * FROM connection WHERE id = ?").bind(connection.id).first<Record<string, unknown>>();
    expect(JSON.stringify(connection) + JSON.stringify(row)).not.toMatch(/fake-/);
  });

  it("chat goes to MiniMax's agent gateway as Anthropic messages, with the bearer and MiniMax Code's headers", async () => {
    const token = await system();
    await signIn();
    const up = minimax();
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text).choices[0].message.content).toBe("Hello");
    const sent = up.calls[0]!;
    expect(sent.url).toBe(llm);
    expect(sent.headers.get("authorization")).toBe("Bearer fake-mm-at-1");
    expect(sent.headers.get("anthropic-version")).toBeTruthy();
    expect(sent.headers.get("anthropic-beta")).toBeNull();
    expect(sent.headers.get("user-agent")).toBe("MiniMaxAgent");
    expect(sent.headers.get("x-mavis-agent-id")).toBe("main");
    expect(sent.headers.get("x-mavis-session-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(up.bodies[0]!)).toMatchObject({ model: "MiniMax-M3" });
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider, status: 200 })]);
  });

  it("renews a token about to expire with MiniMax's refresh grant", async () => {
    const token = await system();
    const connection = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() + 60, connection.id).run();
    const up = minimax({ token: () => json({ access_token: "fake-mm-at-2", refresh_token: "fake-mm-rt-2", expires_in: 3600 }) });
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token));
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => r.url)).toEqual([TOKEN_URL, llm]);
    expect(Object.fromEntries(new URLSearchParams(up.bodies[0]!))).toEqual({ grant_type: "refresh_token", refresh_token: "fake-mm-rt-1", client_id: "mcode-public", scope: "agent.default", audience: "agent-backend" });
    expect(up.calls[1]!.headers.get("authorization")).toBe("Bearer fake-mm-at-2");
  });

  it("a spent refresh token says to sign in again, without a token in the answer", async () => {
    const token = await system();
    const connection = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() - 10, connection.id).run();
    const up = minimax({ token: () => json({ error: "invalid_grant", error_description: "refresh token already used" }, 400) });
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token));
    expect(res.status).toBe(401);
    expect(JSON.parse(text).error.message).toBe("sign in again: refresh token already used");
    expect(text).not.toMatch(/fake-/);
  });
});
