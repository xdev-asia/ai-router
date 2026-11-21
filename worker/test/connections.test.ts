import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, messagesInit, reset, usageRows } from "./helpers";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const COMPLETION = {
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "gpt-5-2026",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
};
const MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 2, output_tokens: 1 } };

const admin = (method: string, path: string, body?: unknown, envOverride?: Record<string, unknown>) =>
  call(
    fakeUpstream(() => json({})),
    `/admin${path}`,
    { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    envOverride,
  );

const chat = (token: string, model: string) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
});

const allow = (id: string, patterns: string[]) => env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(patterns), id).run();

/** Adds an API-key connection through the admin API and returns its id. */
async function connect(provider: string, name: string, apiKey: string): Promise<string> {
  const r = await admin("POST", "/connections", { provider, name, api_key: apiKey });
  expect(r.res.status, r.text).toBe(201);
  return (JSON.parse(r.text) as { id: string }).id;
}

const row = (id: string) => env.DB.prepare("SELECT * FROM connection WHERE id = ?").bind(id).first<Record<string, unknown>>();
const bearer = (req: Request) => req.headers.get("authorization");
const now = () => Math.floor(Date.now() / 1000);

beforeEach(reset);

describe("admin: connections", () => {
  it("creates an API-key connection, never returns the key, and stores it encrypted", async () => {
    const created = await admin("POST", "/connections", { provider: "openai", name: "work", api_key: "sk-live-abcd1234" });
    expect(created.res.status).toBe(201);
    const c = JSON.parse(created.text);
    expect(c).toMatchObject({ provider: "openai", auth_type: "api_key", name: "work", priority: 1, disabled: false, hint: "1234", cooldown_until: 0, last_error: null });
    expect(created.text).not.toContain("sk-live-abcd1234");

    const list = await admin("GET", "/connections");
    expect(JSON.parse(list.text)).toEqual([expect.objectContaining({ id: c.id, name: "work", hint: "1234" })]);
    expect(list.text).not.toContain("sk-live");
    expect(list.text).not.toContain("secret");

    const stored = await row(c.id);
    expect(JSON.stringify(stored)).not.toContain("sk-live-abcd1234");
    expect(String(stored!.secret)).toMatch(/^v1\./);
  });

  it("numbers priorities per provider, in the order connections are added", async () => {
    await connect("openai", "a", "sk-a-000001");
    await connect("groq", "g", "gsk-g-000001");
    await connect("openai", "b", "sk-b-000002");
    const list = JSON.parse((await admin("GET", "/connections")).text) as { provider: string; name: string; priority: number }[];
    expect(list.map((c) => [c.provider, c.name, c.priority])).toEqual([
      ["groq", "g", 1],
      ["openai", "a", 1],
      ["openai", "b", 2],
    ]);
  });

  it("rejects an unknown provider, a missing name and an empty key", async () => {
    for (const body of [
      { provider: "nope", name: "x", api_key: "k-12345678" },
      { provider: "openai", name: "", api_key: "k-12345678" },
      { provider: "openai", name: "x", api_key: "" },
      { provider: "openai", name: "x" },
    ]) {
      expect((await admin("POST", "/connections", body)).res.status, JSON.stringify(body)).toBe(400);
    }
    expect(JSON.parse((await admin("GET", "/connections")).text)).toEqual([]);
  });

  it("refuses to store a key while CONNECTIONS_KEY is unset", async () => {
    const r = await admin("POST", "/connections", { provider: "openai", name: "x", api_key: "sk-live-abcd1234" }, { CONNECTIONS_KEY: undefined });
    expect(r.res.status).toBe(500);
    expect(JSON.parse(r.text).error).toBe("not_configured");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM connection").first<number>("n")).toBe(0);
  });

  it("PATCH renames, disables, reorders and replaces the key; DELETE removes", async () => {
    const id = await connect("openai", "a", "sk-a-000001");
    const patched = await admin("PATCH", `/connections/${id}`, { name: "renamed", disabled: true, priority: 5, api_key: "sk-new-00009999" });
    expect(patched.res.status).toBe(200);
    expect(JSON.parse(patched.text)).toMatchObject({ id, name: "renamed", disabled: true, priority: 5, hint: "9999" });
    expect(patched.text).not.toContain("sk-new");

    for (const bad of [{ name: "" }, { disabled: "yes" }, { priority: 0 }, { priority: 1.5 }, { api_key: "" }]) {
      expect((await admin("PATCH", `/connections/${id}`, bad)).res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await admin("PATCH", "/connections/missing", { name: "x" })).res.status).toBe(404);

    expect((await admin("DELETE", `/connections/${id}`)).res.status).toBe(204);
    expect((await admin("DELETE", `/connections/${id}`)).res.status).toBe(404);
  });

  it("PATCH with a new key clears the cooldown and the last error", async () => {
    const id = await connect("openai", "a", "sk-a-000001");
    await env.DB.prepare("UPDATE connection SET cooldown_until = ?, backoff_level = 3, last_error = '401 bad key', last_error_at = 5 WHERE id = ?").bind(now() + 500, id).run();
    const patched = JSON.parse((await admin("PATCH", `/connections/${id}`, { api_key: "sk-fixed-00001111" })).text);
    expect(patched).toMatchObject({ cooldown_until: 0, last_error: null, last_error_at: null });
    expect((await row(id))!.backoff_level).toBe(0);
  });
});

