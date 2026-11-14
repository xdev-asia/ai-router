import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, sse, usageRows, type FakeUpstream } from "./helpers";

// Every token and key here is a made-up value: nothing in this file reaches a real service.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DEVICE_URL = "https://auth.meta.com/oidc/device/authorization/";
const TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const KEY_URL = "https://api.meta.ai/muse-code/key";
const RESPONSES_URL = "https://api.meta.ai/v1/responses";
const CLIENT = "1031625952748946";
const KEY = { api_key: "fake-muse-model-key", user_email: " Someone@Example.COM ", is_subs_active: true, subs_tier_name: "pro" };
const COMPLETED = { type: "response.completed", response: { id: "resp_1", model: "muse-spark-1.3", usage: { input_tokens: 12, output_tokens: 2 } } };
const HELLO = [{ type: "response.created", response: { id: "resp_1" } }, { type: "response.output_text.delta", delta: "Hel" }, { type: "response.output_text.delta", delta: "lo" }, COMPLETED];

/** Meta as the sign-in sees it: the device code, the token poll, the Muse Code key mint and the Responses API. */
function muse(opts: { key?: () => Response; token?: () => Response } = {}): FakeUpstream {
  return fakeUpstream(async (req) => {
    if (req.url === DEVICE_URL) return json({ device_code: "fake-device-code", user_code: "MUSE1234", verification_uri: "https://auth.meta.com/device", expires_in: 600, interval: 5 });
    if (req.url === TOKEN_URL) return opts.token ? opts.token() : json({ access_token: "fake-meta-at", token_type: "Bearer", expires_in: 3600 });
    if (req.url === KEY_URL) return opts.key ? opts.key() : json(KEY);
    if (req.url === RESPONSES_URL) return new Response(sse(HELLO), { headers: { "content-type": "text/event-stream" } });
    return json({ message: "unexpected" }, 404);
  });
}

const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function poll(up: FakeUpstream) {
  const s = await adminCall(up, "POST", "/oauth/muse/start");
  expect(s.res.status, s.text).toBe(200);
  return adminCall(up, "POST", "/oauth/muse/poll", { id: JSON.parse(s.text).id });
}

beforeEach(reset);

describe("Muse Code sign-in (Meta device code, then a Model API key)", () => {
  it("asks for a device code with Muse Code's client id and API version", async () => {
    const up = muse();
    const s = await adminCall(up, "POST", "/oauth/muse/start");
    expect(JSON.parse(s.text)).toMatchObject({ flow: "device", user_code: "MUSE1234", verification_uri: "https://auth.meta.com/device" });
    expect(Object.fromEntries(new URLSearchParams(up.bodies[0]!))).toEqual({ client_id: CLIENT });
    expect(up.calls[0]!.headers.get("x-api-version")).toBe("1.0.0");
  });

  it("mints the subscription key with the Meta token and stores only the key, sealed", async () => {
    const up = muse();
    const r = await poll(up);
    expect(r.res.status, r.text).toBe(201);
    expect(up.calls.map((c) => c.url)).toEqual([DEVICE_URL, TOKEN_URL, KEY_URL]);
    expect(up.calls[2]!.headers.get("authorization")).toBe("Bearer fake-meta-at");
    expect(up.calls[2]!.headers.get("x-api-version")).toBe("1.0.0");
    expect(JSON.parse(up.bodies[2]!)).toEqual({ onboard: true });
    const connection = JSON.parse(r.text);
    // No expiry and no refresh: a dead key means signing in again.
    expect(connection).toMatchObject({ provider: "muse", auth_type: "oauth", name: "someone@example.com", expires_at: null });
    const row = await env.DB.prepare("SELECT * FROM connection WHERE id = ?").bind(connection.id).first<Record<string, unknown>>();
    expect(r.text + JSON.stringify(row)).not.toMatch(/fake-/);
  });

  it("an inactive subscription ends the sign-in with Meta's reason and stores nothing", async () => {
    const up = muse({ key: () => json({ ...KEY, api_key: undefined, is_subs_active: false }) });
    const r = await poll(up);
    expect(r.res.status).toBe(502);
    expect(JSON.parse(r.text)).toMatchObject({ error: "provider_refused", message: expect.stringMatching(/subscription is inactive/) });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM connection").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("chat to a Muse Spark model goes to Meta's Responses API with the key and the API version", async () => {
    await poll(muse());
    const token = await addSystem("chat");
    await env.DB.prepare("UPDATE system SET allowed_models = '[\"muse/*\"]' WHERE id = 'chat'").run();
    const up = muse();
    const { res, text } = await call(up, "/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "muse/muse-spark-1.3", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text).choices[0].message.content).toBe("Hello");
    expect(up.calls[0]!.url).toBe(RESPONSES_URL);
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer fake-muse-model-key");
    expect(up.calls[0]!.headers.get("x-api-version")).toBe("1.0.0");
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "muse", status: 200 })]);
  });
});
