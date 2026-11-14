import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseModel } from "../providers";
import { stripMarkers } from "../models";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const chat = (token: string, body: unknown) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const allow = (id: string, patterns: string[] | null) =>
  env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(patterns === null ? null : JSON.stringify(patterns), id).run();

const combo = (name: string, targets: string[]) =>
  env.DB.prepare("INSERT INTO combo (name, targets, updated_at) VALUES (?, ?, 1)").bind(name, JSON.stringify(targets)).run();

/** A connection row the model list counts as active. Its secret is never read by these tests. */
const connection = (provider: string) =>
  env.DB.prepare("INSERT INTO connection (id, provider, auth_type, name, secret, priority, created_at, updated_at) VALUES (?, ?, 'oauth', 'x', 'sealed', 1, 1, 1)")
    .bind(`c-${provider}`, provider)
    .run();

const COMPLETION = {
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

const hi = (model: unknown, extra: Record<string, unknown> = {}) => ({ model, messages: [{ role: "user", content: "hi" }], ...extra });
const sent = (up: FakeUpstream, i = 0) => JSON.parse(up.bodies[i]!) as Record<string, unknown>;
const GROQ = "groq/llama-3.3-70b-versatile";

beforeEach(reset);

describe("model names (FR-MDL-01, 03)", () => {
  it("accepts a provider's short prefix as well as the provider id", () => {
    expect(parseModel("cx/gpt-6-astra")).toEqual({ kind: "target", target: { provider: "codex", model: "gpt-6-astra" } });
    expect(parseModel("qianfan/ernie")).toEqual({ kind: "target", target: { provider: "baidu", model: "ernie" } });
    expect(parseModel("codex/gpt-6-astra")).toEqual({ kind: "target", target: { provider: "codex", model: "gpt-6-astra" } });
  });

  it("strips [1m] and reads the (value) thinking suffix", () => {
    expect(stripMarkers("gpt-6-astra[1m]")).toEqual({ model: "gpt-6-astra", thinking: null });
    expect(stripMarkers("cx/gpt-6.1-sol(high)")).toEqual({ model: "cx/gpt-6.1-sol", thinking: { mode: "level", level: "high" } });
    expect(stripMarkers("m(OFF)")).toEqual({ model: "m", thinking: { mode: "none" } });
    expect(stripMarkers("m(none)")).toEqual({ model: "m", thinking: { mode: "none" } });
    expect(stripMarkers("m(auto)")).toEqual({ model: "m", thinking: { mode: "auto" } });
    expect(stripMarkers("m(4096)")).toEqual({ model: "m", thinking: { mode: "budget", tokens: 4096 } });
    expect(stripMarkers("m[1m](xhigh)")).toEqual({ model: "m", thinking: { mode: "level", level: "xhigh" } });
    expect(stripMarkers("m(nonsense)")).toEqual({ model: "m", thinking: null });
  });
});

describe("routing a model (FR-MDL-02, 03, 05, 13)", () => {
  it("a request without a model is 400 Missing model", async () => {
    const token = await addSystem("chat");
    for (const model of [undefined, ""]) {
      const { res, text } = await call(fakeUpstream(() => json(COMPLETION)), "/openai/v1/chat/completions", chat(token, hi(model)));
      expect(res.status).toBe(400);
      expect(JSON.parse(text).error.message).toBe("Missing model");
    }
  });

  it("a level suffix sets reasoning_effort and is not sent to the provider", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["groq/*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    expect((await call(up, "/openai/v1/chat/completions", chat(token, hi(`${GROQ}(high)`, { reasoning_effort: "low" })))).res.status).toBe(200);
    expect(sent(up)).toMatchObject({ model: "llama-3.3-70b-versatile", reasoning_effort: "high" });
  });

  it("(none) removes reasoning, a budget picks the nearest level, an unknown value is ignored", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["groq/*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    await call(up, "/openai/v1/chat/completions", chat(token, hi(`${GROQ}(none)`, { reasoning_effort: "low" })));
    await call(up, "/openai/v1/chat/completions", chat(token, hi(`${GROQ}(4096)`)));
    await call(up, "/openai/v1/chat/completions", chat(token, hi(`${GROQ}(nonsense)`, { reasoning_effort: "low" })));
    await call(up, "/openai/v1/chat/completions", chat(token, hi(`${GROQ}[1m]`)));
    expect(sent(up, 0).reasoning_effort).toBeUndefined();
    expect(sent(up, 1).reasoning_effort).toBe("medium");
    expect(sent(up, 2)).toMatchObject({ model: "llama-3.3-70b-versatile", reasoning_effort: "low" });
    expect(sent(up, 3).model).toBe("llama-3.3-70b-versatile");
  });

  it("a name without a provider is guessed from its start", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    for (const model of ["gpt-4o", "o3-mini", "mystery-model"]) {
      expect((await call(up, "/openai/v1/chat/completions", chat(token, hi(model)))).res.status, model).toBe(200);
    }
    expect((await call(up, "/openai/v1/chat/completions", chat(token, hi("gemini-4-argon")))).res.status).toBe(200);
    expect((await call(up, "/openai/v1/chat/completions", chat(token, hi("deepseek-v4-pro")))).res.status).toBe(200);
    const hosts = up.calls.map((r) => new URL(r.url).host);
    expect(hosts.slice(0, 3)).toEqual(["api.openai.com", "api.openai.com", "api.openai.com"]);
    expect(hosts[3]).toBe("generativelanguage.googleapis.com");
    expect(hosts[4]).toBe("openrouter.ai");
    expect(sent(up, 4).model).toBe("deepseek-v4-pro");
    // gpt-5.x and gpt-6.x go to the Codex subscription, which has no connection here.
    const codex = await call(up, "/openai/v1/chat/completions", chat(token, hi("gpt-5.5")));
    expect(JSON.parse(codex.text).error.message).toContain("codex");
  });

  it("a bare name is a combo first, then the owner's alias", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    expect((await adminCall(up, "PUT", "/models/aliases", { alias: "fast", model: GROQ })).res.status).toBe(200);
    await call(up, "/openai/v1/chat/completions", chat(token, hi("fast")));
    expect(new URL(up.calls.at(-1)!.url).host).toBe("api.groq.com");
    await combo("fast", ["openai/gpt-5"]);
    await call(up, "/openai/v1/chat/completions", chat(token, hi("fast")));
    expect(new URL(up.calls.at(-1)!.url).host).toBe("api.openai.com");
  });

  it("the alias still needs the system's permission for its target", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    await adminCall(up, "PUT", "/models/aliases", { alias: "fast", model: GROQ });
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, hi("fast")));
    expect(res.status).toBe(403);
  });

  it("a disabled model is refused, and skipped inside a combo (FR-MDL-05)", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    await adminCall(up, "POST", "/models/disabled", { provider: "groq", ids: ["llama-3.3-70b-versatile"] });
    const off = await call(up, "/openai/v1/chat/completions", chat(token, hi(GROQ)));
    expect(off.res.status).toBe(404);
    expect(JSON.parse(off.text).error.code).toBe("model_disabled");
    await combo("mix", [GROQ, "openai/gpt-5"]);
    expect((await call(up, "/openai/v1/chat/completions", chat(token, hi("mix")))).res.status).toBe(200);
    expect(up.calls.map((r) => new URL(r.url).host)).toEqual(["api.openai.com"]);
    await adminCall(up, "DELETE", "/models/disabled?provider=groq&id=llama-3.3-70b-versatile");
    expect((await call(up, "/openai/v1/chat/completions", chat(token, hi(GROQ)))).res.status).toBe(200);
  });
});

