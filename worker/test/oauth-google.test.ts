import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

// Every id, secret and token here is a made-up value: nothing in this file reaches a real service.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const now = () => Math.floor(Date.now() / 1000);

const CLIENTS = {
  GOOGLE_GEMINI_CLI_CLIENT_ID: "fake-gemini-cli-client.apps.example",
  GOOGLE_GEMINI_CLI_CLIENT_SECRET: "fake-gemini-cli-secret",
  GOOGLE_ANTIGRAVITY_CLIENT_ID: "fake-antigravity-client.apps.example",
  GOOGLE_ANTIGRAVITY_CLIENT_SECRET: "fake-antigravity-secret",
};
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const LOAD_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ONBOARD_URL = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser";
const CLI_BASE = "https://cloudcode-pa.googleapis.com/v1internal";
const AG_BASE = "https://daily-cloudcode-pa.googleapis.com/v1internal";
const SECRET = /fake-google-|fake-gemini-cli-secret|fake-antigravity-secret/;

const ANSWER = {
  response: {
    candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 },
  },
};

interface GoogleOpts {
  token?: (body: URLSearchParams) => Response;
  load?: () => Response;
  chat?: (req: Request, n: number) => Response | Promise<Response>;
}

/** Google as the sign-in and Cloud Code see it. */
function google(opts: GoogleOpts = {}): FakeUpstream {
  let chats = 0;
  return fakeUpstream(async (req) => {
    if (req.url === TOKEN_URL) {
      const body = new URLSearchParams(await req.clone().text());
      if (opts.token) return opts.token(body);
      return json({ access_token: "fake-google-at-1", refresh_token: "fake-google-rt-1", expires_in: 3599, token_type: "Bearer", id_token: "fake-google-id-token" });
    }
    if (req.url === USERINFO_URL) return json({ id: "1234567890", email: "dev@example.com", verified_email: true });
    if (req.url === LOAD_URL) return opts.load ? opts.load() : json({ cloudaicompanionProject: "fake-project-1", allowedTiers: [{ id: "free-tier", isDefault: true }] });
    if (req.url === ONBOARD_URL) return json({ done: true });
    if (req.url.startsWith(CLI_BASE) || req.url.startsWith(AG_BASE)) return opts.chat ? opts.chat(req, ++chats) : json(ANSWER);
    return json({ error: { code: 404, message: "unexpected", status: "NOT_FOUND" } }, 404);
  });
}

const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown, vars: Record<string, unknown> = CLIENTS) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, vars);

async function start(provider: string, up: FakeUpstream): Promise<URL> {
  const r = await adminCall(up, "POST", `/oauth/${provider}/start`);
  expect(r.res.status, r.text).toBe(200);
  return new URL((JSON.parse(r.text) as { authorize_url: string }).authorize_url);
}

async function signIn(provider: string, up = google()): Promise<Record<string, unknown>> {
  const u = await start(provider, up);
  const r = await adminCall(up, "POST", `/oauth/${provider}/finish`, { callback_url: `http://localhost:8085/oauth2callback?code=the-code&state=${u.searchParams.get("state")}` });
  expect(r.res.status, r.text).toBe(201);
  return JSON.parse(r.text);
}

const chat = (token: string, body: unknown) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
async function system(pattern: string): Promise<string> {
  const token = await addSystem("chat");
  await env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = 'chat'").bind(JSON.stringify([pattern])).run();
  return token;
}

beforeEach(reset);

describe("Google sign-in (Gemini CLI, Antigravity) needs its client from the environment", () => {
  it("is unavailable while the client id or secret is unset, and says which variables to set", async () => {
    const up = google();
    const r = await adminCall(up, "POST", "/oauth/gemini-cli/start", undefined, { GOOGLE_GEMINI_CLI_CLIENT_ID: "fake-gemini-cli-client.apps.example" });
    expect(r.res.status).toBe(503);
    expect(JSON.parse(r.text)).toEqual({ error: "unavailable", message: "set GOOGLE_GEMINI_CLI_CLIENT_SECRET" });
    expect(up.calls).toHaveLength(0);

    const list = await adminCall(up, "GET", "/providers", undefined, {});
    const rows = JSON.parse(list.text) as { id: string; missing_env?: string[] }[];
    expect(rows.find((p) => p.id === "gemini-cli")?.missing_env).toEqual(["GOOGLE_GEMINI_CLI_CLIENT_ID", "GOOGLE_GEMINI_CLI_CLIENT_SECRET"]);
    expect(rows.find((p) => p.id === "antigravity")?.missing_env).toEqual(["GOOGLE_ANTIGRAVITY_CLIENT_ID", "GOOGLE_ANTIGRAVITY_CLIENT_SECRET"]);
    expect(rows.find((p) => p.id === "claude")).not.toHaveProperty("missing_env");

    const set = JSON.parse((await adminCall(up, "GET", "/providers")).text) as { id: string; missing_env?: string[] }[];
    expect(set.find((p) => p.id === "gemini-cli")).not.toHaveProperty("missing_env");
    // The values themselves never appear.
    expect(list.text + JSON.stringify(set)).not.toMatch(/fake-/);
  });
});

