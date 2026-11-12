import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** An unsigned ID token as auth.openai.com issues it (only the claims the gateway reads). */
const idToken = (email: string, account: string) =>
  `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email, "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "plus" } }))}.sig`;
const tokens = (n: number, account = "acc_1", email = "dev@example.com") => ({ access_token: `at-${n}`, refresh_token: `rt-${n}`, id_token: idToken(email, account), expires_in: 3600 });
const now = () => Math.floor(Date.now() / 1000);

const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** Starts a login and finishes it with the token endpoint answering `grant`. Returns the connection. */
async function signIn(grant = tokens(1)): Promise<{ connection: Record<string, unknown>; up: FakeUpstream; authorize: URL }> {
  const up = fakeUpstream(() => json(grant));
  const start = JSON.parse((await adminCall(up, "POST", "/oauth/codex/start")).text) as { authorize_url: string };
  const authorize = new URL(start.authorize_url);
  const finished = await adminCall(up, "POST", "/oauth/codex/finish", { callback_url: `http://localhost:1455/auth/callback?code=the-code&state=${authorize.searchParams.get("state")}` });
  expect(finished.res.status, finished.text).toBe(201);
  return { connection: JSON.parse(finished.text), up, authorize };
}

const sse = (events: Record<string, unknown>[]) => new Response(events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const COMPLETED = { type: "response.completed", response: { id: "resp_1", model: "gpt-5.2-codex", usage: { input_tokens: 14, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } } } };
const HELLO = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_text.delta", delta: "Hel" },
  { type: "response.output_text.delta", delta: "lo" },
  COMPLETED,
];
const chat = (token: string, body: unknown) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
async function system(): Promise<string> {
  const token = await addSystem("chat");
  await env.DB.prepare("UPDATE system SET allowed_models = '[\"codex/*\"]' WHERE id = 'chat'").run();
  return token;
}

beforeEach(reset);