describe("provider Thinking setting (FR-MDL-06, 11)", () => {
  it("sets reasoning_effort when the request has none", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    expect((await adminCall(up, "PUT", "/models/thinking", { provider: "openai", mode: "high" })).res.status).toBe(200);
    await call(up, "/openai/v1/chat/completions", chat(token, hi("openai/gpt-5.5")));
    await call(up, "/openai/v1/chat/completions", chat(token, hi("openai/gpt-5.5", { reasoning_effort: "low" })));
    await call(up, "/openai/v1/chat/completions", chat(token, hi(GROQ)));
    expect(sent(up, 0).reasoning_effort).toBe("high");
    expect(sent(up, 1).reasoning_effort).toBe("low");
    expect(sent(up, 2).reasoning_effort).toBeUndefined();
    await adminCall(up, "PUT", "/models/thinking", { provider: "openai", mode: "auto" });
    await call(up, "/openai/v1/chat/completions", chat(token, hi("openai/gpt-5.5")));
    expect(sent(up, 3).reasoning_effort).toBeUndefined();
  });

  it("refuses a mode the provider does not offer", async () => {
    const up = fakeUpstream(() => json({}));
    expect((await adminCall(up, "PUT", "/models/thinking", { provider: "openai", mode: "max" })).res.status).toBe(400);
    expect((await adminCall(up, "PUT", "/models/thinking", { provider: "groq", mode: "high" })).res.status).toBe(400);
  });
});

