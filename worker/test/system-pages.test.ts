import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const admin = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (token: string, body: unknown) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const RELAY_SECRET = "relay-secret-for-tests-0123456789abcdef";

async function systemWith(id: string, patterns: string[]): Promise<string> {
  const token = await addSystem(id);
  await env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(patterns), id).run();
  return token;
}

beforeEach(reset);

describe("logs", () => {
  it("keeps one line per gateway request, with the system and the gateway's error, never the token or the prompt", async () => {
    const token = await systemWith("logged", ["openai/*"]);
    const up = fakeUpstream(() => json({ error: { message: "Incorrect API key provided: sk-abc*********************wxyz" } }, 401));
    await call(up, "/v1/chat/completions", post(token, { model: "openai/gpt-x", messages: [{ role: "user", content: "secret prompt text" }] }));
    await call(fakeUpstream(() => json({})), "/v1/models", { headers: { authorization: "Bearer wrong" } });

    const r = await admin(up, "GET", "/logs");
    expect(r.res.status).toBe(200);
    const { logs } = JSON.parse(r.text) as { logs: Record<string, unknown>[] };
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ method: "GET", path: "/v1/models", status: 401, level: "warn", system_id: null });
    expect(logs[1]).toMatchObject({ method: "POST", path: "/v1/chat/completions", status: 401, level: "warn", system_id: "logged", model: "openai/gpt-x" });
    expect(String(logs[1]!.message)).toContain("Incorrect API key provided");
    expect(r.text).not.toContain("wxyz");
    expect(r.text).not.toContain("secret prompt text");
    expect(r.text).not.toContain(token);
  });

  it("filters by level and text, tails after an id, and clears", async () => {
    const now = Date.now();
    await env.DB.batch(
      [
        [now - 3000, "info", "POST", "/v1/chat/completions", 200, "a"],
        [now - 2000, "error", "POST", "/v1/embeddings", 502, "b"],
        [now - 1000, "warn", "GET", "/v1/models", 401, "c"],
      ].map(([at, level, method, path, status, sys]) =>
        env.DB.prepare("INSERT INTO log (at, level, method, path, status, took_ms, system_id) VALUES (?, ?, ?, ?, ?, 5, ?)").bind(at, level, method, path, status, sys),
      ),
    );
    const up = fakeUpstream(() => json({}));
    const errors = JSON.parse((await admin(up, "GET", "/logs?level=error")).text).logs as { path: string; id: number }[];
    expect(errors.map((x) => x.path)).toEqual(["/v1/embeddings"]);
    expect(JSON.parse((await admin(up, "GET", "/logs?q=models")).text).logs).toHaveLength(1);
    const after = JSON.parse((await admin(up, "GET", `/logs?after=${errors[0]!.id}`)).text).logs as { path: string }[];
    expect(after.map((x) => x.path)).toEqual(["/v1/models"]);
    expect((await admin(up, "DELETE", "/logs")).res.status).toBe(204);
    expect(JSON.parse((await admin(up, "GET", "/logs")).text).logs).toHaveLength(0);
  });

  it("drops lines older than 15 minutes", async () => {
    await env.DB.prepare("INSERT INTO log (at, level, method, path, status, took_ms) VALUES (?, 'info', 'GET', '/v1/models', 200, 1)").bind(Date.now() - 16 * 60_000).run();
    await call(fakeUpstream(() => json({})), "/v1/models", { headers: { authorization: "Bearer wrong" } });
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM log").first<{ n: number }>())!;
    expect(n).toBe(1);
  });
});