describe("Codex sign-in", () => {
  it("starts with OpenAI's authorize page: PKCE, the Codex CLI's client and its fixed local callback", async () => {
    const up = fakeUpstream(() => json({}));
    const r = await adminCall(up, "POST", "/oauth/codex/start");
    expect(r.res.status).toBe(200);
    const u = new URL(JSON.parse(r.text).authorize_url);
    expect(u.origin + u.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      redirect_uri: "http://localhost:1455/auth/callback",
      scope: "openid profile email offline_access",
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    });
    expect(u.searchParams.get("state")!.length).toBeGreaterThanOrEqual(32);
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(up.calls).toHaveLength(0);
    expect((await adminCall(up, "POST", "/oauth/openai/start")).res.status).toBe(404);
  });

  it("exchanges the code with the verifier behind the challenge, and stores the account sealed", async () => {
    const { connection, up, authorize } = await signIn();
    const sent = up.calls[0]!;
    expect(sent.url).toBe("https://auth.openai.com/oauth/token");
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const form = Object.fromEntries(new URLSearchParams(up.bodies[0]!));
    expect(form).toMatchObject({ grant_type: "authorization_code", code: "the-code", redirect_uri: "http://localhost:1455/auth/callback", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
    // The verifier is the one whose SHA-256 was sent as the challenge.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.code_verifier!)));
    expect(b64url(String.fromCharCode(...digest))).toBe(authorize.searchParams.get("code_challenge"));

    expect(connection).toMatchObject({ provider: "codex", auth_type: "oauth", name: "dev@example.com", account: "acc_1", priority: 1, disabled: false, hint: null });
    expect(Number(connection.expires_at) - now()).toBeGreaterThan(3500);
    expect(JSON.stringify(connection)).not.toMatch(/at-1|rt-1/);
    const row = await env.DB.prepare("SELECT * FROM connection WHERE id = ?").bind(connection.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toMatch(/at-1|rt-1/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_pending").first<number>("n")).toBe(0);
  });

  it("signing in again as the same account replaces its tokens; another account is a second connection", async () => {
    const first = await signIn(tokens(1));
    const again = await signIn(tokens(2));
    expect(again.connection.id).toBe(first.connection.id);
    const other = await signIn(tokens(3, "acc_2", "other@example.com"));
    expect(other.connection).toMatchObject({ name: "other@example.com", priority: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM connection").first<number>("n")).toBe(2);
  });

  it("refuses a state it did not issue, one that is used up, and a provider that refuses the code", async () => {
    const up = fakeUpstream(() => json(tokens(1)));
    expect((await adminCall(up, "POST", "/oauth/codex/finish", { callback_url: "http://localhost:1455/auth/callback?code=x&state=nope" })).res.status).toBe(400);
    const { authorize } = await signIn();
    const reused = await adminCall(up, "POST", "/oauth/codex/finish", { code: "the-code", state: authorize.searchParams.get("state") });
    expect(reused.res.status).toBe(400);

    const refuse = fakeUpstream(() => json({ error: "invalid_grant", error_description: "code expired" }, 400));
    const start = JSON.parse((await adminCall(refuse, "POST", "/oauth/codex/start")).text) as { authorize_url: string };
    const failed = await adminCall(refuse, "POST", "/oauth/codex/finish", { code: "c", state: new URL(start.authorize_url).searchParams.get("state") });
    expect(failed.res.status).toBe(502);
    expect(JSON.parse(failed.text)).toMatchObject({ error: "provider_refused", message: "code expired" });
  });

  it("two people of one ChatGPT account each get a connection of their own", async () => {
    await signIn(tokens(1, "acc_1", "a@example.com"));
    const second = await signIn(tokens(2, "acc_1", "b@example.com"));
    expect(second.connection).toMatchObject({ name: "b@example.com", priority: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM connection").first<number>("n")).toBe(2);
  });

  it("answers 404 for a provider name that is only an object property, and refuses an API key for a subscription provider", async () => {
    const up = fakeUpstream(() => json({}));
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect((await adminCall(up, "POST", `/oauth/${name}/start`)).res.status, name).toBe(404);
      expect((await adminCall(up, "POST", `/oauth/${name}/finish`, { code: "c", state: "s" })).res.status, name).toBe(404);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_pending").first<number>("n")).toBe(0);
    const key = await adminCall(up, "POST", "/connections", { provider: "codex", name: "x", api_key: "sk-not-for-codex-0001" });
    expect(key.res.status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM connection").first<number>("n")).toBe(0);
  });

  it("does not start a sign-in it could not store", async () => {
    const up = fakeUpstream(() => json({}));
    const r = await call(up, "/admin/oauth/codex/start", { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }, { CONNECTIONS_KEY: undefined });
    expect(r.res.status).toBe(500);
    expect(JSON.parse(r.text).error).toBe("not_configured");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_pending").first<number>("n")).toBe(0);
  });

  it("the browser's return to /auth/callback finishes the login without the console", async () => {
    const up = fakeUpstream(() => json(tokens(1)));
    const start = JSON.parse((await adminCall(up, "POST", "/oauth/codex/start")).text) as { authorize_url: string };
    const state = new URL(start.authorize_url).searchParams.get("state");
    const back = await call(up, `/auth/callback?code=the-code&state=${state}`);
    expect(back.res.status).toBe(200);
    expect(back.res.headers.get("content-type")).toContain("text/html");
    expect(back.text).toContain("dev@example.com");
    expect(back.text).not.toMatch(/at-1|rt-1/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM connection WHERE provider = 'codex'").first<number>("n")).toBe(1);
  });
});

describe("requests through a Codex account", () => {
  const MESSAGES = [
    { role: "system", content: "Be brief." },
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: '{"path":"."}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "a.txt" },
    { role: "user", content: [{ type: "text", text: "and now?" }] },
  ];

  it("says to sign in when no account is connected", async () => {
    const token = await system();
    const up = fakeUpstream(() => sse(HELLO));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error).toMatchObject({ code: "not_configured", message: "not_configured: no codex connection; sign in from the console" });
    expect(up.calls).toHaveLength(0);
  });

  it("sends a Responses request the way the Codex CLI does, and answers as a chat completion", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => sse(HELLO));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, {
      model: "codex/gpt-5.2-codex", messages: MESSAGES, temperature: 0.2, max_tokens: 100,
      tools: [{ type: "function", function: { name: "ls", description: "List files", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    }));
    expect(res.status).toBe(200);
    const sent = up.calls[0]!;
    expect(sent.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(sent.headers.get("authorization")).toBe("Bearer at-1");
    expect(sent.headers.get("chatgpt-account-id")).toBe("acc_1");
    expect(sent.headers.get("originator")).toBe("codex_cli_rs");
    expect(sent.headers.get("accept")).toBe("text/event-stream");
    expect(sent.headers.get("session_id")).toMatch(/^[0-9a-f-]{36}$/);
    const body = JSON.parse(up.bodies[0]!);
    expect(body).toMatchObject({ model: "gpt-5.2-codex", stream: true, store: false, instructions: "Be brief." });
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "call_1", name: "ls", arguments: '{"path":"."}' },
      { type: "function_call_output", call_id: "call_1", output: "a.txt" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "and now?" }] },
    ]);
    expect(body.tools).toEqual([{ type: "function", name: "ls", description: "List files", parameters: { type: "object", properties: { path: { type: "string" } } } }]);
    for (const dropped of ["temperature", "max_tokens", "max_output_tokens", "messages"]) expect(body, dropped).not.toHaveProperty(dropped);

    const out = JSON.parse(text);
    expect(out).toMatchObject({ object: "chat.completion", model: "gpt-5.2-codex", choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }] });
    expect(out.usage).toEqual({ prompt_tokens: 14, completion_tokens: 3, total_tokens: 17, prompt_tokens_details: { cached_tokens: 4 } });
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "codex", model: "gpt-5.2-codex", status: 200, input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4 })]);
  });

  it("falls back to the Codex CLI's own instructions when the request has no system message", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => sse(HELLO));
    await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] }));
    const instructions = JSON.parse(up.bodies[0]!).instructions as string;
    expect(instructions.startsWith("You are Codex")).toBe(true);
    expect(instructions.length).toBeGreaterThan(1000);
  });

  it("streams text and tool calls as chat completion chunks", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() =>
      sse([
        { type: "response.output_text.delta", delta: "On it. " },
        { type: "response.output_item.added", item: { type: "function_call", call_id: "call_9", name: "ls", arguments: "" } },
        { type: "response.function_call_arguments.delta", delta: '{"path":' },
        { type: "response.function_call_arguments.delta", delta: '"."}' },
        COMPLETED,
      ]),
    );
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "list" }] }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const chunks = text.split("\n\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
    expect(chunks.map((c) => c.choices[0]?.delta).filter(Boolean)).toEqual([
      { role: "assistant", content: "On it. " },
      { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "ls", arguments: "" } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"."}' } }] },
      {},
    ]);
    expect(chunks.find((c) => c.choices[0]?.finish_reason)!.choices[0].finish_reason).toBe("tool_calls");
    expect(chunks[chunks.length - 1].usage).toMatchObject({ prompt_tokens: 14, completion_tokens: 3 });
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    expect((await usageRows("chat"))[0]).toMatchObject({ streamed: 1, output_tokens: 3 });
  });

  it("refreshes a token that is about to expire, and uses and keeps the new one", async () => {
    const token = await system();
    const { connection } = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() + 120, connection.id).run();
    const up = fakeUpstream((req) => (new URL(req.url).host === "auth.openai.com" ? json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 7200 }) : sse(HELLO)));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => new URL(r.url).host)).toEqual(["auth.openai.com", "chatgpt.com"]);
    expect(JSON.parse(up.bodies[0]!)).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type: "refresh_token", refresh_token: "rt-1" });
    expect(up.calls[1]!.headers.get("authorization")).toBe("Bearer at-2");
    const row = await env.DB.prepare("SELECT expires_at FROM connection WHERE id = ?").bind(connection.id).first<{ expires_at: number }>();
    expect(row!.expires_at - now()).toBeGreaterThan(7000);

    // The next request needs no refresh and sends the stored new token.
    const next = fakeUpstream(() => sse(HELLO));
    await call(next, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] }));
    expect(next.calls.map((r) => r.headers.get("authorization"))).toEqual(["Bearer at-2"]);
  });

  it("an account whose refresh is refused is set aside with the reason, and the request says the provider is not usable", async () => {
    const token = await system();
    const { connection } = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() - 10, connection.id).run();
    const up = fakeUpstream(() => json({ error: "invalid_grant", error_description: "refresh token reused" }, 400));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(401);
    expect(JSON.parse(text).error.message).toContain("sign in again");
    expect(up.calls.map((r) => new URL(r.url).host)).toEqual(["auth.openai.com"]);
    const row = await env.DB.prepare("SELECT last_error, cooldown_until FROM connection WHERE id = ?").bind(connection.id).first<{ last_error: string; cooldown_until: number }>();
    expect(row!.last_error).toBe("401 sign in again: refresh token reused");
    expect(row!.cooldown_until).toBeGreaterThan(now());
  });

  it("testing a signed-in account renews its token at the provider, and only a real renewal clears its failure", async () => {
    const { connection } = await signIn();
    await env.DB.prepare("UPDATE connection SET cooldown_until = ?, last_error = '429 limit', last_error_at = 5 WHERE id = ?").bind(now() + 500, connection.id).run();
    const renew = fakeUpstream(() => json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }));
    const ok = await adminCall(renew, "POST", `/connections/${connection.id}/test`);
    expect(JSON.parse(ok.text)).toEqual({ ok: true });
    expect(renew.calls.map((r) => r.url)).toEqual(["https://auth.openai.com/oauth/token"]);
    expect(await env.DB.prepare("SELECT cooldown_until, last_error FROM connection WHERE id = ?").bind(connection.id).first()).toEqual({ cooldown_until: 0, last_error: null });

    const refused = fakeUpstream(() => json({ error: "invalid_grant", error_description: "refresh token reused" }, 400));
    const bad = await adminCall(refused, "POST", `/connections/${connection.id}/test`);
    expect(JSON.parse(bad.text)).toEqual({ ok: false, status: 401, message: "sign in again: refresh token reused" });
    const row = await env.DB.prepare("SELECT last_error FROM connection WHERE id = ?").bind(connection.id).first<{ last_error: string }>();
    expect(row!.last_error).toBe("401 sign in again: refresh token reused");
  });

  it("passes Codex's own refusal on with its status and message", async () => {
    const token = await system();
    const { connection } = await signIn();
    const up = fakeUpstream(() => json({ detail: "The usage limit has been reached" }, 429));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(429);
    expect(JSON.parse(text).error.message).toBe("The usage limit has been reached");
    const row = await env.DB.prepare("SELECT last_error FROM connection WHERE id = ?").bind(connection.id).first<{ last_error: string }>();
    expect(row!.last_error).toBe("429 The usage limit has been reached");
  });

  it("a failure inside the stream becomes an error, not an empty answer", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => sse([{ type: "response.failed", response: { error: { code: "server_error", message: "model overloaded" } } }]));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(502);
    expect(JSON.parse(text).error.message).toBe("model overloaded");
  });

  it("takes the effort from a model name that ends with one, as 9router does", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => sse(HELLO));
    await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex-high", messages: [{ role: "user", content: "hi" }] }));
    expect(JSON.parse(up.bodies[0]!)).toMatchObject({ model: "gpt-5.2-codex", reasoning: { effort: "high", summary: "auto" } });
  });

  it("a 401 from Codex renews the token once and sends the request again", async () => {
    const token = await system();
    await signIn();
    let sent = 0;
    const up = fakeUpstream((req) => {
      if (new URL(req.url).host === "auth.openai.com") return json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
      return ++sent === 1 ? json({ detail: "token expired" }, 401) : sse(HELLO);
    });
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => new URL(r.url).host)).toEqual(["chatgpt.com", "auth.openai.com", "chatgpt.com"]);
    expect(up.calls[2]!.headers.get("authorization")).toBe("Bearer at-2");
    expect((await usageRows("chat")).map((r) => r.status)).toEqual([401, 200]);
  });

  it("when another request already renewed the token, a refused renewal uses the stored one and the account stays in use", async () => {
    const token = await system();
    const { connection } = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() + 60, connection.id).run();
    const up = fakeUpstream(async (req) => {
      if (new URL(req.url).host !== "auth.openai.com") return sse(HELLO);
      // The other request wins the race: its new tokens are stored before this refusal comes back.
      await signIn(tokens(5));
      return json({ error: "invalid_grant", error_description: "refresh token reused" }, 400);
    });
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(up.calls[up.calls.length - 1]!.headers.get("authorization")).toBe("Bearer at-5");
    expect(await env.DB.prepare("SELECT cooldown_until, last_error FROM connection WHERE id = ?").bind(connection.id).first()).toEqual({ cooldown_until: 0, last_error: null });
  });

  it("a sign-in service that is down does not ask for a new sign-in: the old token is used while it is valid, else 502", async () => {
    const token = await system();
    const { connection } = await signIn();
    const up = fakeUpstream((req) => (new URL(req.url).host === "auth.openai.com" ? json({ error: "server_error" }, 503) : sse(HELLO)));
    const ask = () => call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] }));

    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() + 120, connection.id).run();
    expect((await ask()).res.status).toBe(200);
    expect(up.calls[up.calls.length - 1]!.headers.get("authorization")).toBe("Bearer at-1");

    await env.DB.prepare("UPDATE connection SET expires_at = ?, cooldown_until = 0 WHERE id = ?").bind(now() - 10, connection.id).run();
    const late = await ask();
    expect(late.res.status).toBe(502);
    expect(JSON.parse(late.text).error.message).not.toContain("sign in again");
  });

  it("a combo moves to its next model when the Codex account needs a new sign-in", async () => {
    const token = await addSystem("chat");
    await env.DB.prepare("UPDATE system SET allowed_models = '[\"combo/mix\"]' WHERE id = 'chat'").run();
    await env.DB.prepare("INSERT INTO combo (name, targets, updated_at) VALUES ('mix', '[\"codex/gpt-5.2-codex\",\"openai/gpt-5\"]', 1)").run();
    const { connection } = await signIn();
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() - 10, connection.id).run();
    const up = fakeUpstream((req) =>
      new URL(req.url).host === "auth.openai.com"
        ? json({ error: "invalid_grant", error_description: "refresh token reused" }, 400)
        : json({ id: "c", object: "chat.completion", model: "gpt-5", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "combo/mix", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-target")).toBe("openai/gpt-5");
  });

  it("a stream that stops before the provider says it is complete is an error, not a short answer", async () => {
    const token = await system();
    await signIn();
    const cut = [{ type: "response.output_text.delta", delta: "partial ans" }];
    const whole = await call(fakeUpstream(() => sse(cut)), "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] }));
    expect(whole.res.status).toBe(502);
    expect(JSON.parse(whole.text).error.message).toBe("the stream from the provider ended early");

    const empty = await call(fakeUpstream(() => sse([])), "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(empty.res.status).toBe(502);

    const streamed = await call(fakeUpstream(() => sse(cut)), "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(streamed.res.status).toBe(200);
    const events = streamed.text.split("\n\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
    expect(events[0].choices[0].delta).toEqual({ role: "assistant", content: "partial ans" });
    expect(events[events.length - 1].error.message).toBe("the stream from the provider ended early");
    expect(events.some((e) => e.choices?.[0]?.finish_reason)).toBe(false);
  });

  it("an answer the provider cut short finishes with \"length\" and still counts its tokens", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => sse([{ type: "response.output_text.delta", delta: "long" }, { type: "response.incomplete", response: { model: "gpt-5.2-codex", usage: { input_tokens: 9, output_tokens: 7 }, incomplete_details: { reason: "max_output_tokens" } } }]));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(JSON.parse(text).choices[0]).toMatchObject({ message: { content: "long" }, finish_reason: "length" });
    expect((await usageRows("chat"))[0]).toMatchObject({ input_tokens: 9, output_tokens: 7 });
  });

  it("with stream: true, a failure the provider reports first is a 502 before any chunk is sent", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => sse([{ type: "response.created", response: { id: "r" } }, { type: "error", error: { code: "server_is_overloaded", message: "server is overloaded" } }]));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(502);
    expect(JSON.parse(text).error.message).toBe("server is overloaded");
  });

  it("keeps each tool call's arguments with its own call, also when they only arrive with the finished item", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() =>
      sse([
        { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "ls", arguments: "" } },
        { type: "response.output_item.added", item: { id: "fc_2", type: "function_call", call_id: "call_2", name: "cat", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_2", delta: '{"file":"b"}' },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"a"}' },
        { type: "response.output_item.added", item: { id: "fc_3", type: "function_call", call_id: "call_3", name: "pwd", arguments: "" } },
        { type: "response.output_item.done", item: { id: "fc_3", type: "function_call", call_id: "call_3", name: "pwd", arguments: "{}" } },
        COMPLETED,
      ]),
    );
    const { text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "go" }] }));
    expect(JSON.parse(text).choices[0].message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "ls", arguments: '{"path":"a"}' } },
      { id: "call_2", type: "function", function: { name: "cat", arguments: '{"file":"b"}' } },
      { id: "call_3", type: "function", function: { name: "pwd", arguments: "{}" } },
    ]);
  });
});

