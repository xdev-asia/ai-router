import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

// Every token here is a made-up value: nothing in this file reaches a real service.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const now = () => Math.floor(Date.now() / 1000);
const DEVICE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_URL = "https://api.github.com/copilot_internal/v2/token";
const USER_URL = "https://api.github.com/user";
const CHAT_URL = "https://api.githubcopilot.com/chat/completions";
const CLIENT = "Iv1.b507a08c87ecfe98";
const DEVICE = { device_code: "fake-device-code", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };
const COMPLETION = { id: "c1", object: "chat.completion", model: "gpt-5-mini", choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } };

/** GitHub as the sign-in sees it: the device code, the poll, the Copilot token and the user. */
function github(opts: { poll?: () => Response; copilot?: (n: number) => Response; chat?: (n: number) => Response; user?: unknown } = {}): FakeUpstream {
  let copilots = 0;
  let chats = 0;
  return fakeUpstream((req) => {
    if (req.url === DEVICE_URL) return json(DEVICE);
    if (req.url === TOKEN_URL) return opts.poll ? opts.poll() : json({ access_token: "fake-gh-at-1", token_type: "bearer", scope: "read:user" });
    if (req.url === COPILOT_URL) return opts.copilot ? opts.copilot(++copilots) : json({ token: `fake-copilot-${++copilots}`, expires_at: now() + 1500 });
    if (req.url === USER_URL) return json(opts.user ?? { id: 42, login: "octo", name: "Octo Cat", email: "octo@example.com" });
    if (req.url === CHAT_URL) return opts.chat ? opts.chat(++chats) : json(COMPLETION);
    return json({ message: "unexpected" }, 404);
  });
}

const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function startDevice(up: FakeUpstream): Promise<{ id: string; user_code: string; verification_uri: string; interval: number }> {
  const r = await adminCall(up, "POST", "/oauth/github/start");
  expect(r.res.status, r.text).toBe(200);
  return JSON.parse(r.text);
}

async function signIn(up = github()): Promise<Record<string, unknown>> {
  const d = await startDevice(up);
  const r = await adminCall(up, "POST", "/oauth/github/poll", { id: d.id });
  expect(r.res.status, r.text).toBe(201);
  return JSON.parse(r.text);
}

const chat = (token: string, body: unknown) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
async function system(): Promise<string> {
  const token = await addSystem("chat");
  await env.DB.prepare("UPDATE system SET allowed_models = '[\"github/*\"]' WHERE id = 'chat'").run();
  return token;
}

beforeEach(reset);

