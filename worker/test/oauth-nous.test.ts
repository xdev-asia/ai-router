import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

// Every token and key here is a made-up value: nothing in this file reaches a real service.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const now = () => Math.floor(Date.now() / 1000);

const DEVICE_URL = "https://portal.nousresearch.com/api/oauth/device/code";
const TOKEN_URL = "https://portal.nousresearch.com/api/oauth/token";
const AGENT_KEY_URL = "https://portal.nousresearch.com/api/oauth/agent-key";
const CHAT_URL = "https://inference-api.nousresearch.com/v1/chat/completions";
const MODEL = "stepfun/step-3.7-flash:free";
const COMPLETION = { id: "c1", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } };

/** Nous Portal as the sign-in sees it: the device code, the token endpoint (poll and refresh), the agent key and chat. */
function nous(opts: { token?: (body: URLSearchParams) => Response; agentKey?: (n: number) => Response } = {}): FakeUpstream {
  let keys = 0;
  return fakeUpstream(async (req) => {
    if (req.url === DEVICE_URL) return json({ device_code: "fake-device-code", user_code: "NOUS-1234", verification_uri: "https://portal.nousresearch.com/device", verification_uri_complete: "https://portal.nousresearch.com/device?code=NOUS-1234", expires_in: 900, interval: 5 });
    if (req.url === TOKEN_URL) {
      const body = new URLSearchParams(await req.clone().text());
      if (opts.token) return opts.token(body);
      return json({ access_token: "fake-nous-at-1", refresh_token: "fake-nous-rt-1", expires_in: 3600, token_type: "Bearer" });
    }
    if (req.url === AGENT_KEY_URL) {
      keys++;
      if (opts.agentKey) return opts.agentKey(keys);
      return json({ api_key: `fake-nous-agent-key-${keys}`, key_id: `key-${keys}`, expires_in: 7200 });
    }
    if (req.url === CHAT_URL) return json(COMPLETION);
    return json({ message: "unexpected" }, 404);
  });
}

const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function signIn(up = nous()): Promise<Record<string, unknown>> {
  const s = await adminCall(up, "POST", "/oauth/nous/start");
  expect(s.res.status, s.text).toBe(200);
  const r = await adminCall(up, "POST", "/oauth/nous/poll", { id: JSON.parse(s.text).id });
  expect(r.res.status, r.text).toBe(201);
  return JSON.parse(r.text);
}

const chat = (token: string) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: `nous/${MODEL}`, messages: [{ role: "user", content: "hi" }] }) });
async function system(): Promise<string> {
  const token = await addSystem("chat");
  await env.DB.prepare("UPDATE system SET allowed_models = '[\"nous/*\"]' WHERE id = 'chat'").run();
  return token;
}

beforeEach(reset);

describe("Nous Portal sign-in (device code, then an agent key)", () => {
  it("asks for a device code with the Hermes CLI client and its scopes", async () => {
    const up = nous();
    const s = await adminCall(up, "POST", "/oauth/nous/start");
    expect(s.res.status).toBe(200);
    expect(JSON.parse(s.text)).toMatchObject({ flow: "device", user_code: "NOUS-1234", verification_uri_complete: "https://portal.nousresearch.com/device?code=NOUS-1234" });
    expect(s.text).not.toContain("fake-device-code");
    expect(Object.fromEntries(new URLSearchParams(up.bodies[0]!))).toEqual({ client_id: "hermes-cli", scope: "inference:invoke inference:mint_agent_key" });
  });

  it("mints an agent key with the access token and stores it sealed; the answer holds nothing secret", async () => {
    const up = nous();
    const connection = await signIn(up);
    expect(up.calls.map((r) => r.url)).toEqual([DEVICE_URL, TOKEN_URL, AGENT_KEY_URL]);
    expect(up.calls[2]!.headers.get("authorization")).toBe("Bearer fake-nous-at-1");
    expect(JSON.parse(up.bodies[2]!)).toEqual({ min_ttl_seconds: 7200 });
    expect(connection).toMatchObject({ provider: "nous", auth_type: "oauth", name: "Nous account" });
    // The agent key's lifetime, not the access token's.
    expect(Number(connection.expires_at)).toBeGreaterThan(now() + 7000);
    const row = await env.DB.prepare("SELECT * FROM connection WHERE id = ?").bind(connection.id).first<Record<string, unknown>>();
    expect(JSON.stringify(connection) + JSON.stringify(row)).not.toMatch(/fake-nous|fake-device-code/);
  });

  it("chat goes to Nous inference with the agent key", async () => {
    const token = await system();
    await signIn();
    const up = nous();
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token));
    expect(res.status, text).toBe(200);
    expect(up.calls[0]!.url).toBe(CHAT_URL);
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer fake-nous-agent-key-1");
    expect(JSON.parse(up.bodies[0]!)).toMatchObject({ model: MODEL });
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "nous", model: MODEL, status: 200 })]);
  });

  it("uses the access token when no agent key can be minted, as Nous's own client does", async () => {
    const token = await system();
    await signIn(nous({ agentKey: () => json({ error: "forbidden" }, 403) }));
    const up = nous();
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer fake-nous-at-1");
  });

  it("renews an agent key about to expire: a refresh grant, then a new agent key", async () => {
    const token = await system();
    const connection = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() + 30, connection.id).run();
    const up = nous({ token: () => json({ access_token: "fake-nous-at-2", refresh_token: "fake-nous-rt-2", expires_in: 3600 }) });
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token));
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => r.url)).toEqual([TOKEN_URL, AGENT_KEY_URL, CHAT_URL]);
    expect(Object.fromEntries(new URLSearchParams(up.bodies[0]!))).toEqual({ grant_type: "refresh_token", refresh_token: "fake-nous-rt-1", client_id: "hermes-cli" });
    expect(up.calls[0]!.headers.get("x-nous-refresh-token")).toBe("fake-nous-rt-1");
    expect(up.calls[1]!.headers.get("authorization")).toBe("Bearer fake-nous-at-2");
    expect(up.calls[2]!.headers.get("authorization")).toBe("Bearer fake-nous-agent-key-1");
  });

  it("a refused renewal says to sign in again, without a token in the answer", async () => {
    const token = await system();
    const connection = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() - 10, connection.id).run();
    const up = nous({ token: () => json({ error: "invalid_grant", error_description: "refresh token revoked" }, 400) });
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token));
    expect(res.status).toBe(401);
    expect(JSON.parse(text).error.message).toBe("sign in again: refresh token revoked");
    expect(text).not.toMatch(/fake-/);
  });
});
