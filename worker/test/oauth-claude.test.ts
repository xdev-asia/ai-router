import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, messagesInit, reset, usageRows, type FakeUpstream } from "./helpers";

// Every token here is a made-up value: nothing in this file reaches a real service.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const now = () => Math.floor(Date.now() / 1000);
/** A token answer shaped like Anthropic's: the account and organization travel beside the tokens. */
const tokens = (n: number, email = "dev@example.com", account = "acct-1", org = "org-1") => ({
  access_token: `fake-claude-at-${n}`,
  refresh_token: `fake-claude-rt-${n}`,
  expires_in: 28800,
  token_type: "Bearer",
  account: { uuid: account, email_address: email },
  organization: { uuid: org, name: "Fake Org" },
});
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 3 } };

const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function start(up: FakeUpstream): Promise<URL> {
  const r = await adminCall(up, "POST", "/oauth/claude/start");
  expect(r.res.status, r.text).toBe(200);
  return new URL((JSON.parse(r.text) as { authorize_url: string }).authorize_url);
}

async function signIn(grant: unknown = tokens(1)): Promise<{ connection: Record<string, unknown>; up: FakeUpstream; authorize: URL }> {
  const up = fakeUpstream(() => json(grant));
  const authorize = await start(up);
  const finished = await adminCall(up, "POST", "/oauth/claude/finish", { callback_url: `http://localhost:54545/callback?code=the-code&state=${authorize.searchParams.get("state")}` });
  expect(finished.res.status, finished.text).toBe(201);
  return { connection: JSON.parse(finished.text), up, authorize };
}

const chat = (token: string, body: unknown) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
async function system(): Promise<string> {
  const token = await addSystem("chat");
  await env.DB.prepare("UPDATE system SET allowed_models = '[\"claude/*\"]' WHERE id = 'chat'").run();
  return token;
}

beforeEach(reset);