describe("Gemini CLI sign-in", () => {
  it("starts at Google with the configured client, offline access, consent and PKCE", async () => {
    const u = await start("gemini-cli", google());
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code",
      client_id: CLIENTS.GOOGLE_GEMINI_CLI_CLIENT_ID,
      redirect_uri: "http://localhost:8085/oauth2callback",
      scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
      access_type: "offline",
      prompt: "consent",
      code_challenge_method: "S256",
    });
    expect(u.toString()).not.toContain(CLIENTS.GOOGLE_GEMINI_CLI_CLIENT_SECRET);
  });

  it("trades the code with the client secret, looks up the Code Assist project, and stores it as the account", async () => {
    const up = google();
    const connection = await signIn("gemini-cli", up);
    expect(up.calls.map((r) => r.url)).toEqual([TOKEN_URL, USERINFO_URL, LOAD_URL]);
    expect(up.calls[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(up.bodies[0]!))).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      client_id: CLIENTS.GOOGLE_GEMINI_CLI_CLIENT_ID,
      client_secret: CLIENTS.GOOGLE_GEMINI_CLI_CLIENT_SECRET,
      redirect_uri: "http://localhost:8085/oauth2callback",
    });
    expect(up.calls[1]!.headers.get("authorization")).toBe("Bearer fake-google-at-1");
    expect(up.calls[2]!.headers.get("authorization")).toBe("Bearer fake-google-at-1");
    expect(JSON.parse(up.bodies[2]!)).toEqual({ metadata: { ideType: 9, platform: 0, pluginType: 2 }, mode: 1 });

    expect(connection).toMatchObject({ provider: "gemini-cli", auth_type: "oauth", name: "dev@example.com", account: "fake-project-1" });
    expect(Number(connection.expires_at)).toBeGreaterThan(now() + 3000);
    expect(JSON.stringify(connection)).not.toMatch(SECRET);
    const row = await env.DB.prepare("SELECT * FROM connection WHERE id = ?").bind(connection.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toMatch(SECRET);
  });

  it("reads the project when Cloud Code answers it as an object", async () => {
    const connection = await signIn("gemini-cli", google({ load: () => json({ cloudaicompanionProject: { id: "fake-project-2", name: "x" } }) }));
    expect(connection.account).toBe("fake-project-2");
  });

  it("refuses an account with no Code Assist project, without a token in the answer", async () => {
    const up = google({ load: () => json({ allowedTiers: [{ id: "free-tier", isDefault: true }] }) });
    const u = await start("gemini-cli", up);
    const r = await adminCall(up, "POST", "/oauth/gemini-cli/finish", { callback_url: `http://localhost:8085/oauth2callback?code=the-code&state=${u.searchParams.get("state")}` });
    expect(r.res.status).toBe(502);
    expect(JSON.parse(r.text).message).toMatch(/no Gemini Code Assist project/);
    expect(r.text).not.toMatch(SECRET);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM connection").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("Antigravity sign-in", () => {
  it("asks for Antigravity's extra scopes and looks the project up as Antigravity, then onboards once", async () => {
    const up = google();
    const u = await start("antigravity", up);
    expect(u.searchParams.get("client_id")).toBe(CLIENTS.GOOGLE_ANTIGRAVITY_CLIENT_ID);
    expect(u.searchParams.get("scope")!.split(" ")).toEqual(expect.arrayContaining(["https://www.googleapis.com/auth/cclog", "https://www.googleapis.com/auth/experimentsandconfigs"]));
    const r = await adminCall(up, "POST", "/oauth/antigravity/finish", { callback_url: `http://localhost:8085/oauth2callback?code=the-code&state=${u.searchParams.get("state")}` });
    expect(r.res.status, r.text).toBe(201);
    expect(Object.fromEntries(new URLSearchParams(up.bodies[0]!))).toMatchObject({ client_secret: CLIENTS.GOOGLE_ANTIGRAVITY_CLIENT_SECRET });
    const load = up.calls.find((x) => x.url === LOAD_URL)!;
    expect(load.headers.get("user-agent")).toMatch(/^antigravity\//);
    expect(load.headers.get("x-request-source")).toBe("local");
    const at = up.calls.indexOf(load);
    expect(JSON.parse(up.bodies[at]!)).toEqual({ metadata: { ideType: 9, platform: 0, pluginType: 2 } });
    const onboard = up.calls.findIndex((x) => x.url === ONBOARD_URL);
    expect(JSON.parse(up.bodies[onboard]!)).toEqual({ tierId: "free-tier", metadata: { ideType: 9, platform: 0, pluginType: 2 } });
    expect(JSON.parse(r.text)).toMatchObject({ provider: "antigravity", account: "fake-project-1" });
  });
});

describe("requests through Cloud Code", () => {
  it("Gemini CLI: a chat completion goes out as a Cloud Code generateContent with the project, and comes back as one", async () => {
    const token = await system("gemini-cli/*");
    await signIn("gemini-cli");
    const up = google();
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "gemini-cli/gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] }), CLIENTS);
    expect(res.status, text).toBe(200);
    const sent = up.calls[0]!;
    expect(sent.url).toBe(`${CLI_BASE}:generateContent`);
    expect(sent.headers.get("authorization")).toBe("Bearer fake-google-at-1");
    expect(sent.headers.get("user-agent")).toMatch(/^GeminiCLI\/[\d.]+\/gemini-2\.5-pro /);
    expect(JSON.parse(up.bodies[0]!)).toEqual({ model: "gemini-2.5-pro", project: "fake-project-1", request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } });
    const out = JSON.parse(text);
    expect(out.choices[0].message.content).toBe("Hello");
    expect(out.usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 2 });
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "gemini-cli", model: "gemini-2.5-pro", status: 200, input_tokens: 9, output_tokens: 2 })]);
  });

  it("Antigravity: a stream goes to the daily endpoint as SSE, in Antigravity's envelope, under the upstream model name", async () => {
    const token = await system("antigravity/*");
    await signIn("antigravity");
    const up = google({
      chat: () =>
        new Response(
          [
            { response: { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] } },
            { response: { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } } },
          ]
            .map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const { res, text } = await call(
      up,
      "/openai/v1/chat/completions",
      chat(token, { model: "antigravity/gemini-3.1-pro-high", stream: true, max_tokens: 200000, messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }] }),
      CLIENTS,
    );
    expect(res.status, text).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sent = up.calls[0]!;
    expect(sent.url).toBe(`${AG_BASE}:streamGenerateContent?alt=sse`);
    expect(sent.headers.get("user-agent")).toMatch(/^antigravity\//);
    const body = JSON.parse(up.bodies[0]!);
    expect(body).toMatchObject({ project: "fake-project-1", model: "gemini-pro-agent", userAgent: "antigravity" });
    expect(body.requestId).toMatch(/^agent\//);
    expect(typeof body.request.sessionId).toBe("string");
    expect(body.request.generationConfig.maxOutputTokens).toBe(64000);
    expect(body.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    const content = text
      .split("\n\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)) as { choices: { delta?: { content?: string } }[] })
      .map((c) => c.choices[0]?.delta?.content ?? "")
      .join("");
    expect(content).toBe("Hello");
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    // The usage chunk is not passed on unless asked for, but it is counted.
    expect(text).not.toContain('"choices":[]');
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "antigravity", model: "gemini-pro-agent", status: 200, input_tokens: 4, output_tokens: 2 })]);
  });

  it("passes Google's error on with its status and message", async () => {
    const token = await system("gemini-cli/*");
    await signIn("gemini-cli");
    const up = google({ chat: () => json({ error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } }, 400) });
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "gemini-cli/gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] }), CLIENTS);
    expect(res.status).toBe(400);
    expect(JSON.parse(text).error.message).toContain("Request contains an invalid argument.");
  });

  it("renews a token about to expire with the client secret, then sends the chat with the new token", async () => {
    const token = await system("gemini-cli/*");
    const connection = await signIn("gemini-cli");
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() + 30, connection.id).run();
    const up = google({ token: () => json({ access_token: "fake-google-at-2", expires_in: 3599, token_type: "Bearer" }) });
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "gemini-cli/gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] }), CLIENTS);
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => r.url)).toEqual([TOKEN_URL, `${CLI_BASE}:generateContent`]);
    expect(Object.fromEntries(new URLSearchParams(up.bodies[0]!))).toEqual({
      client_id: CLIENTS.GOOGLE_GEMINI_CLI_CLIENT_ID,
      client_secret: CLIENTS.GOOGLE_GEMINI_CLI_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: "fake-google-rt-1",
    });
    expect(up.calls[1]!.headers.get("authorization")).toBe("Bearer fake-google-at-2");
  });

  it("renews once and sends again when Cloud Code refuses the token", async () => {
    const token = await system("gemini-cli/*");
    await signIn("gemini-cli");
    const up = google({
      token: () => json({ access_token: "fake-google-at-3", expires_in: 3599 }),
      chat: (req, n) => (n === 1 ? json({ error: { code: 401, message: "invalid credentials", status: "UNAUTHENTICATED" } }, 401) : json(ANSWER)),
    });
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "gemini-cli/gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] }), CLIENTS);
    expect(res.status, text).toBe(200);
    expect(up.calls.map((r) => r.url)).toEqual([`${CLI_BASE}:generateContent`, TOKEN_URL, `${CLI_BASE}:generateContent`]);
    expect(up.calls[2]!.headers.get("authorization")).toBe("Bearer fake-google-at-3");
  });

  it("an expired token whose client is no longer configured says which variables to set", async () => {
    const token = await system("gemini-cli/*");
    const connection = await signIn("gemini-cli");
    await env.DB.prepare("UPDATE connection SET expires_at = ? WHERE id = ?").bind(now() - 10, connection.id).run();
    const up = google();
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "gemini-cli/gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] }), {});
    expect(res.status).toBe(502);
    expect(JSON.parse(text).error.message).toMatch(/GOOGLE_GEMINI_CLI_CLIENT_ID/);
    expect(up.calls).toHaveLength(0);
    expect(text).not.toMatch(SECRET);
  });
});
