import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { makeApp } from "../app";
import { UpstreamTimeout } from "../timeouts";
import { ADMIN_TOKEN, BASE, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

// SRS docs/srs/combo-timeouts.md. One second of a limit lasts 1 ms here (Deps.secondMs), so a 10 s limit waits 10 ms.

const enc = new TextEncoder();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const never = (): Promise<Response> => new Promise(() => {});
const after = (ms: number, res: () => Response) => new Promise<Response>((r) => setTimeout(() => r(res()), ms));
const stalled = (first: string, init: ResponseInit) => new Response(new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(enc.encode(first)) }), init);

const COMPLETION = {
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "gpt-5-2026",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
};
const hi = (model: string, extra: Record<string, unknown> = {}) => ({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }], ...extra });
const chat = (token: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

const allow = (id: string, patterns: string[]) => env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(patterns), id).run();
const combo = (name: string, targets: string[], timeouts: Record<string, number> | null = null) =>
  env.DB.prepare("INSERT INTO combo (name, targets, updated_at, timeouts) VALUES (?, ?, 1, ?)")
    .bind(name, JSON.stringify(targets), timeouts ? JSON.stringify(timeouts) : null)
    .run();
const limits = (v: { first_byte_s: number; idle_s: number }) =>
  env.DB.prepare("INSERT INTO setting (key, value, updated_at) VALUES ('timeouts', ?, 1) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(v)).run();
const isGroq = (req: Request) => req.url.startsWith("https://api.groq.com");

async function run(up: FakeUpstream, path: string, init?: RequestInit): Promise<{ res: Response; text: string | null; error: unknown }> {
  const app = makeApp({ upstream: up.fn, secondMs: 1 });
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(BASE + path, init), env, ctx);
  let text: string | null = null;
  let error: unknown = null;
  try {
    text = await res.text();
  } catch (e) {
    error = e;
  }
  await waitOnExecutionContext(ctx);
  return { res, text, error };
}

const admin = (method: string, path: string, body?: unknown) =>
  call(fakeUpstream(() => json({})), `/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const listed = async (name: string) => (JSON.parse((await admin("GET", "/combos")).text) as { name: string; timeouts: unknown; strategy: unknown }[]).find((c) => c.name === name);

beforeEach(reset);

describe("routing (FR-CTO-02..05)", () => {
  async function setup() {
    const token = await addSystem("chat");
    await allow("chat", ["combo/*", "groq/*"]);
    return token;
  }

  it("a combo's first byte applies when the gateway one is off", async () => {
    await limits({ first_byte_s: 0, idle_s: 0 });
    const token = await setup();
    await combo("fast", ["groq/llama", "openai/gpt-5"], { first_byte_s: 10 });
    const up = fakeUpstream((req) => (isGroq(req) ? never() : json(COMPLETION)));
    const { res } = await run(up, "/openai/v1/chat/completions", chat(token, hi("combo/fast")));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-target")).toBe("openai/gpt-5");
    expect(up.calls[0]!.signal.aborted).toBe(true);
    expect((await usageRows("chat")).map((r) => [r.provider, r.status])).toEqual([["groq", 504], ["openai", 200]]);
  });

  it("a combo's 0 turns the gateway limit off", async () => {
    await limits({ first_byte_s: 10, idle_s: 0 });
    const token = await setup();
    await combo("slow", ["groq/llama", "openai/gpt-5"], { first_byte_s: 0 });
    const up = fakeUpstream((req) => (isGroq(req) ? after(40, () => json(COMPLETION)) : json(COMPLETION)));
    const { res } = await run(up, "/openai/v1/chat/completions", chat(token, hi("combo/slow")));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-target")).toBe("groq/llama");
  });

  it("a limit the combo leaves unset follows the gateway", async () => {
    await limits({ first_byte_s: 0, idle_s: 10 });
    const token = await setup();
    await combo("fast", ["groq/llama"], { first_byte_s: 20 });
    const chunk = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "llama", choices: [{ index: 0, delta: { content: "he" } }] })}\n\n`;
    const up = fakeUpstream(() => stalled(chunk, { headers: { "content-type": "text/event-stream" } }));
    const { res, error } = await run(up, "/openai/v1/chat/completions", chat(token, hi("combo/fast", { stream: true })));
    expect(res.status).toBe(200);
    expect(error).toBeInstanceOf(UpstreamTimeout);
    expect((error as UpstreamTimeout).seconds).toBe(10);
  });

  it("only the called combo's limits apply, not a nested one's (FR-CTO-03)", async () => {
    await limits({ first_byte_s: 10, idle_s: 0 });
    const token = await setup();
    await combo("inner", ["groq/llama", "openai/gpt-5"], { first_byte_s: 0 });
    await combo("outer", ["combo/inner"]);
    const up = fakeUpstream((req) => (isGroq(req) ? after(40, () => json(COMPLETION)) : json(COMPLETION)));
    const { res } = await run(up, "/openai/v1/chat/completions", chat(token, hi("combo/outer")));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-target")).toBe("openai/gpt-5");
  });

  it("a provider/model request ignores every combo's limits (FR-CTO-04)", async () => {
    await limits({ first_byte_s: 0, idle_s: 0 });
    const token = await setup();
    await combo("fast", ["groq/llama"], { first_byte_s: 10 });
    const up = fakeUpstream(() => after(40, () => json(COMPLETION)));
    expect((await run(up, "/openai/v1/chat/completions", chat(token, hi("groq/llama")))).res.status).toBe(200);
  });

  it("the log line gives the combo's limit (FR-CTO-05)", async () => {
    await limits({ first_byte_s: 0, idle_s: 0 });
    const token = await setup();
    await combo("fast", ["groq/llama", "openai/gpt-5"], { first_byte_s: 12 });
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (s: string) => void lines.push(s);
    try {
      await run(fakeUpstream((req) => (isGroq(req) ? never() : json(COMPLETION))), "/openai/v1/chat/completions", chat(token, hi("combo/fast")));
    } finally {
      console.warn = warn;
    }
    expect(lines.map((l) => JSON.parse(l))).toContainEqual({ level: "warn", event: "upstream_timeout", kind: "first_byte", host: "api.groq.com", seconds: 12 });
  });
});