describe("the Codex relay", () => {
  // chatgpt.com refuses every request that carries the Cf-Worker header, and a Worker cannot leave it out.
  const RELAY = { CODEX_RELAY_URL: "https://relay.test/", CODEX_RELAY_SECRET: "test-relay-secret" };
  const hi = { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }] };
  const lastError = async (id: unknown) => (await env.DB.prepare("SELECT last_error FROM connection WHERE id = ?").bind(id).first<{ last_error: string | null }>())!.last_error;

  it("sends Codex requests to CODEX_RELAY_URL with the relay secret, and answers as usual", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => sse(HELLO));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, hi), RELAY);
    expect(res.status).toBe(200);
    expect(JSON.parse(text).choices[0].message.content).toBe("Hello");
    const sent = up.calls[0]!;
    expect(sent.url).toBe("https://relay.test/codex/responses");
    expect(sent.headers.get("x-relay-secret")).toBe("test-relay-secret");
    expect(sent.headers.get("authorization")).toBe("Bearer at-1");
    expect(sent.headers.get("chatgpt-account-id")).toBe("acc_1");
    expect(JSON.parse(up.bodies[0]!)).toMatchObject({ model: "gpt-5.2-codex", stream: true });
    expect(text).not.toContain("test-relay-secret");
  });

  it("a relay address without its secret sends nothing and does not set the account aside", async () => {
    const token = await system();
    const { connection } = await signIn();
    const up = fakeUpstream(() => sse(HELLO));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, hi), { CODEX_RELAY_URL: "https://relay.test" });
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error).toMatchObject({ code: "not_configured", message: "not_configured: CODEX_RELAY_URL is set but CODEX_RELAY_SECRET is not" });
    expect(up.calls).toHaveLength(0);
    expect(await lastError(connection.id)).toBeNull();
  });

  it("a relay that refuses the secret (403, x-relay-error) is a gateway error: no token renewal, the account is not set aside", async () => {
    const token = await system();
    const { connection } = await signIn();
    const up = fakeUpstream(() => new Response(JSON.stringify({ error: "relay_unauthorized" }), { status: 403, headers: { "content-type": "application/json", "x-relay-error": "relay_unauthorized" } }));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, hi), RELAY);
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error).toMatchObject({ code: "not_configured", message: "not_configured: the Codex relay refused CODEX_RELAY_SECRET" });
    expect(up.calls.map((r) => new URL(r.url).host)).toEqual(["relay.test"]);
    expect(await lastError(connection.id)).toBeNull();
  });

  it("chatgpt.com's block page becomes an error that names the relay, and the account is not set aside", async () => {
    const token = await system();
    const { connection } = await signIn();
    const up = fakeUpstream(() => new Response("<html><body>blocked</body></html>", { status: 403, headers: { "content-type": "text/html; charset=UTF-8" } }));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, hi));
    expect(res.status).toBe(502);
    expect(JSON.parse(text).error).toMatchObject({
      code: "codex_blocked",
      message: "chatgpt.com refuses requests sent from a Cloudflare Worker: run the Codex relay and set CODEX_RELAY_URL and CODEX_RELAY_SECRET (README, Codex relay)",
    });
    expect(text).not.toContain("<html");
    expect(up.calls).toHaveLength(1);
    expect(await lastError(connection.id)).toBeNull();
  });
});