describe("Claude Code sign-in", () => {
  it("starts at claude.ai with PKCE, the Claude Code client, and a local callback whose address the user pastes", async () => {
    const up = fakeUpstream(() => json({}));
    const r = await adminCall(up, "POST", "/oauth/claude/start");
    expect(JSON.parse(r.text)).toMatchObject({ flow: "pkce" });
    const u = await start(up);
    expect(u.origin + u.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      code: "true",
      response_type: "code",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      redirect_uri: "http://localhost:54545/callback",
      scope: "org:create_api_key user:profile user:inference",
      code_challenge_method: "S256",
    });
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(up.calls).toHaveLength(0);
  });

  it("trades the code as JSON with the state and verifier, and stores the account sealed under its email", async () => {
    const { connection, up, authorize } = await signIn();
    const sent = up.calls[0]!;
    expect(sent.url).toBe(TOKEN_URL);
    expect(sent.headers.get("content-type")).toContain("application/json");
    const body = JSON.parse(up.bodies[0]!) as Record<string, string>;
    expect(body).toMatchObject({ grant_type: "authorization_code", code: "the-code", state: authorize.searchParams.get("state"), client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", redirect_uri: "http://localhost:54545/callback" });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier!)));
    expect(b64url(String.fromCharCode(...digest))).toBe(authorize.searchParams.get("code_challenge"));

    expect(connection).toMatchObject({ provider: "claude", auth_type: "oauth", name: "dev@example.com", account: "org-1", priority: 1 });
    expect(Number(connection.expires_at) - now()).toBeGreaterThan(28000);
    expect(JSON.stringify(connection)).not.toMatch(/fake-claude-/);
    const row = await env.DB.prepare("SELECT * FROM connection WHERE id = ?").bind(connection.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toMatch(/fake-claude-/);
  });

  it("takes the code as Anthropic's page shows it, `code#state`, with no separate state", async () => {
    const up = fakeUpstream(() => json(tokens(1)));
    const authorize = await start(up);
    const r = await adminCall(up, "POST", "/oauth/claude/finish", { code: `pasted-code#${authorize.searchParams.get("state")}` });
    expect(r.res.status, r.text).toBe(201);
    expect(JSON.parse(up.bodies[0]!)).toMatchObject({ code: "pasted-code", state: authorize.searchParams.get("state") });
  });

  it("signing in again as the same person replaces the tokens; another person is a second connection", async () => {
    const first = await signIn(tokens(1));
    const again = await signIn(tokens(2));
    expect(again.connection.id).toBe(first.connection.id);
    const other = await signIn(tokens(3, "b@example.com", "acct-2"));
    expect(other.connection).toMatchObject({ name: "b@example.com", priority: 2 });
  });

  it("a Claude sign-in state cannot finish a Codex sign-in", async () => {
    const up = fakeUpstream(() => json(tokens(1)));
    const authorize = await start(up);
    const r = await adminCall(up, "POST", "/oauth/codex/finish", { code: "c", state: authorize.searchParams.get("state") });
    expect(r.res.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });
});

describe("requests through a Claude subscription", () => {
  it("says to sign in when no account is connected, and never uses the Anthropic API key", async () => {
    const token = await system();
    const up = fakeUpstream(() => json(MESSAGE));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "claude/claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error.message).toBe("not_configured: no claude connection; sign in from the console");
    expect(up.calls).toHaveLength(0);
  });

  it("sends Messages with the access token as a bearer and the OAuth beta, and answers as a chat completion", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => json(MESSAGE));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "claude/claude-sonnet-5", max_tokens: 100, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] }));
    expect(res.status, text).toBe(200);
    const sent = up.calls[0]!;
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent.headers.get("authorization")).toBe("Bearer fake-claude-at-1");
    expect(sent.headers.get("x-api-key")).toBeNull();
    expect(sent.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.parse(up.bodies[0]!)).toMatchObject({ model: "claude-sonnet-5", system: "Be brief.", messages: [{ role: "user" }] });
    expect(JSON.parse(text)).toMatchObject({ object: "chat.completion", choices: [{ message: { role: "assistant", content: "Hello" } }] });
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "claude", model: "claude-sonnet-5", status: 200, output_tokens: 3 })]);
  });

  it("the `cc/` prefix reaches the same provider", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => json(MESSAGE));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "cc/claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("renews a token about to expire with a JSON refresh grant, and keeps the new one", async () => {
    const token = await system();
    const { connection } = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() + 60, connection.id).run();
    const up = fakeUpstream((req) => (req.url === TOKEN_URL ? json({ access_token: "fake-claude-at-2", refresh_token: "fake-claude-rt-2", expires_in: 28800 }) : json(MESSAGE)));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "claude/claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => r.url)).toEqual([TOKEN_URL, "https://api.anthropic.com/v1/messages"]);
    expect(JSON.parse(up.bodies[0]!)).toEqual({ client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", grant_type: "refresh_token", refresh_token: "fake-claude-rt-1" });
    expect(up.calls[1]!.headers.get("authorization")).toBe("Bearer fake-claude-at-2");
    const row = await env.DB.prepare("SELECT expires_at, secret FROM connection WHERE id = ?").bind(connection.id).first<{ expires_at: number; secret: string }>();
    expect(row!.expires_at - now()).toBeGreaterThan(28000);
    expect(row!.secret).not.toMatch(/fake-claude-/);
  });

  it("a token refused before it expired is renewed once and the request sent again", async () => {
    const token = await system();
    await signIn();
    let messages = 0;
    const up = fakeUpstream((req) => {
      if (req.url === TOKEN_URL) return json({ access_token: "fake-claude-at-2", refresh_token: "fake-claude-rt-2", expires_in: 28800 });
      messages += 1;
      return messages === 1 ? json({ type: "error", error: { type: "authentication_error", message: "OAuth token has been revoked" } }, 401) : json(MESSAGE);
    });
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "claude/claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => r.headers.get("authorization") ?? r.url)).toEqual(["Bearer fake-claude-at-1", TOKEN_URL, "Bearer fake-claude-at-2"]);
  });

  it("a refused renewal says to sign in again, and the token is in no answer or error", async () => {
    const token = await system();
    const { connection } = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() - 10, connection.id).run();
    const up = fakeUpstream(() => json({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }, 400));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "claude/claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(401);
    expect(JSON.parse(text).error.message).toBe("sign in again: Refresh token not found or invalid");
    expect(text).not.toMatch(/fake-claude-/);
    const row = await env.DB.prepare("SELECT last_error FROM connection WHERE id = ?").bind(connection.id).first<{ last_error: string }>();
    expect(row!.last_error).not.toMatch(/fake-claude-/);
  });
});