describe("admin: providers and account order", () => {
  it("lists the first six providers first, then the others by id, each with its name and where to get a key", async () => {
    const list = JSON.parse((await admin("GET", "/providers")).text) as { id: string; name: string; format: string; env_key: boolean; key_url: string | null }[];
    expect(list.slice(0, 6).map((p) => p.id)).toEqual(["anthropic", "openai", "gemini", "openrouter", "deepseek", "groq"]);
    const rest = list.slice(6).map((p) => p.id);
    expect(rest).toEqual([...rest].sort());
    expect(list).toHaveLength(74);
    expect(new Set(list.map((p) => p.id)).size).toBe(74);
    expect(list.find((p) => p.id === "anthropic")).toEqual({
      id: "anthropic", name: "Anthropic", format: "anthropic", auth: ["api_key"], env_key: true, key_url: "https://console.anthropic.com/settings/keys", strategy: "fill-first", color: "#D97757", mark: "AN", free_tier: false,
    });
    // vitest.config.ts leaves deepseek out of PROVIDER_KEYS.
    expect(list.find((p) => p.id === "deepseek")).toMatchObject({ name: "DeepSeek", format: "openai", env_key: false });
    expect(list.find((p) => p.id === "openai")).toMatchObject({ env_key: true });
    expect(list.find((p) => p.id === "mistral")).toMatchObject({ name: "Mistral", format: "openai", env_key: false });
    expect(list.find((p) => p.id === "vercel-ai-gateway")).toMatchObject({ name: "Vercel AI Gateway" });
    // A subscription login is told apart by its auth kind.
    expect(list.find((p) => p.id === "codex")).toMatchObject({ name: "OpenAI Codex", format: "codex", auth: ["oauth"] });
    expect((list as unknown as { id: string; auth: string[] }[]).filter((p) => p.auth[0] === "oauth").map((p) => p.id).sort()).toEqual(["antigravity", "claude", "codex", "gemini-cli", "github", "kilocode", "kimi", "minimax-code", "minimax-code-global", "muse", "nous"]);
    expect(list.every((p) => p.key_url === null || p.key_url.startsWith("https://"))).toBe(true);
    // Every provider has a colour and one to three letters for its mark in the console.
    const marks = list as unknown as { id: string; color: string; mark: string }[];
    expect(marks.filter((p) => !/^#[0-9A-Fa-f]{6}$/.test(p.color) || !/^[A-Z0-9]{1,3}$/.test(p.mark)).map((p) => p.id)).toEqual([]);
    expect(marks.find((p) => p.id === "openai")).toMatchObject({ color: "#10A37F", mark: "OA" });
  });

  it("marks the providers that give a key with free use", async () => {
    const list = JSON.parse((await admin("GET", "/providers")).text) as { id: string; free_tier: unknown }[];
    expect(list.every((p) => typeof p.free_tier === "boolean")).toBe(true);
    expect(list.filter((p) => p.free_tier).map((p) => p.id).sort()).toEqual(["api-airforce", "cloudflare-ai", "gemini", "groq", "kimchi", "ollama", "openrouter", "sambanova", "vertex"]);
    expect(list.find((p) => p.id === "anthropic")?.free_tier).toBe(false);
    expect(list.find((p) => p.id === "codex")?.free_tier).toBe(false);
  });

  it("PUT /providers/:id/order renumbers the provider's connections in the given order", async () => {
    const a = await connect("openai", "a", "sk-a-00000001");
    const b = await connect("openai", "b", "sk-b-00000002");
    const c = await connect("openai", "c", "sk-c-00000003");
    const g = await connect("groq", "g", "gsk-g-0000001");
    const r = await admin("PUT", "/providers/openai/order", { ids: [c, a, b] });
    expect(r.res.status).toBe(200);
    expect((JSON.parse(r.text) as { name: string; priority: number }[]).map((x) => [x.name, x.priority])).toEqual([["c", 1], ["a", 2], ["b", 3]]);
    const all = JSON.parse((await admin("GET", "/connections")).text) as { id: string; name: string; priority: number }[];
    expect(all.map((x) => [x.name, x.priority])).toEqual([["g", 1], ["c", 1], ["a", 2], ["b", 3]]);
    expect(all.find((x) => x.id === g)!.priority).toBe(1);
  });

  it("refuses an order that is not exactly the provider's connections", async () => {
    const a = await connect("openai", "a", "sk-a-00000001");
    const b = await connect("openai", "b", "sk-b-00000002");
    const g = await connect("groq", "g", "gsk-g-0000001");
    for (const ids of [[a], [a, b, g], [a, a], [a, "missing"], "nope"]) {
      expect((await admin("PUT", "/providers/openai/order", { ids })).res.status, JSON.stringify(ids)).toBe(400);
    }
    expect((await admin("PUT", "/providers/nope/order", { ids: [] })).res.status).toBe(404);
    const all = JSON.parse((await admin("GET", "/connections")).text) as { name: string; priority: number }[];
    expect(all.filter((x) => x.name !== "g").map((x) => [x.name, x.priority])).toEqual([["a", 1], ["b", 2]]);
  });
});

describe("providers from the registry", () => {
  it("sends a request to the provider's own base URL with the connection's key", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["mistral/*"]);
    await connect("mistral", "main", "mk-000000000001");
    const up = fakeUpstream(() => json(COMPLETION));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, "mistral/mistral-large-latest"));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(bearer(up.calls[0]!)).toBe("Bearer mk-000000000001");
    expect(JSON.parse(up.bodies[0]!).model).toBe("mistral-large-latest");
  });

  it("takes provider ids with hyphens and digits in model names and in allow-lists", async () => {
    const token = await addSystem("chat");
    const patched = await admin("PATCH", "/systems/chat", { allowed_models: ["vercel-ai-gateway/*", "llm7/gpt-x", "kilo-gateway/*"] });
    expect(patched.res.status).toBe(200);
    await connect("vercel-ai-gateway", "main", "vk-000000000001");
    const up = fakeUpstream(() => json(COMPLETION));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, "vercel-ai-gateway/openai/gpt-5"));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(JSON.parse(up.bodies[0]!).model).toBe("openai/gpt-5");
    expect((await admin("PATCH", "/systems/chat", { allowed_models: ["Bad-Id/*"] })).res.status).toBe(400);
  });
});