describe("model admin API (FR-MDL-04, 09, 10, 12)", () => {
  it("answers the expected errors for missing fields", async () => {
    const up = fakeUpstream(() => json({}));
    const err = async (method: string, path: string, body?: unknown) => {
      const r = await adminCall(up, method, path, body);
      expect(r.res.status, `${method} ${path}`).toBe(400);
      return JSON.parse(r.text).error as string;
    };
    expect(await err("PUT", "/models/aliases", { alias: "x" })).toBe("Model and alias required");
    expect(await err("DELETE", "/models/aliases")).toBe("Alias required");
    expect(await err("POST", "/models/disabled", { provider: "groq" })).toBe("provider and ids[] required");
    expect(await err("DELETE", "/models/disabled")).toBe("provider required");
    expect(await err("POST", "/models/custom", { provider: "groq" })).toBe("provider and id required");
    expect(await err("DELETE", "/models/custom?provider=groq")).toBe("provider and id required");
  });

  it("an alias overwrites one of the same name and is listed", async () => {
    const up = fakeUpstream(() => json({}));
    await adminCall(up, "PUT", "/models/aliases", { alias: "fast", model: GROQ });
    await adminCall(up, "PUT", "/models/aliases", { alias: "fast", model: "openai/gpt-5" });
    expect(JSON.parse((await adminCall(up, "GET", "/models/aliases")).text)).toEqual({ aliases: { fast: "openai/gpt-5" } });
    expect((await adminCall(up, "PUT", "/models/aliases", { alias: "bad/name", model: GROQ })).res.status).toBe(400);
    expect((await adminCall(up, "PUT", "/models/aliases", { alias: "x", model: "nope/x" })).res.status).toBe(400);
    await adminCall(up, "DELETE", "/models/aliases?alias=fast");
    expect(JSON.parse((await adminCall(up, "GET", "/models/aliases")).text)).toEqual({ aliases: {} });
  });

  it("the provider's model card: catalog, custom models, disabled flags, thinking", async () => {
    const up = fakeUpstream(() => json({}));
    await adminCall(up, "POST", "/models/custom", { provider: "groq", id: "my-model", name: "Mine" });
    await adminCall(up, "POST", "/models/custom", { provider: "groq", id: "my-model", name: "Mine 2" });
    await adminCall(up, "POST", "/models/disabled", { provider: "groq", ids: ["llama-3.3-70b-versatile"] });
    const card = JSON.parse((await adminCall(up, "GET", "/providers/groq/models")).text);
    expect(card).toMatchObject({ provider: "groq", alias: "groq", thinking: null });
    expect(card.models[0]).toEqual({ id: "my-model", name: "Mine 2", custom: true, disabled: false });
    expect(card.models.find((m: { id: string }) => m.id === "llama-3.3-70b-versatile")).toMatchObject({ custom: false, disabled: true });
    await adminCall(up, "DELETE", "/models/custom?provider=groq&id=my-model");
    await adminCall(up, "DELETE", "/models/disabled?provider=groq");
    const after = JSON.parse((await adminCall(up, "GET", "/providers/groq/models")).text);
    expect(after.models.some((m: { custom: boolean; disabled: boolean }) => m.custom || m.disabled)).toBe(false);

    await adminCall(up, "PUT", "/models/thinking", { provider: "codex", mode: "medium" });
    const cx = JSON.parse((await adminCall(up, "GET", "/providers/codex/models")).text);
    expect(cx).toMatchObject({ alias: "cx", thinking: { options: ["auto", "none", "low", "medium", "high"], mode: "medium" } });
    expect(cx.models.find((m: { id: string }) => m.id === "gpt-6.1-sol").thinking).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect((await adminCall(up, "GET", "/providers/nope/models")).res.status).toBe(404);
  });

  it("tests a model with a short 'hi' and records no usage (FR-MDL-07)", async () => {
    await addSystem("chat");
    const up = fakeUpstream(() => json(COMPLETION));
    const ok = await adminCall(up, "POST", "/models/test", { model: GROQ });
    expect(JSON.parse(ok.text)).toMatchObject({ ok: true });
    expect(sent(up)).toMatchObject({ model: "llama-3.3-70b-versatile", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] });
    up.reply = () => json({ error: { message: "model gone" } }, 404);
    const bad = JSON.parse((await adminCall(up, "POST", "/models/test", { model: GROQ })).text);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("model gone");
    const none = JSON.parse((await adminCall(up, "POST", "/models/test", { model: "mistral/mistral-large-latest" })).text);
    expect(none).toEqual({ ok: false, error: "No active credentials for provider: mistral" });
    expect(await usageRows("chat")).toHaveLength(0);
  });
});