describe("the Anthropic surface with a Claude subscription", () => {
  const MODEL = { model: "claude/claude-sonnet-5", max_tokens: 50, messages: [{ role: "user", content: "hi" }] };

  it("says to sign in when no account is connected", async () => {
    const token = await system();
    const up = fakeUpstream(() => json(MESSAGE));
    const { res, text } = await call(up, "/anthropic/v1/messages", messagesInit(token, MODEL));
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error.message).toBe("not_configured: no connection for claude");
    expect(up.calls).toHaveLength(0);
  });

  it("forwards Messages with the bearer token, the OAuth beta beside the client's, and the model without its prefix", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => json(MESSAGE));
    const { res, text } = await call(up, "/anthropic/v1/messages", messagesInit(token, MODEL, { "anthropic-beta": "fake-beta-2026-01-01" }));
    expect(res.status, text).toBe(200);
    const sent = up.calls[0]!;
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent.headers.get("authorization")).toBe("Bearer fake-claude-at-1");
    expect(sent.headers.get("x-api-key")).toBeNull();
    expect(sent.headers.get("anthropic-beta")!.split(",").map((s) => s.trim())).toEqual(["oauth-2025-04-20", "fake-beta-2026-01-01"]);
    expect(JSON.parse(up.bodies[0]!)).toMatchObject({ model: "claude-sonnet-5" });
    expect(JSON.parse(text)).toMatchObject({ type: "message", content: [{ text: "Hello" }] });
    expect(text).not.toMatch(/fake-claude-/);
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "claude", status: 200, output_tokens: 3 })]);
  });

  it("a token refused before it expired is renewed once and the request sent again", async () => {
    const token = await system();
    await signIn();
    let messages = 0;
    const up = fakeUpstream((req) => {
      if (req.url === TOKEN_URL) return json({ access_token: "fake-claude-at-2", refresh_token: "fake-claude-rt-2", expires_in: 28800 });
      messages += 1;
      return messages === 1 ? json({ type: "error", error: { type: "authentication_error", message: "OAuth token has been revoked" } }, 401) : json(MESSAGE);
    });
    const { res } = await call(up, "/anthropic/v1/messages", messagesInit(token, MODEL));
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => r.headers.get("authorization") ?? r.url)).toEqual(["Bearer fake-claude-at-1", TOKEN_URL, "Bearer fake-claude-at-2"]);
  });

  it("a refused renewal says to sign in again, with no token in the answer", async () => {
    const token = await system();
    const { connection } = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() - 10, connection.id).run();
    const up = fakeUpstream(() => json({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }, 400));
    const { res, text } = await call(up, "/anthropic/v1/messages", messagesInit(token, MODEL));
    expect(res.status).toBe(401);
    expect(JSON.parse(text)).toMatchObject({ type: "error", error: { type: "authentication_error", message: "sign in again: Refresh token not found or invalid" } });
    expect(text).not.toMatch(/fake-claude-/);
  });

  it("count_tokens goes the same way", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => json({ input_tokens: 4 }));
    const { res } = await call(up, "/anthropic/v1/messages/count_tokens", messagesInit(token, MODEL));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer fake-claude-at-1");
  });
});