describe("admin API (FR-CTO-06..09)", () => {
  const targets = ["openai/gpt-5"];

  it("GET gives null for a combo without timeouts", async () => {
    await combo("plain", targets);
    expect((await listed("plain"))?.timeouts).toBeNull();
  });

  it("POST saves only the set fields; PUT without timeouts keeps them; null clears them", async () => {
    const created = await admin("POST", "/combos", { name: "fast", targets, timeouts: { first_byte_s: 20, idle_s: null } });
    expect(created.res.status, created.text).toBe(201);
    expect(JSON.parse(created.text).timeouts).toEqual({ first_byte_s: 20 });
    expect((await listed("fast"))?.timeouts).toEqual({ first_byte_s: 20 });

    expect((await admin("PUT", "/combos/fast", { targets: ["openai/gpt-5", "groq/llama"] })).res.status).toBe(200);
    expect((await listed("fast"))?.timeouts).toEqual({ first_byte_s: 20 });

    const replaced = await admin("PUT", "/combos/fast", { targets, timeouts: { idle_s: 0 } });
    expect(JSON.parse(replaced.text).timeouts).toEqual({ idle_s: 0 });

    expect((await admin("PUT", "/combos/fast", { targets, timeouts: null })).res.status).toBe(200);
    expect((await listed("fast"))?.timeouts).toBeNull();

    expect((await admin("PUT", "/combos/fast", { targets, timeouts: {} })).res.status).toBe(200);
    expect((await listed("fast"))?.timeouts).toBeNull();
  });

  it("refuses a bad value and saves nothing", async () => {
    await admin("POST", "/combos", { name: "fast", targets, timeouts: { first_byte_s: 30 } });
    for (const timeouts of [{ idle_s: 5 }, { idle_s: 3601 }, { idle_s: 1.5 }, { idle_s: "60" }, { other: 10 }, [], "60"]) {
      const r = await admin("PUT", "/combos/fast", { targets, timeouts });
      expect(r.res.status, JSON.stringify(timeouts)).toBe(400);
      expect(JSON.parse(r.text)).toMatchObject({ error: "invalid_input", hint: expect.stringContaining("timeouts") });
    }
    expect((await admin("POST", "/combos", { name: "other", targets, timeouts: { first_byte_s: 9 } })).res.status).toBe(400);
    expect((await listed("fast"))?.timeouts).toEqual({ first_byte_s: 30 });
    expect(await listed("other")).toBeUndefined();
  });

  it("a strategy change and a rename keep the timeouts (FR-CTO-08)", async () => {
    await admin("POST", "/combos", { name: "fast", targets, strategy: "round-robin", timeouts: { first_byte_s: 30 } });
    expect((await admin("PUT", "/combos/fast", { targets, strategy: "fallback" })).res.status).toBe(200);
    expect(await listed("fast")).toMatchObject({ strategy: "fallback", timeouts: { first_byte_s: 30 } });
    expect((await admin("PUT", "/combos/fast", { targets, name: "quick" })).res.status).toBe(200);
    expect((await listed("quick"))?.timeouts).toEqual({ first_byte_s: 30 });
  });

  it("a saved change applies from the next request (FR-CTO-09)", async () => {
    await limits({ first_byte_s: 0, idle_s: 0 });
    const token = await addSystem("chat");
    await allow("chat", ["combo/*"]);
    await admin("POST", "/combos", { name: "fast", targets: ["groq/llama", "openai/gpt-5"] });
    const slowGroq = () => fakeUpstream((req) => (isGroq(req) ? after(40, () => json(COMPLETION)) : json(COMPLETION)));
    expect((await run(slowGroq(), "/openai/v1/chat/completions", chat(token, hi("combo/fast")))).res.headers.get("x-gateway-target")).toBe("groq/llama");
    await admin("PUT", "/combos/fast", { targets: ["groq/llama", "openai/gpt-5"], timeouts: { first_byte_s: 10 } });
    expect((await run(slowGroq(), "/openai/v1/chat/completions", chat(token, hi("combo/fast")))).res.headers.get("x-gateway-target")).toBe("openai/gpt-5");
  });
});

describe("backup (FR-CTO-12)", () => {
  it("a backup carries the timeouts and an import restores them", async () => {
    await combo("fast", ["openai/gpt-5"], { first_byte_s: 30, idle_s: 0 });
    const exported = JSON.parse((await admin("GET", "/backup")).text) as { tables: Record<string, unknown[]> };
    await env.DB.prepare("DELETE FROM combo").run();
    const imported = await admin("POST", "/backup", { version: 1, tables: { combo: exported.tables.combo } });
    expect(imported.res.status, imported.text).toBe(200);
    expect((await listed("fast"))?.timeouts).toEqual({ first_byte_s: 30, idle_s: 0 });
  });

  it("an older backup without the column still imports", async () => {
    const r = await admin("POST", "/backup", { version: 1, tables: { combo: [{ name: "old", targets: '["openai/gpt-5"]', updated_at: 1 }] } });
    expect(r.res.status, r.text).toBe(200);
    expect((await listed("old"))?.timeouts).toBeNull();
  });
});
