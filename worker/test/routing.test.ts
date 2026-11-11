import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { allows, parseModel } from "../providers";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, messagesInit, reset, usageRows } from "./helpers";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const chat = (token: string, body: unknown) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

const allow = (id: string, patterns: string[] | null) =>
  env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(patterns === null ? null : JSON.stringify(patterns), id).run();

const combo = (name: string, targets: string[]) =>
  env.DB.prepare("INSERT INTO combo (name, targets, updated_at) VALUES (?, ?, 1)").bind(name, JSON.stringify(targets)).run();

const COMPLETION = {
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "gpt-5-2026",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 } },
};

const hi = (model: string, extra: Record<string, unknown> = {}) => ({ model, messages: [{ role: "user", content: "hi" }], ...extra });

beforeEach(reset);

describe("model names and allow-list", () => {
  it("parses claude-*, provider/model (with slashes) and combo/name", () => {
    expect(parseModel("claude-opus-5-5")).toEqual({ kind: "target", target: { provider: "anthropic", model: "claude-opus-5-5" } });
    expect(parseModel("openrouter/meta-llama/llama-4")).toEqual({ kind: "target", target: { provider: "openrouter", model: "meta-llama/llama-4" } });
    expect(parseModel("combo/fast")).toEqual({ kind: "combo", name: "fast" });
    for (const bad of ["gpt-5", "nope/x", "openai/", "combo/Bad Name", "", 7]) expect(parseModel(bad), String(bad)).toBeNull();
  });

  it("matches exact names, provider/* and *", () => {
    expect(allows(["openai/*"], "openai/gpt-5")).toBe(true);
    expect(allows(["openai/*"], "openrouter/x")).toBe(false);
    expect(allows(["openai/gpt-5"], "openai/gpt-5-mini")).toBe(false);
    expect(allows(["*"], "combo/fast")).toBe(true);
  });

  it("a system with no allow-list keeps Claude only", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(() => json(COMPLETION));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, hi("openai/gpt-5")));
    expect(res.status).toBe(403);
    expect(JSON.parse(text).error.code).toBe("model_not_allowed");
    expect(up.calls).toHaveLength(0);
  });

  it("an unknown model name is a 404 model_not_found", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["*"]);
    const { res, text } = await call(fakeUpstream(() => json({})), "/openai/v1/chat/completions", chat(token, hi("gpt-5")));
    expect(res.status).toBe(404);
    expect(JSON.parse(text).error.code).toBe("model_not_found");
  });

  it("/anthropic refuses other providers and Claude models outside the allow-list", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(() => json({}));
    expect((await call(up, "/anthropic/v1/messages", messagesInit(token, hi("openai/gpt-5")))).res.status).toBe(404);
    await allow("chat", ["anthropic/claude-haiku-5-5"]);
    expect((await call(up, "/anthropic/v1/messages", messagesInit(token, hi("claude-opus-5-5")))).res.status).toBe(403);
    expect(up.calls).toHaveLength(0);
  });
});

