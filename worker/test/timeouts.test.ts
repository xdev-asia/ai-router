import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApp } from "../app";
import { runWithDeadlines, UpstreamTimeout, withDeadlines } from "../timeouts";
import { ADMIN_TOKEN, BASE, addSystem, fakeUpstream, messagesInit, reset, sse, usageRows, type FakeUpstream } from "./helpers";

// SRS docs/srs/upstream-timeouts.md. One second of a setting lasts 1 ms here (Deps.secondMs), so a 10 s limit waits 10 ms.

const enc = new TextEncoder();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A provider that takes the request and never answers. */
const never = (): Promise<Response> => new Promise(() => {});
/** A provider that answers after `ms`. */
const after = (ms: number, res: () => Response) => new Promise<Response>((r) => setTimeout(() => r(res()), ms));
/** A body that sends `first` and then nothing, without ending. */
const stalled = (first: string, init: ResponseInit) => new Response(new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(enc.encode(first)) }), init);

const COMPLETION = {
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "gpt-5-2026",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
};
const MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 2, output_tokens: 1 } };
const hi = (model: string, extra: Record<string, unknown> = {}) => ({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }], ...extra });
const chat = (token: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const admin = (method: string, body?: unknown, token = ADMIN_TOKEN): RequestInit => ({
  method,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const allow = (id: string, patterns: string[]) => env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(patterns), id).run();
const combo = (name: string, targets: string[]) => env.DB.prepare("INSERT INTO combo (name, targets, updated_at) VALUES (?, ?, 1)").bind(name, JSON.stringify(targets)).run();
const limits = (v: { first_byte_s: number; idle_s: number }) =>
  env.DB.prepare("INSERT INTO setting (key, value, updated_at) VALUES ('timeouts', ?, 1) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(v)).run();
const bearer = (r: Request) => r.headers.get("authorization");

/** One request through the app with 1 ms seconds. A body that fails to read gives `error` instead of `text`. */
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

async function connect(provider: string, name: string, apiKey: string): Promise<string> {
  const r = await run(fakeUpstream(() => json({})), "/admin/connections", admin("POST", { provider, name, api_key: apiKey }));
  expect(r.res.status, r.text ?? "").toBe(201);
  return (JSON.parse(r.text!) as { id: string }).id;
}

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

describe("first byte (FR-TMO-01, 03, 04)", () => {
  it("answers 504 naming the host only, and aborts the provider request", async () => {
    await limits({ first_byte_s: 10, idle_s: 0 });
    const token = await addSystem("chat");
    const up = fakeUpstream(never);
    const { res, text } = await run(up, "/anthropic/v1/messages?beta=true", messagesInit(token, hi("claude-opus-5-5")));
    expect(res.status).toBe(504);
    expect(res.headers.get("x-gateway-timeout")).toBe("first_byte");
    expect(JSON.parse(text!)).toEqual({ type: "error", error: { type: "api_error", message: "upstream.test did not answer within 10 s" } });
    expect(text).not.toContain("/v1/messages");
    expect(text).not.toContain("sk-ant");
    expect(up.calls[0]!.signal.aborted).toBe(true);
  });

  it("moves to the next account and cools the silent one down", async () => {
    await limits({ first_byte_s: 10, idle_s: 0 });
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const a = await connect("openai", "a", "sk-a-00000001");
    await connect("openai", "b", "sk-b-00000002");
    const up = fakeUpstream((req) => (bearer(req) === "Bearer sk-a-00000001" ? never() : json(COMPLETION)));
    const { res } = await run(up, "/openai/v1/chat/completions", chat(token, hi("openai/gpt-5")));
    expect(res.status).toBe(200);
    expect(up.calls.map(bearer)).toEqual(["Bearer sk-a-00000001", "Bearer sk-b-00000002"]);
    const row = await env.DB.prepare("SELECT cooldown_until, last_error FROM connection WHERE id = ?").bind(a).first<{ cooldown_until: number; last_error: string }>();
    expect(row!.cooldown_until).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(row!.last_error).toContain("504");
  });

  it("moves a combo to its next target", async () => {
    await limits({ first_byte_s: 10, idle_s: 0 });
    const token = await addSystem("chat");
    await allow("chat", ["combo/fast"]);
    await combo("fast", ["groq/llama", "openai/gpt-5"]);
    const up = fakeUpstream((req) => (req.url.startsWith("https://api.groq.com") ? never() : json(COMPLETION)));
    const { res } = await run(up, "/openai/v1/chat/completions", chat(token, hi("combo/fast")));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-target")).toBe("openai/gpt-5");
    expect((await usageRows("chat")).map((r) => [r.provider, r.status])).toEqual([["groq", 504], ["openai", 200]]);
  });

  it("waits without a deadline when the limit is 0", async () => {
    const token = await addSystem("chat");
    await limits({ first_byte_s: 10, idle_s: 0 });
    expect((await run(fakeUpstream(() => after(40, () => json(MESSAGE))), "/anthropic/v1/messages", messagesInit(token, hi("claude-opus-5-5")))).res.status).toBe(504);
    await limits({ first_byte_s: 0, idle_s: 0 });
    expect((await run(fakeUpstream(() => after(40, () => json(MESSAGE))), "/anthropic/v1/messages", messagesInit(token, hi("claude-opus-5-5")))).res.status).toBe(200);
  });
});

describe("idle (FR-TMO-02, 05, 06, 07)", () => {
  it("a non-streamed chat body that stalls moves the combo to its next target", async () => {
    await limits({ first_byte_s: 0, idle_s: 10 });
    const token = await addSystem("chat");
    await allow("chat", ["combo/fast"]);
    await combo("fast", ["groq/llama", "openai/gpt-5"]);
    const up = fakeUpstream((req) =>
      req.url.startsWith("https://api.groq.com") ? stalled('{"id":"chatcmpl-x","choices":[', { headers: { "content-type": "application/json" } }) : json(COMPLETION),
    );
    const { res, text } = await run(up, "/openai/v1/chat/completions", chat(token, hi("combo/fast")));
    expect(res.status).toBe(200);
    expect(JSON.parse(text!).choices[0].message.content).toBe("hello");
    expect(up.calls[0]!.signal.aborted).toBe(true);
  });

  it("ends a stalled Anthropic stream with an error and still writes the usage read so far", async () => {
    await limits({ first_byte_s: 0, idle_s: 10 });
    const token = await addSystem("chat");
    const start = sse([{ type: "message_start", message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 9, output_tokens: 1 } } }]);
    const up = fakeUpstream(() => stalled(start, { headers: { "content-type": "text/event-stream" } }));
    const { res, error } = await run(up, "/anthropic/v1/messages", messagesInit(token, hi("claude-opus-5-5", { stream: true })));
    expect(res.status).toBe(200);
    expect(error).toBeInstanceOf(UpstreamTimeout);
    expect(up.calls[0]!.signal.aborted).toBe(true);
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ streamed: 1, input_tokens: 9 })]);
  });

  it("ends a stalled chat stream with an error and still writes its usage row", async () => {
    await limits({ first_byte_s: 0, idle_s: 10 });
    const token = await addSystem("chat");
    await allow("chat", ["groq/*"]);
    const chunk = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "llama", choices: [{ index: 0, delta: { content: "he" } }] })}\n\n`;
    const up = fakeUpstream(() => stalled(chunk, { headers: { "content-type": "text/event-stream" } }));
    const { res, error } = await run(up, "/openai/v1/chat/completions", chat(token, hi("groq/llama", { stream: true })));
    expect(res.status).toBe(200);
    expect(error).toBeInstanceOf(UpstreamTimeout);
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "groq", streamed: 1 })]);
  });
});

describe("in time (NFR-TMO-02)", () => {
  it("passes an answer through unchanged", async () => {
    await limits({ first_byte_s: 50, idle_s: 50 });
    const token = await addSystem("chat");
    const body = sse([
      { type: "message_start", message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 3, output_tokens: 1 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);
    const up = fakeUpstream(() => new Response(body, { headers: { "content-type": "text/event-stream", "request-id": "req_1" } }));
    const { res, text } = await run(up, "/anthropic/v1/messages", messagesInit(token, hi("claude-opus-5-5", { stream: true })));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-timeout")).toBeNull();
    expect(text).toBe(body);
    expect(up.calls[0]!.signal.aborted).toBe(false);
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ input_tokens: 3, output_tokens: 2 })]);
  });
});

describe("withDeadlines (FR-TMO-03, 11, 12)", () => {
  it("does nothing with both limits off", async () => {
    const res = new Response("x");
    const f = withDeadlines(async () => res);
    expect(await runWithDeadlines({ first_byte_s: 0, idle_s: 0 }, 1, () => f(new Request("https://p.test/")))).toBe(res);
  });

  it("keeps the method, headers and body of the request", async () => {
    let seen: Request | null = null;
    const f = withDeadlines(async (req) => ((seen = req), new Response("ok")));
    await runWithDeadlines({ first_byte_s: 50, idle_s: 50 }, 1, () =>
      f(new Request("https://p.test/a", { method: "POST", headers: { "x-k": "v" }, body: "payload" })),
    );
    expect(seen!.method).toBe("POST");
    expect(seen!.headers.get("x-k")).toBe("v");
    expect(await seen!.text()).toBe("payload");
  });

  it("still stops at the caller's own signal", async () => {
    const f = withDeadlines(
      (req) =>
        new Promise<Response>((_, reject) => {
          req.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const t0 = Date.now();
    await expect(
      runWithDeadlines({ first_byte_s: 3600, idle_s: 3600 }, 1000, () => f(new Request("https://p.test/", { signal: AbortSignal.timeout(20) }))),
    ).rejects.toThrow("aborted");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("logs one line per timeout with the kind, host and seconds, and no path or query", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = withDeadlines(never);
    const res = await runWithDeadlines({ first_byte_s: 10, idle_s: 0 }, 1, () => f(new Request("https://gen.test/v1beta/models/x:generate?key=secret-key")));
    expect(res.status).toBe(504);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({ level: "warn", event: "upstream_timeout", kind: "first_byte", host: "gen.test", seconds: 10 });
    expect(line + (await res.text())).not.toMatch(/secret-key|v1beta/);
  });

  it("does not count a slow client reader against the provider", async () => {
    const f = withDeadlines(async () => new Response(new ReadableStream({ start: (c) => (c.enqueue(enc.encode("a")), c.enqueue(enc.encode("b")), c.close()) })));
    const res = await runWithDeadlines({ first_byte_s: 0, idle_s: 10 }, 1, () => f(new Request("https://p.test/")));
    const reader = res.body!.getReader();
    await reader.read();
    await new Promise((r) => setTimeout(r, 40));
    const rest: string[] = [];
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest.push(new TextDecoder().decode(r.value));
    expect(rest.join("")).toBe("b");
  });
});

describe("/admin/timeouts (FR-TMO-08, 09, 10)", () => {
  it("returns the defaults, saves a partial change, and refuses bad values", async () => {
    const up = fakeUpstream(() => json({}));
    expect((await run(up, "/admin/timeouts")).res.status).toBe(401);
    expect(JSON.parse((await run(up, "/admin/timeouts", admin("GET"))).text!)).toEqual({ first_byte_s: 300, idle_s: 300 });

    const saved = await run(up, "/admin/timeouts", admin("PUT", { idle_s: 60 }));
    expect(saved.res.status).toBe(200);
    expect(JSON.parse(saved.text!)).toEqual({ first_byte_s: 300, idle_s: 60 });
    expect((await run(up, "/admin/timeouts", admin("PUT", { first_byte_s: 0 }))).res.status).toBe(200);

    for (const bad of [{ idle_s: 5 }, { idle_s: 3601 }, { idle_s: 1.5 }, { idle_s: "300" }, { first_byte_s: -1 }]) {
      const r = await run(up, "/admin/timeouts", admin("PUT", bad));
      expect(r.res.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.parse(r.text!)).toMatchObject({ error: "invalid_input", hint: expect.stringContaining("3600") });
    }
    expect(JSON.parse((await run(up, "/admin/timeouts", admin("GET"))).text!)).toEqual({ first_byte_s: 0, idle_s: 60 });
  });

  it("a saved limit applies on the next request", async () => {
    const token = await addSystem("chat");
    await run(fakeUpstream(() => json({})), "/admin/timeouts", admin("PUT", { first_byte_s: 10 }));
    const { res } = await run(fakeUpstream(never), "/anthropic/v1/messages", messagesInit(token, hi("claude-opus-5-5")));
    expect(res.status).toBe(504);
  });
});