describe("relay pools", () => {
  it("stores a pool without ever answering its secret, checks each relay's health, and lists it", async () => {
    const up = fakeUpstream((req) => (new URL(req.url).pathname === "/health" ? new Response("ok") : json({})));
    const created = await admin(up, "POST", "/proxy-pools", { name: "Home", relays: ["https://relay-a.test/", "https://relay-b.test"], secret: RELAY_SECRET });
    expect(created.res.status, created.text).toBe(201);
    const pool = JSON.parse(created.text) as { id: string; relays: string[]; hint: string };
    expect(pool.relays).toEqual(["https://relay-a.test", "https://relay-b.test"]);
    expect(pool.hint).toBe("cdef");
    expect(created.text).not.toContain(RELAY_SECRET);

    const checked = await admin(up, "POST", `/proxy-pools/${pool.id}/test`);
    expect(JSON.parse(checked.text).relays).toMatchObject([{ url: "https://relay-a.test", ok: true }, { url: "https://relay-b.test", ok: true }]);
    expect(up.calls.map((r) => r.url)).toEqual(["https://relay-a.test/health", "https://relay-b.test/health"]);

    const list = await admin(up, "GET", "/proxy-pools");
    expect(list.text).not.toContain(RELAY_SECRET);
    expect(JSON.parse(list.text)).toMatchObject([{ id: pool.id, name: "Home", connections: 0 }]);
  });

  it("refuses a short secret, a bad address, and a pool that does not exist on a connection", async () => {
    const up = fakeUpstream(() => json({}));
    expect((await admin(up, "POST", "/proxy-pools", { name: "x", relays: ["https://r.test"], secret: "short" })).res.status).toBe(400);
    expect((await admin(up, "POST", "/proxy-pools", { name: "x", relays: ["ftp://r.test"], secret: RELAY_SECRET })).res.status).toBe(400);
    const conn = JSON.parse((await admin(up, "POST", "/connections", { provider: "groq", name: "g", api_key: "gsk-0123456789abcdef" })).text) as { id: string };
    expect((await admin(up, "PATCH", `/connections/${conn.id}`, { proxy_pool: "nope" })).res.status).toBe(400);
  });

  it("deleting a pool takes it off its connections", async () => {
    const up = fakeUpstream(() => json({}));
    const pool = JSON.parse((await admin(up, "POST", "/proxy-pools", { name: "P", relays: ["https://r.test"], secret: RELAY_SECRET })).text) as { id: string };
    const conn = JSON.parse((await admin(up, "POST", "/connections", { provider: "groq", name: "g", api_key: "gsk-0123456789abcdef", proxy_pool: pool.id, priority: 3 })).text) as {
      id: string;
      proxy_pool: string;
      priority: number;
    };
    expect(conn).toMatchObject({ proxy_pool: pool.id, priority: 3 });
    expect(JSON.parse((await admin(up, "GET", "/proxy-pools")).text)[0].connections).toBe(1);
    expect((await admin(up, "DELETE", `/proxy-pools/${pool.id}`)).res.status).toBe(204);
    const after = JSON.parse((await admin(up, "GET", "/connections")).text) as { id: string; proxy_pool: string | null }[];
    expect(after.find((x) => x.id === conn.id)!.proxy_pool).toBeNull();
  });
});

describe("connection check", () => {
  it("checks a key at the provider without storing it", async () => {
    const up = fakeUpstream(() => json({ data: [] }));
    const r = await admin(up, "POST", "/connections/check", { provider: "groq", api_key: "gsk-0123456789abcdef" });
    expect(JSON.parse(r.text)).toEqual({ ok: true });
    expect(up.calls[0]!.url).toBe("https://api.groq.com/openai/v1/models");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer gsk-0123456789abcdef");
    expect(r.text).not.toContain("gsk-0123456789abcdef");
    expect(JSON.parse((await admin(up, "GET", "/connections")).text)).toHaveLength(0);
  });
});

describe("Codex custom headers", () => {
  it("stores allowed headers and refuses the ones that carry credentials or routing", async () => {
    const up = fakeUpstream(() => json({}));
    const ok = await admin(up, "PUT", "/providers/codex/headers", { headers: { "x-team": "core", "OpenAI-Beta": "responses=v1" } });
    expect(ok.res.status, ok.text).toBe(200);
    expect(JSON.parse((await admin(up, "GET", "/providers/codex/headers")).text)).toEqual({ headers: { "x-team": "core", "OpenAI-Beta": "responses=v1" } });
    for (const name of ["Authorization", "cookie", "x-relay-secret", "chatgpt-account-id", "x-api-key", "host"]) {
      expect((await admin(up, "PUT", "/providers/codex/headers", { headers: { [name]: "v" } })).res.status, name).toBe(400);
    }
    expect((await admin(up, "PUT", "/providers/groq/headers", { headers: { "x-team": "core" } })).res.status).toBe(404);
  });
});