describe("OpenAI-compatible providers", () => {
  it("forwards to the provider with its key and the bare model name, and meters the reply", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, hi("openai/gpt-5", { temperature: 0.2, user: "u1" })));
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual(COMPLETION);
    const sent = up.calls[0]!;
    expect(sent.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe("Bearer sk-test-openai");
    expect(JSON.parse(up.bodies[0]!)).toEqual(hi("gpt-5", { temperature: 0.2, user: "u1" }));
    expect(await usageRows("chat")).toEqual([
      expect.objectContaining({ provider: "openai", model: "gpt-5-2026", input_tokens: 15, output_tokens: 4, cache_read_input_tokens: 5 }),
    ]);
  });

  it("keeps the slashes of OpenRouter models", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openrouter/*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    await call(up, "/openai/v1/chat/completions", chat(token, hi("openrouter/meta-llama/llama-4")));
    expect(up.calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(up.bodies[0]!).model).toBe("meta-llama/llama-4");
  });

  it("streams: always asks upstream for usage, hides it from a client that did not ask", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["groq/*"]);
    const chunks = [
      { id: "c", object: "chat.completion.chunk", model: "llama", choices: [{ index: 0, delta: { content: "he" } }] },
      { id: "c", object: "chat.completion.chunk", model: "llama", choices: [{ index: 0, delta: { content: "llo" }, finish_reason: "stop" }] },
      { id: "c", object: "chat.completion.chunk", model: "llama", choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } },
    ];
    const sseBody = chunks.map((ch) => `data: ${JSON.stringify(ch)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
    const up = fakeUpstream(() => new Response(sseBody, { headers: { "content-type": "text/event-stream" } }));
    const { text } = await call(up, "/openai/v1/chat/completions", chat(token, hi("groq/llama", { stream: true })));
    expect(JSON.parse(up.bodies[0]!).stream_options).toEqual({ include_usage: true });
    expect(text).not.toContain('"usage"');
    expect(text).toContain('"content":"he"');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "groq", streamed: 1, input_tokens: 9, output_tokens: 2 })]);

    const again = await call(fakeUpstream(() => new Response(sseBody, { headers: { "content-type": "text/event-stream" } })), "/openai/v1/chat/completions",
      chat(token, hi("groq/llama", { stream: true, stream_options: { include_usage: true } })));
    expect(again.text).toContain('"usage"');
  });

  it("a provider without a key is not_configured", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["deepseek/*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, hi("deepseek/deepseek-chat")));
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error.code).toBe("not_configured");
    expect(up.calls).toHaveLength(0);
  });

  it("passes a provider error on with its status, without upstream headers", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json({ error: { message: "bad model", type: "invalid_request_error", code: "model_not_found" } }, 404, { "set-cookie": "x=1" }));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, hi("openai/nope")));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(JSON.parse(text).error).toMatchObject({ message: "bad model", code: "model_not_found" });
  });
});

describe("combos", () => {
  it("falls back after a 429, cools that target down, and later skips it", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["combo/fast"]); // the combo name is enough; its targets need no separate entry
    await combo("fast", ["groq/llama", "openai/gpt-5"]);
    const up = fakeUpstream((req) =>
      req.url.startsWith("https://api.groq.com") ? json({ error: { message: "slow down", type: "rate_limit" } }, 429, { "retry-after": "20" }) : json(COMPLETION),
    );
    const first = await call(up, "/openai/v1/chat/completions", chat(token, hi("combo/fast")));
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get("x-gateway-target")).toBe("openai/gpt-5");
    expect(up.calls.map((r) => new URL(r.url).host)).toEqual(["api.groq.com", "api.openai.com"]);
    const cd = await env.DB.prepare("SELECT until FROM cooldown WHERE target = 'groq/llama'").first<number>("until");
    expect(cd! - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(18);

    const up2 = fakeUpstream(() => json(COMPLETION));
    await call(up2, "/openai/v1/chat/completions", chat(token, hi("combo/fast")));
    expect(up2.calls.map((r) => new URL(r.url).host)).toEqual(["api.openai.com"]);
    expect((await usageRows("chat")).map((r) => [r.provider, r.status])).toEqual([["groq", 429], ["openai", 200], ["openai", 200]]);
  });

  it("does not fall back on a request error, and skips a target without a key", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["combo/*"]);
    await combo("strict", ["openai/gpt-5", "groq/llama"]);
    const up = fakeUpstream(() => json({ error: { message: "bad", type: "invalid_request_error" } }, 400));
    const r1 = await call(up, "/openai/v1/chat/completions", chat(token, hi("combo/strict")));
    expect(r1.res.status).toBe(400);
    expect(up.calls).toHaveLength(1);

    await combo("keyless", ["deepseek/deepseek-chat", "openai/gpt-5"]);
    const up2 = fakeUpstream(() => json(COMPLETION));
    const r2 = await call(up2, "/openai/v1/chat/completions", chat(token, hi("combo/keyless")));
    expect(r2.res.status).toBe(200);
    expect(up2.calls.map((r) => new URL(r.url).host)).toEqual(["api.openai.com"]);
  });

  it("returns the last failure when every target fails, and 404 for an unknown combo", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["*"]);
    await combo("down", ["groq/a", "openai/b"]);
    const up = fakeUpstream(() => json({ error: { message: "boom" } }, 503));
    const r = await call(up, "/openai/v1/chat/completions", chat(token, hi("combo/down")));
    expect(r.res.status).toBe(503);
    expect(up.calls).toHaveLength(2);
    expect((await call(up, "/openai/v1/chat/completions", chat(token, hi("combo/missing")))).res.status).toBe(404);
  });
});

describe("admin allow-list and model list", () => {
  const admin = (method: string, path: string, body?: unknown) =>
    call(fakeUpstream(() => json({})), `/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("PATCH validates and saves allowed_models; null resets to Claude only", async () => {
    await addSystem("chat");
    const ok = await admin("PATCH", "/systems/chat", { allowed_models: ["openai/*", "combo/fast", "openai/*"] });
    expect(JSON.parse(ok.text).allowed_models).toBe('["openai/*","combo/fast"]');
    for (const bad of [["Openai/*"], ["openai"], "openai/*", [1]]) {
      expect((await admin("PATCH", "/systems/chat", { allowed_models: bad })).res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(JSON.parse((await admin("PATCH", "/systems/chat", { allowed_models: null })).text).allowed_models).toBeNull();
  });

  it("creates, lists, replaces and deletes combos, and validates them", async () => {
    expect((await admin("PUT", "/combos/fast", { targets: ["groq/llama", "claude-haiku-5-5"] })).res.status).toBe(200);
    expect((await admin("PUT", "/combos/fast", { targets: ["openai/gpt-5"] })).res.status).toBe(200);
    expect(JSON.parse((await admin("GET", "/combos")).text)).toEqual([expect.objectContaining({ name: "fast", targets: ["openai/gpt-5"] })]);
    for (const [name, body] of [["Bad", { targets: ["openai/x"] }], ["ok", { targets: [] }], ["ok", { targets: ["combo/other"] }], ["ok", { targets: ["gpt-5"] }]] as const) {
      expect((await admin("PUT", `/combos/${name}`, body)).res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await admin("DELETE", "/combos/fast")).res.status).toBe(204);
    expect((await admin("DELETE", "/combos/fast")).res.status).toBe(404);
  });

  it("/openai/v1/models lists allowed Claude models, combos and exact entries", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["anthropic/*", "combo/fast", "openai/gpt-5", "groq/*"]);
    await combo("fast", ["openai/gpt-5"]);
    await combo("hidden", ["openai/gpt-5"]);
    const up = fakeUpstream(() => json({ data: [{ id: "claude-opus-5-5", created_at: "2026-09-01T00:00:00Z" }] }));
    const ids = JSON.parse((await call(up, "/openai/v1/models", { headers: { authorization: `Bearer ${token}` } })).text).data.map((m: { id: string }) => m.id);
    expect(ids).toEqual(["claude-opus-5-5", "combo/fast", "openai/gpt-5"]);
  });
});