describe("GitHub Copilot sign-in (device code)", () => {
  it("asks GitHub for a device code and shows the user code and page, never the device code", async () => {
    const up = github();
    const d = await startDevice(up);
    expect(d).toMatchObject({ flow: "device", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5 });
    expect(typeof d.id).toBe("string");
    expect(JSON.stringify(d)).not.toContain("fake-device-code");
    expect(up.calls[0]!.url).toBe(DEVICE_URL);
    expect(Object.fromEntries(new URLSearchParams(up.bodies[0]!))).toEqual({ client_id: CLIENT, scope: "read:user" });
    expect(up.calls[0]!.headers.get("accept")).toBe("application/json");
  });

  it("answers 202 while the user has not entered the code, and passes on a slower interval", async () => {
    let answer = json({ error: "authorization_pending" });
    const up = github({ poll: () => answer });
    const d = await startDevice(up);
    const pending = await adminCall(up, "POST", "/oauth/github/poll", { id: d.id });
    expect(pending.res.status).toBe(202);
    expect(JSON.parse(pending.text)).toMatchObject({ status: "pending", interval: 5 });
    expect(Object.fromEntries(new URLSearchParams(up.bodies[1]!))).toEqual({ client_id: CLIENT, device_code: "fake-device-code", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    answer = json({ error: "slow_down", interval: 10 });
    const slower = await adminCall(up, "POST", "/oauth/github/poll", { id: d.id });
    expect(slower.res.status).toBe(202);
    expect(JSON.parse(slower.text)).toMatchObject({ status: "pending", interval: 10 });
  });

  it("an expired or denied code ends the sign-in", async () => {
    const up = github({ poll: () => json({ error: "access_denied", error_description: "The user has denied your application access." }) });
    const d = await startDevice(up);
    const r = await adminCall(up, "POST", "/oauth/github/poll", { id: d.id });
    expect(r.res.status).toBe(502);
    expect(JSON.parse(r.text)).toMatchObject({ error: "provider_refused", message: "The user has denied your application access." });
    const again = await adminCall(up, "POST", "/oauth/github/poll", { id: d.id });
    expect(again.res.status).toBe(400);
  });

  it("an unknown sign-in id is refused without asking GitHub", async () => {
    const up = github();
    const r = await adminCall(up, "POST", "/oauth/github/poll", { id: "nope" });
    expect(r.res.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });

  it("once authorized, gets a Copilot token, names the connection after the user, and stores both tokens sealed", async () => {
    const up = github();
    const connection = await signIn(up);
    expect(up.calls.map((r) => r.url)).toEqual([DEVICE_URL, TOKEN_URL, COPILOT_URL, USER_URL]);
    expect(up.calls[2]!.headers.get("authorization")).toBe("token fake-gh-at-1");
    expect(connection).toMatchObject({ provider: "github", auth_type: "oauth", name: "octo@example.com", account: "42", priority: 1 });
    expect(Number(connection.expires_at)).toBeGreaterThan(now() + 1000);
    expect(JSON.stringify(connection)).not.toMatch(/fake-/);
    const row = await env.DB.prepare("SELECT * FROM connection WHERE id = ?").bind(connection.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toMatch(/fake-/);
  });

  it("a finished sign-in cannot be polled again", async () => {
    const up = github();
    const d = await startDevice(up);
    expect((await adminCall(up, "POST", "/oauth/github/poll", { id: d.id })).res.status).toBe(201);
    const again = await adminCall(up, "POST", "/oauth/github/poll", { id: d.id });
    expect(again.res.status).toBe(400);
  });

  it("an account without Copilot is refused with GitHub's reason", async () => {
    const up = github({ copilot: () => json({ message: "Resource not accessible by integration" }, 403) });
    const d = await startDevice(up);
    const r = await adminCall(up, "POST", "/oauth/github/poll", { id: d.id });
    expect(r.res.status).toBe(502);
    expect(JSON.parse(r.text).message).toContain("Resource not accessible by integration");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM connection").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("signing in again as the same GitHub user replaces the tokens", async () => {
    const first = await signIn();
    const again = await signIn();
    expect(again.id).toBe(first.id);
    const other = await signIn(github({ user: { id: 7, login: "hubot", name: null, email: null } }));
    expect(other).toMatchObject({ name: "hubot", priority: 2 });
  });
});

describe("requests through a Copilot subscription", () => {
  it("sends chat completions to Copilot with its token and the editor headers it expects", async () => {
    const token = await system();
    await signIn();
    const up = github();
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "github/gpt-5-mini", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status, text).toBe(200);
    const sent = up.calls[0]!;
    expect(sent.url).toBe(CHAT_URL);
    expect(sent.headers.get("authorization")).toBe("Bearer fake-copilot-1");
    expect(sent.headers.get("copilot-integration-id")).toBe("vscode-chat");
    expect(sent.headers.get("editor-version")).toMatch(/^vscode\//);
    expect(JSON.parse(up.bodies[0]!)).toMatchObject({ model: "gpt-5-mini" });
    expect(JSON.parse(text)).toMatchObject({ choices: [{ message: { content: "Hello" } }] });
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "github", model: "gpt-5-mini", status: 200 })]);
  });

  it("the `gh/` prefix reaches the same provider", async () => {
    const token = await system();
    await signIn();
    const up = github();
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "gh/gpt-5-mini", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe(CHAT_URL);
  });

  it("renews a Copilot token about to expire from the stored GitHub token", async () => {
    const token = await system();
    const connection = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() + 30, connection.id).run();
    const up = github({ copilot: () => json({ token: "fake-copilot-new", expires_at: now() + 1500 }) });
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "github/gpt-5-mini", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => r.url)).toEqual([COPILOT_URL, CHAT_URL]);
    expect(up.calls[0]!.headers.get("authorization")).toBe("token fake-gh-at-1");
    expect(up.calls[1]!.headers.get("authorization")).toBe("Bearer fake-copilot-new");
    const row = await env.DB.prepare("SELECT expires_at, secret FROM connection WHERE id = ?").bind(connection.id).first<{ expires_at: number; secret: string }>();
    expect(row!.expires_at).toBeGreaterThan(now() + 1000);
    expect(row!.secret).not.toMatch(/fake-/);
  });

  it("a Copilot token refused before it expired is renewed once and the request sent again", async () => {
    const token = await system();
    await signIn();
    const up = github({
      copilot: () => json({ token: "fake-copilot-new", expires_at: now() + 1500 }),
      chat: (n) => (n === 1 ? json({ error: { message: "token expired" } }, 401) : json(COMPLETION)),
    });
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "github/gpt-5-mini", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => r.url)).toEqual([CHAT_URL, COPILOT_URL, CHAT_URL]);
    expect(up.calls[2]!.headers.get("authorization")).toBe("Bearer fake-copilot-new");
  });

  it("a GitHub token that no longer works says to sign in again", async () => {
    const token = await system();
    const connection = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() - 10, connection.id).run();
    const up = github({ copilot: () => json({ message: "Bad credentials" }, 401) });
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "github/gpt-5-mini", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(401);
    expect(JSON.parse(text).error.message).toBe("sign in again: Bad credentials");
    expect(text).not.toMatch(/fake-/);
  });
});