describe("backup", () => {
  it("exports the setup without any key, and imports it back", async () => {
    const up = fakeUpstream(() => json({}));
    await admin(up, "POST", "/combos", { name: "fast", targets: ["groq/llama-x", "openai/gpt-x"] });
    await admin(up, "POST", "/connections", { provider: "groq", name: "g", api_key: "gsk-0123456789abcdef" });
    await admin(up, "PUT", "/token-saver", { rtk: true });
    const exported = await admin(up, "GET", "/backup");
    expect(exported.res.status).toBe(200);
    const data = JSON.parse(exported.text) as { version: number; tables: Record<string, unknown[]> };
    expect(data.version).toBe(1);
    expect(data.tables.combo).toHaveLength(1);
    expect(Object.keys(data.tables)).not.toContain("connection");
    expect(exported.text).not.toContain("gsk-0123456789abcdef");

    await admin(up, "DELETE", "/combos/fast");
    await admin(up, "PUT", "/token-saver", { rtk: false });
    const imported = await admin(up, "POST", "/backup", data);
    expect(imported.res.status, imported.text).toBe(200);
    expect(JSON.parse((await admin(up, "GET", "/combos")).text).map((x: { name: string }) => x.name)).toContain("fast");
    expect(JSON.parse((await admin(up, "GET", "/token-saver")).text).rtk).toBe(true);
  });

  it("refuses an unknown table or column", async () => {
    const up = fakeUpstream(() => json({}));
    expect((await admin(up, "POST", "/backup", { version: 1, tables: { connection: [] } })).res.status).toBe(400);
    expect((await admin(up, "POST", "/backup", { version: 1, tables: { combo: [{ nope: 1 }] } })).res.status).toBe(400);
  });
});

describe("settings info", () => {
  it("says which sign-in secrets are set, never their values", async () => {
    const r = await admin(fakeUpstream(() => json({})), "GET", "/settings/info");
    expect(JSON.parse(r.text)).toEqual({ admin_token: true, oidc: true, console_emails: 2, connections_key: true, codex_relay: false });
    expect(r.text).not.toContain("test-oidc-secret");
  });
});