describe("GET /v1/models (FR-MDL-08)", () => {
  const list = async (up: FakeUpstream, token: string) =>
    JSON.parse((await call(up, "/v1/models", { headers: { authorization: `Bearer ${token}` } })).text).data as Record<string, unknown>[];

  it("combos first, then the catalog of providers with a key, minus disabled, plus custom models", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["groq/*", "combo/fast"]);
    await combo("fast", [GROQ]);
    await combo("hidden", [GROQ]);
    const up = fakeUpstream(() => json({ data: [] }));
    await adminCall(up, "POST", "/models/custom", { provider: "groq", id: "my-model" });
    await adminCall(up, "POST", "/models/disabled", { provider: "groq", ids: ["llama-3.3-70b-versatile"] });
    const data = await list(up, token);
    expect(data[0]).toEqual({ id: "combo/fast", object: "model", created: 1, owned_by: "combo" });
    const ids = data.map((m) => m.id);
    expect(ids).toContain("groq/my-model");
    expect(ids).not.toContain(GROQ);
    expect(ids.length).toBeGreaterThan(3);
    expect(ids.every((id) => id === "combo/fast" || String(id).startsWith("groq/"))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names models with the provider's prefix and adds thinking levels and context length", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["codex/*", "baidu/*"]);
    await connection("codex");
    await connection("baidu");
    const data = await list(fakeUpstream(() => json({ data: [] })), token);
    expect(data.find((m) => m.id === "cx/gpt-6.1-sol")).toMatchObject({ owned_by: "cx", thinking_levels: ["low", "medium", "high", "xhigh", "max"] });
    expect(data.find((m) => m.id === "qianfan/deepseek-v4-pro")).toMatchObject({ context_length: 1048576 });
    expect(data.find((m) => m.id === "cx/gpt-6-astra")).not.toHaveProperty("thinking_levels");
  });

  it("lists an alias's target", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["groq/*"]);
    const up = fakeUpstream(() => json({ data: [] }));
    await adminCall(up, "PUT", "/models/aliases", { alias: "fast", model: "groq/not-in-catalog" });
    expect((await list(up, token)).map((m) => m.id)).toContain("groq/not-in-catalog");
  });
});