describe("testing a connection", () => {
  const test = (up: ReturnType<typeof fakeUpstream>, id: string) =>
    call(up, `/admin/connections/${id}/test`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });

  it("asks the provider for its models with the connection's key, and a good answer clears the connection's failure", async () => {
    const a = await connect("openai", "a", "sk-a-00000001");
    await env.DB.prepare("UPDATE connection SET cooldown_until = ?, backoff_level = 2, last_error = '401 old', last_error_at = 5 WHERE id = ?").bind(now() + 500, a).run();
    const up = fakeUpstream(() => json({ object: "list", data: [] }));
    const { res, text } = await test(up, a);
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.method).toBe("GET");
    expect(up.calls[0]!.url).toBe("https://api.openai.com/v1/models");
    expect(bearer(up.calls[0]!)).toBe("Bearer sk-a-00000001");
    expect(await row(a)).toMatchObject({ cooldown_until: 0, backoff_level: 0, last_error: null, last_error_at: null });
  });

  it("says why a key is refused and writes it on the connection, without setting it aside", async () => {
    const a = await connect("groq", "a", "gsk-a-0000001");
    const up = fakeUpstream(() => json({ error: { message: "Invalid API Key", type: "invalid_request_error" } }, 401));
    const { res, text } = await test(up, a);
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: false, status: 401, message: "Invalid API Key" });
    expect(up.calls[0]!.url).toBe("https://api.groq.com/openai/v1/models");
    const r = await row(a);
    expect(r).toMatchObject({ last_error: "401 Invalid API Key", cooldown_until: 0 });
    expect(now() - Number(r!.last_error_at)).toBeLessThanOrEqual(2);
  });

  it("reads a refusal Google wraps in an array", async () => {
    const a = await connect("gemini", "a", "AIza-test-0001");
    const up = fakeUpstream(() => json([{ error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" } }], 400));
    expect(JSON.parse((await test(up, a)).text)).toEqual({ ok: false, status: 400, message: "API key not valid." });
  });

  it("tests an Anthropic key the Anthropic way", async () => {
    const a = await connect("anthropic", "a", "sk-ant-conn-0001");
    const up = fakeUpstream(() => json({ data: [] }));
    expect(JSON.parse((await test(up, a)).text)).toEqual({ ok: true });
    expect(up.calls[0]!.url).toBe("https://upstream.test/v1/models?limit=1");
    expect(up.calls[0]!.headers.get("x-api-key")).toBe("sk-ant-conn-0001");
    expect(up.calls[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(up.calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("reports a provider that cannot be reached, and 404 for an unknown connection", async () => {
    const a = await connect("openai", "a", "sk-a-00000001");
    const down = fakeUpstream(() => {
      throw new Error("network");
    });
    expect(JSON.parse((await test(down, a)).text)).toEqual({ ok: false, status: 502, message: "could not reach openai" });
    expect((await test(fakeUpstream(() => json({})), "missing")).res.status).toBe(404);
  });
});

describe("round robin", () => {
  const keysUsed = async (token: string, n: number) => {
    const up = fakeUpstream(() => json(COMPLETION));
    for (let i = 0; i < n; i++) await call(up, "/openai/v1/chat/completions", chat(token, "openai/gpt-5"));
    return up.calls.map(bearer);
  };

  it("fill-first by default: the first connection every time", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    await connect("openai", "a", "sk-a-00000001");
    await connect("openai", "b", "sk-b-00000002");
    expect(await keysUsed(token, 3)).toEqual(["Bearer sk-a-00000001", "Bearer sk-a-00000001", "Bearer sk-a-00000001"]);
  });

  it("round-robin: the connection that answered longest ago goes first", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    await connect("openai", "a", "sk-a-00000001");
    await connect("openai", "b", "sk-b-00000002");
    await connect("openai", "c", "sk-c-00000003");
    const set = await admin("PUT", "/providers/openai/strategy", { strategy: "round-robin" });
    expect(set.res.status).toBe(200);
    expect(JSON.parse(set.text)).toEqual({ provider: "openai", strategy: "round-robin" });
    expect(await keysUsed(token, 5)).toEqual(["Bearer sk-a-00000001", "Bearer sk-b-00000002", "Bearer sk-c-00000003", "Bearer sk-a-00000001", "Bearer sk-b-00000002"]);
    const list = JSON.parse((await admin("GET", "/providers")).text) as { id: string; strategy: string }[];
    expect(list.find((p) => p.id === "openai")!.strategy).toBe("round-robin");
    expect(list.find((p) => p.id === "groq")!.strategy).toBe("fill-first");
  });

  it("goes back to priority order when set to fill-first, and refuses other values", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    await connect("openai", "a", "sk-a-00000001");
    await connect("openai", "b", "sk-b-00000002");
    await admin("PUT", "/providers/openai/strategy", { strategy: "round-robin" });
    await keysUsed(token, 1);
    await admin("PUT", "/providers/openai/strategy", { strategy: "fill-first" });
    expect(await keysUsed(token, 2)).toEqual(["Bearer sk-a-00000001", "Bearer sk-a-00000001"]);
    for (const bad of [{ strategy: "random" }, { strategy: 1 }, {}]) expect((await admin("PUT", "/providers/openai/strategy", bad)).res.status, JSON.stringify(bad)).toBe(400);
    expect((await admin("PUT", "/providers/nope/strategy", { strategy: "round-robin" })).res.status).toBe(404);
  });
});

describe("routing through connections", () => {
  it("uses the connection's key instead of the provider key in the environment", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    await connect("openai", "work", "sk-conn-00000001");
    const up = fakeUpstream(() => json(COMPLETION));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, "openai/gpt-5"));
    expect(res.status).toBe(200);
    expect(up.calls.map(bearer)).toEqual(["Bearer sk-conn-00000001"]);
  });

  it("makes a provider usable that has no key in the environment", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["deepseek/*"]);
    await connect("deepseek", "main", "sk-deep-00000001");
    const up = fakeUpstream(() => json(COMPLETION));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, "deepseek/deepseek-chat"));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(bearer(up.calls[0]!)).toBe("Bearer sk-deep-00000001");
  });

  it("tries accounts in priority order and skips a disabled one", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const a = await connect("openai", "a", "sk-a-00000001");
    await connect("openai", "b", "sk-b-00000002");
    const up = fakeUpstream(() => json(COMPLETION));
    await call(up, "/openai/v1/chat/completions", chat(token, "openai/gpt-5"));
    await admin("PATCH", `/connections/${a}`, { disabled: true });
    await call(up, "/openai/v1/chat/completions", chat(token, "openai/gpt-5"));
    expect(up.calls.map(bearer)).toEqual(["Bearer sk-a-00000001", "Bearer sk-b-00000002"]);
  });

  it("moves to the next account after a 429, cools the first one down, and later skips it", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const a = await connect("openai", "a", "sk-a-00000001");
    await connect("openai", "b", "sk-b-00000002");
    const up = fakeUpstream((req) =>
      bearer(req) === "Bearer sk-a-00000001" ? json({ error: { message: "slow down", type: "rate_limit_error" } }, 429, { "retry-after": "40" }) : json(COMPLETION),
    );
    const first = await call(up, "/openai/v1/chat/completions", chat(token, "openai/gpt-5"));
    expect(first.res.status).toBe(200);
    expect(up.calls.map(bearer)).toEqual(["Bearer sk-a-00000001", "Bearer sk-b-00000002"]);

    const cooled = await row(a);
    expect(Number(cooled!.cooldown_until) - now()).toBeGreaterThanOrEqual(38);
    expect(Number(cooled!.cooldown_until) - now()).toBeLessThanOrEqual(40);
    expect(cooled!.last_error).toBe("429 slow down");

    const second = await call(up, "/openai/v1/chat/completions", chat(token, "openai/gpt-5"));
    expect(second.res.status).toBe(200);
    expect(up.calls.map(bearer).slice(2)).toEqual(["Bearer sk-b-00000002"]);
    expect((await usageRows("chat")).map((r) => r.status)).toEqual([429, 200, 200]);
  });

  it("moves to the next account when a key is refused (401), and records why", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const a = await connect("openai", "a", "sk-a-00000001");
    await connect("openai", "b", "sk-b-00000002");
    const up = fakeUpstream((req) =>
      bearer(req) === "Bearer sk-a-00000001" ? json({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }, 401) : json(COMPLETION),
    );
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, "openai/gpt-5"));
    expect(res.status).toBe(200);
    expect(up.calls.map(bearer)).toEqual(["Bearer sk-a-00000001", "Bearer sk-b-00000002"]);
    const r = await row(a);
    expect(r!.last_error).toBe("401 Incorrect API key provided");
    expect(Number(r!.cooldown_until)).toBeGreaterThan(now());
  });

  it("without a retry-after, sets an account aside for 30 s, doubling with each failure in a row", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["deepseek/*"]);
    const a = await connect("deepseek", "a", "sk-a-00000001");
    const up = fakeUpstream(() => json({ error: { message: "boom" } }, 503));
    const wait = async () => Number((await row(a))!.cooldown_until) - now();

    await call(up, "/openai/v1/chat/completions", chat(token, "deepseek/deepseek-chat"));
    expect(await wait()).toBeGreaterThanOrEqual(28);
    expect(await wait()).toBeLessThanOrEqual(30);

    await call(up, "/openai/v1/chat/completions", chat(token, "deepseek/deepseek-chat"));
    expect(await wait()).toBeGreaterThanOrEqual(58);
    expect(await wait()).toBeLessThanOrEqual(60);

    await env.DB.prepare("UPDATE connection SET backoff_level = 20 WHERE id = ?").bind(a).run();
    await call(up, "/openai/v1/chat/completions", chat(token, "deepseek/deepseek-chat"));
    expect(await wait()).toBeGreaterThanOrEqual(598);
    expect(await wait()).toBeLessThanOrEqual(600);
  });

  it("does not move to another account on a request error", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const a = await connect("openai", "a", "sk-a-00000001");
    await connect("openai", "b", "sk-b-00000002");
    const up = fakeUpstream(() => json({ error: { message: "bad request", type: "invalid_request_error" } }, 400));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, "openai/gpt-5"));
    expect(res.status).toBe(400);
    expect(up.calls).toHaveLength(1);
    expect((await row(a))!.cooldown_until).toBe(0);
  });

  it("falls back to the key in the environment after every connection has failed", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    await connect("openai", "a", "sk-a-00000001");
    const up = fakeUpstream((req) => (bearer(req) === "Bearer sk-test-openai" ? json(COMPLETION) : json({ error: { message: "down" } }, 503)));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, "openai/gpt-5"));
    expect(res.status).toBe(200);
    expect(up.calls.map(bearer)).toEqual(["Bearer sk-a-00000001", "Bearer sk-test-openai"]);
  });

  it("returns the last failure when every account fails", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["deepseek/*"]);
    await connect("deepseek", "a", "sk-a-00000001");
    await connect("deepseek", "b", "sk-b-00000002");
    const up = fakeUpstream(() => json({ error: { message: "boom", type: "api_error" } }, 503));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, "deepseek/deepseek-chat"));
    expect(res.status).toBe(503);
    expect(JSON.parse(text).error.message).toBe("boom");
    expect(up.calls).toHaveLength(2);
  });

  it("still tries cooling accounts, soonest first, when none is available", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["deepseek/*"]);
    const a = await connect("deepseek", "a", "sk-a-00000001");
    const b = await connect("deepseek", "b", "sk-b-00000002");
    await env.DB.prepare("UPDATE connection SET cooldown_until = ? WHERE id = ?").bind(now() + 300, a).run();
    await env.DB.prepare("UPDATE connection SET cooldown_until = ? WHERE id = ?").bind(now() + 100, b).run();
    const up = fakeUpstream(() => json(COMPLETION));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, "deepseek/deepseek-chat"));
    expect(res.status).toBe(200);
    expect(up.calls.map(bearer)).toEqual(["Bearer sk-b-00000002"]);
  });

  it("a success clears the account's cooldown, backoff and last error, and stamps its last use", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["deepseek/*"]);
    const a = await connect("deepseek", "a", "sk-a-00000001");
    await env.DB.prepare("UPDATE connection SET cooldown_until = ?, backoff_level = 2, last_error = '503 boom', last_error_at = 5 WHERE id = ?").bind(now() - 1, a).run();
    await call(fakeUpstream(() => json(COMPLETION)), "/openai/v1/chat/completions", chat(token, "deepseek/deepseek-chat"));
    const r = await row(a);
    expect(r).toMatchObject({ cooldown_until: 0, backoff_level: 0, last_error: null, last_error_at: null });
    expect(now() - Number(r!.last_used_at)).toBeLessThanOrEqual(2);
  });

  it("skips a connection it cannot decrypt instead of failing the request", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const a = await connect("openai", "a", "sk-a-00000001");
    await env.DB.prepare("UPDATE connection SET secret = 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE id = ?").bind(a).run();
    const up = fakeUpstream(() => json(COMPLETION));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, "openai/gpt-5"));
    expect(res.status).toBe(200);
    expect(up.calls.map(bearer)).toEqual(["Bearer sk-test-openai"]);
  });
});