describe("media passthrough", () => {
  it("sends embeddings to the provider with its key and records the tokens", async () => {
    const token = await systemWith("media", ["openai/*"]);
    const up = fakeUpstream(() => json({ object: "list", data: [{ embedding: [0.1] }], model: "text-embedding-x", usage: { prompt_tokens: 7, total_tokens: 7 } }));
    const { res, text } = await call(up, "/v1/embeddings", post(token, { model: "openai/text-embedding-x", input: "hi" }));
    expect(res.status, text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer sk-test-openai");
    expect(JSON.parse(up.bodies[0]!)).toEqual({ model: "text-embedding-x", input: "hi" });
    const rows = await usageRows("media");
    expect(rows[0]).toMatchObject({ system_id: "media", provider: "openai", input_tokens: 7 });
  });

  it("passes speech audio through as bytes", async () => {
    const token = await systemWith("media", ["openai/*"]);
    const up = fakeUpstream(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
    const app = await call(up, "/v1/audio/speech", post(token, { model: "openai/tts-x", input: "hi", voice: "alloy" }));
    expect(app.res.status).toBe(200);
    expect(app.res.headers.get("content-type")).toBe("audio/mpeg");
    expect(up.calls[0]!.url).toBe("https://api.openai.com/v1/audio/speech");
  });

  it("rewrites the model of a transcription upload", async () => {
    const token = await systemWith("media", ["groq/*"]);
    const up = fakeUpstream(() => json({ text: "hello" }));
    const form = new FormData();
    form.set("model", "groq/whisper-x");
    form.set("file", new File([new Uint8Array([1, 2])], "a.mp3", { type: "audio/mpeg" }));
    const { res, text } = await call(up, "/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
    expect(res.status, text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const sent = await new Request("https://x.test", { method: "POST", body: up.bodies[0], headers: { "content-type": up.calls[0]!.headers.get("content-type")! } }).formData();
    expect(sent.get("model")).toBe("whisper-x");
    expect(sent.get("file")).toBeInstanceOf(File);
  });

  it("refuses a model the system may not use, a combo, and a provider that does not speak OpenAI", async () => {
    const token = await systemWith("media", ["openai/*"]);
    const up = fakeUpstream(() => json({}));
    expect((await call(up, "/v1/embeddings", post(token, { model: "groq/x", input: "hi" }))).res.status).toBe(403);
    expect((await call(up, "/v1/images/generations", post(token, { model: "combo/fast", prompt: "a cat" }))).res.status).toBe(400);
    const anthropic = await systemWith("media2", ["*"]);
    expect((await call(up, "/v1/embeddings", post(anthropic, { model: "claude-opus-5-5", input: "hi" }))).res.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });
});

describe("web search and fetch", () => {
  it("searches with the first provider that has a key, in the owner's order, and falls back on failure", async () => {
    const token = await addSystem("web");
    const up = fakeUpstream((req) => {
      if (req.url.startsWith("https://api.tavily.com")) return json({ error: "limit" }, 429);
      if (req.url.startsWith("https://google.serper.dev")) return json({ organic: [{ title: "Hono", link: "https://hono.dev", snippet: "Web framework" }] });
      return json({}, 404);
    });
    expect((await admin(up, "PUT", "/web-tools/tavily", { api_key: "tvly-0123456789abcdef" })).res.status).toBe(200);
    expect((await admin(up, "PUT", "/web-tools/serper", { api_key: "serper-0123456789abcdef" })).res.status).toBe(200);
    await admin(up, "PUT", "/web-tools/order", { search: ["tavily", "serper", "brave", "exa"], fetch: ["jina", "firecrawl"] });
    const { res, text } = await call(up, "/v1/search", post(token, { query: "hono" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({ query: "hono", provider: "serper", results: [{ title: "Hono", url: "https://hono.dev", snippet: "Web framework" }] });
    expect(up.calls.find((r) => r.url.startsWith("https://google.serper.dev"))!.headers.get("x-api-key")).toBe("serper-0123456789abcdef");
    const tools = await admin(up, "GET", "/web-tools");
    expect(tools.text).not.toContain("0123456789abcdef");
    expect(JSON.parse(tools.text).search.find((t: { id: string }) => t.id === "serper")).toMatchObject({ configured: true, hint: "cdef" });
  });

  it("fetches a page with Jina Reader, which needs no key", async () => {
    const token = await addSystem("web");
    const up = fakeUpstream(() => json({ data: { title: "Example", url: "https://example.com/", content: "Example Domain" } }));
    const { res, text } = await call(up, "/v1/fetch", post(token, { url: "https://example.com/" }));
    expect(res.status, text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://r.jina.ai/https://example.com/");
    expect(JSON.parse(text)).toEqual({ url: "https://example.com/", provider: "jina", title: "Example", content: "Example Domain" });
  });

  it("refuses a fetch of something that is not a web address", async () => {
    const token = await addSystem("web");
    const up = fakeUpstream(() => json({}));
    expect((await call(up, "/v1/fetch", post(token, { url: "file:///etc/passwd" }))).res.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });
});

describe("skills", () => {
  it("serves the skill files with this gateway's address and no token", async () => {
    const up = fakeUpstream(() => json({}));
    const list = await call(up, "/skills");
    expect(list.res.status).toBe(200);
    const skills = JSON.parse(list.text) as { name: string; url: string }[];
    expect(skills.map((s) => s.name)).toContain("ai-router");
    const md = await call(up, "/skills/ai-router.md");
    expect(md.res.headers.get("content-type")).toContain("text/markdown");
    expect(md.text).toContain("https://llm.test/v1");
    expect((await call(up, "/skills/nope.md")).res.status).toBe(404);
  });
});