describe("/anthropic through connections", () => {
  it("sends the connection's key, then the system's own key after a 429", async () => {
    const token = await addSystem("chat");
    const a = await connect("anthropic", "shared", "sk-ant-conn-0001");
    const up = fakeUpstream((req) =>
      req.headers.get("x-api-key") === "sk-ant-conn-0001" ? json({ type: "error", error: { type: "rate_limit_error", message: "slow" } }, 429) : json(MESSAGE),
    );
    const { res, text } = await call(up, "/anthropic/v1/messages", messagesInit(token, { model: "claude-opus-5-5", max_tokens: 8, messages: [] }));
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual(MESSAGE);
    expect(up.calls.map((r) => r.headers.get("x-api-key"))).toEqual(["sk-ant-conn-0001", "sk-ant-test-chat"]);
    expect(up.bodies[1]).toBe(up.bodies[0]);
    expect(Number((await row(a))!.cooldown_until)).toBeGreaterThan(now());
    expect((await usageRows("chat")).map((r) => r.status)).toEqual([429, 200]);
  });

  it("serves a system that has no key of its own once a connection exists", async () => {
    const token = await addSystem("nokey");
    await connect("anthropic", "shared", "sk-ant-conn-0001");
    const up = fakeUpstream(() => json(MESSAGE));
    const { res } = await call(up, "/anthropic/v1/messages", messagesInit(token, { model: "claude-opus-5-5", max_tokens: 8, messages: [] }));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.headers.get("x-api-key")).toBe("sk-ant-conn-0001");
  });

  it("passes the provider's error through unchanged when no other account is left", async () => {
    const token = await addSystem("nokey");
    await connect("anthropic", "shared", "sk-ant-conn-0001");
    const body = { type: "error", error: { type: "overloaded_error", message: "busy" } };
    const up = fakeUpstream(() => json(body, 529));
    const { res, text } = await call(up, "/anthropic/v1/messages", messagesInit(token, { model: "claude-opus-5-5", max_tokens: 8, messages: [] }));
    expect(res.status).toBe(529);
    expect(JSON.parse(text)).toEqual(body);
    expect(up.calls).toHaveLength(1);
  });
});
