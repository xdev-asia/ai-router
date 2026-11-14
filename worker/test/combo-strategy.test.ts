import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const completion = (content: string) => ({
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});
const chat = (token: string, body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const hi = (model: string, extra: Record<string, unknown> = {}) => ({ model, messages: [{ role: "user", content: "hi" }], ...extra });
const admin = (method: string, path: string, body?: unknown) =>
  call(fakeUpstream(() => json({})), `/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const combo = (name: string, targets: string[], strategy: string | null = null, config: unknown = null) =>
  env.DB.prepare("INSERT INTO combo (name, targets, updated_at, strategy, config) VALUES (?, ?, 1, ?, ?)")
    .bind(name, JSON.stringify(targets), strategy, config === null ? null : JSON.stringify(config))
    .run();
/** The model each upstream call asked for, in order. */
const models = (up: { bodies: string[] }) => up.bodies.map((b) => (JSON.parse(b) as { model: string }).model);
const content = (text: string) => (JSON.parse(text) as { choices: { message: { content: string } }[] }).choices[0].message.content;

let token = "";
beforeEach(async () => {
  await reset();
  token = await addSystem("chat");
  await env.DB.prepare("UPDATE system SET allowed_models = '[\"*\"]' WHERE id = 'chat'").run();
});

describe("combo settings API", () => {
  it("saves a combo's strategy and settings, lists them, and refuses bad ones", async () => {
    const made = await admin("POST", "/combos", { name: "duo", targets: ["openai/a", "openai/b"], strategy: "fusion", config: { judge_model: "openai/j" } });
    expect(made.res.status).toBe(201);
    const list = JSON.parse((await admin("GET", "/combos")).text) as { name: string; strategy: string | null; config: Record<string, unknown> }[];
    expect(list[0]).toMatchObject({ name: "duo", strategy: "fusion", config: { judge_model: "openai/j" } });

    expect((await admin("POST", "/combos", { name: "x", targets: [], strategy: "random" })).res.status).toBe(400);
    expect((await admin("PUT", "/combos/duo", { targets: [], config: { judge_model: "not a model" } })).res.status).toBe(400);
    expect((await admin("PUT", "/combos/duo", { targets: [], config: { threshold: 2 } })).res.status).toBe(400);
    expect((await admin("PUT", "/combos/duo", { targets: [], config: { policy: "sometimes" } })).res.status).toBe(400);

    // Back to Fallback: the combo's own settings go too (FR-CMB-26).
    await admin("PUT", "/combos/duo", { targets: ["openai/a"], strategy: "fallback" });
    const after = JSON.parse((await admin("GET", "/combos")).text) as { strategy: string | null; config: unknown }[];
    expect(after[0]).toMatchObject({ strategy: "fallback", config: null });
  });

  it("reads and writes the gateway-wide combo settings", async () => {
    expect(JSON.parse((await admin("GET", "/combo-settings")).text)).toEqual({ strategy: "fallback", sticky_limit: 1 });
    const put = await admin("PUT", "/combo-settings", { strategy: "round-robin", sticky_limit: 3 });
    expect(JSON.parse(put.text)).toEqual({ strategy: "round-robin", sticky_limit: 3 });
    expect((await admin("PUT", "/combo-settings", { sticky_limit: 0 })).res.status).toBe(400);
    expect((await admin("PUT", "/combo-settings", { strategy: "nope" })).res.status).toBe(400);
  });
});

describe("round robin", () => {
  it("starts each request at the next model, the rest following in turn", async () => {
    await combo("rr1", ["openai/a", "openai/b", "openai/c"], "round-robin");
    const up = fakeUpstream(() => json(completion("ok")));
    for (let i = 0; i < 4; i++) await call(up, "/openai/v1/chat/completions", chat(token, hi("rr1")));
    expect(models(up)).toEqual(["a", "b", "c", "a"]);
  });

  it("moves on after the sticky limit, and the gateway-wide strategy applies to a combo without one", async () => {
    await admin("PUT", "/combo-settings", { strategy: "round-robin", sticky_limit: 2 });
    await combo("rr2", ["openai/a", "openai/b"]);
    const up = fakeUpstream(() => json(completion("ok")));
    for (let i = 0; i < 4; i++) await call(up, "/openai/v1/chat/completions", chat(token, hi("rr2")));
    expect(models(up)).toEqual(["a", "a", "b", "b"]);
  });

  it("falls back to the following models when the current one fails", async () => {
    await combo("rr3", ["openai/a", "openai/b"], "round-robin");
    const up = fakeUpstream(async (req) => ((JSON.parse(await req.clone().text()) as { model: string }).model === "a" ? json({ error: { message: "busy" } }, 503) : json(completion("ok"))));
    const r = await call(up, "/openai/v1/chat/completions", chat(token, hi("rr3")));
    expect(r.res.status).toBe(200);
    expect(models(up)).toEqual(["a", "b"]);
  });

  it("starts again from the first model after the combo is edited", async () => {
    await combo("rr4", ["openai/a", "openai/b"], "round-robin");
    const up = fakeUpstream(() => json(completion("ok")));
    await call(up, "/openai/v1/chat/completions", chat(token, hi("rr4")));
    await admin("PUT", "/combos/rr4", { targets: ["openai/a", "openai/b"] });
    await call(up, "/openai/v1/chat/completions", chat(token, hi("rr4")));
    expect(models(up)).toEqual(["a", "a"]);
  });
});

describe("fusion", () => {
  const reply = async (req: Request) => {
    const b = JSON.parse(await req.clone().text()) as { model: string };
    return b.model === "j" ? json(completion("final")) : json(completion(`answer-${b.model}`));
  };

  it("asks every model without tools or streaming, then lets the judge write the answer", async () => {
    await combo("fu1", ["openai/a", "openai/b"], "fusion", { judge_model: "openai/j" });
    const up = fakeUpstream(reply);
    const tools = [{ type: "function", function: { name: "f", parameters: { type: "object" } } }];
    const r = await call(up, "/openai/v1/chat/completions", chat(token, hi("fu1", { tools, tool_choice: "auto" })));
    expect(r.res.status).toBe(200);
    expect(content(r.text)).toBe("final");
    expect(r.res.headers.get("x-gateway-target")).toBe("openai/j");
    expect(models(up).slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(models(up)[2]).toBe("j");
    for (const body of up.bodies.slice(0, 2).map((b) => JSON.parse(b) as Record<string, unknown>)) {
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.stream).not.toBe(true);
    }
    const judge = up.bodies[2];
    expect(judge).toContain("answer-a");
    expect(judge).toContain("answer-b");
    expect(JSON.parse(judge).tools).toEqual(tools);
  });

  it("uses the first model as the judge by default", async () => {
    await combo("fu2", ["openai/a", "openai/b"], "fusion");
    const up = fakeUpstream(reply);
    await call(up, "/openai/v1/chat/completions", chat(token, hi("fu2")));
    expect(models(up)[2]).toBe("a");
  });

  it("answers 503 when no model answers, and asks the only one that did again", async () => {
    await combo("fu3", ["openai/a", "openai/b"], "fusion", { judge_model: "openai/j" });
    const none = await call(fakeUpstream(() => json({ error: { message: "down" } }, 500)), "/openai/v1/chat/completions", chat(token, hi("fu3")));
    expect(none.res.status).toBe(503);

    const up = fakeUpstream(async (req) => ((JSON.parse(await req.clone().text()) as { model: string }).model === "b" ? json({ error: { message: "down" } }, 500) : json(completion("solo"))));
    const one = await call(up, "/openai/v1/chat/completions", chat(token, hi("fu3")));
    expect(one.res.status).toBe(200);
    expect(content(one.text)).toBe("solo");
    expect(models(up).filter((m) => m === "a")).toHaveLength(2);
    expect(models(up)).not.toContain("j");
  });

  it("refuses a fusion combo with no models and calls a single model directly", async () => {
    await combo("fu4", [], "fusion");
    const empty = await call(fakeUpstream(() => json({})), "/openai/v1/chat/completions", chat(token, hi("fu4")));
    expect(empty.res.status).toBe(400);
    expect(JSON.parse(empty.text).error.message).toBe("Fusion combo has no models");

    await combo("fu5", ["openai/a"], "fusion");
    const up = fakeUpstream(reply);
    await call(up, "/openai/v1/chat/completions", chat(token, hi("fu5")));
    expect(models(up)).toEqual(["a"]);
  });
});

describe("smart router", () => {
  const routed = (choice: string, confidence: number) => async (req: Request) => {
    const b = JSON.parse(await req.clone().text()) as { model: string };
    return b.model === "r" ? json(completion(JSON.stringify({ choice, confidence }))) : json(completion(`from-${b.model}`));
  };

  it("puts the router's choice first when it is confident", async () => {
    await combo("sm1", ["openai/a", "openai/b"], "smart", { router_model: "openai/r" });
    const up = fakeUpstream(routed("openai/b", 0.9));
    const r = await call(up, "/openai/v1/chat/completions", chat(token, hi("sm1")));
    expect(content(r.text)).toBe("from-b");
    expect(models(up)).toEqual(["r", "b"]);
    const router = JSON.parse(up.bodies[0]) as { messages: { content: string }[] };
    expect(router.messages.map((m) => m.content).join("\n")).toContain("openai/a");
  });

  it("keeps the saved order below the threshold, after a router failure, or without a router", async () => {
    await combo("sm2", ["openai/a", "openai/b"], "smart", { router_model: "openai/r" });
    const low = fakeUpstream(routed("openai/b", 0.5));
    await call(low, "/openai/v1/chat/completions", chat(token, hi("sm2")));
    expect(models(low)).toEqual(["r", "a"]);

    const broken = fakeUpstream(async (req) => ((JSON.parse(await req.clone().text()) as { model: string }).model === "r" ? json({ error: { message: "x" } }, 500) : json(completion("ok"))));
    await call(broken, "/openai/v1/chat/completions", chat(token, hi("sm2")));
    expect(models(broken)).toEqual(["r", "a"]);

    await combo("sm3", ["openai/a", "openai/b"], "smart");
    const none = fakeUpstream(routed("openai/b", 0.9));
    await call(none, "/openai/v1/chat/completions", chat(token, hi("sm3")));
    expect(models(none)).toEqual(["a"]);
  });

  it("Strict Lock keeps the session's model without asking the router again", async () => {
    await combo("sm4", ["openai/a", "openai/b"], "smart", { router_model: "openai/r", policy: "strict" });
    const up = fakeUpstream(routed("openai/b", 0.9));
    const s = { "x-session-id": "s-strict" };
    await call(up, "/openai/v1/chat/completions", chat(token, hi("sm4"), s));
    await call(up, "/openai/v1/chat/completions", chat(token, hi("sm4"), s));
    expect(models(up)).toEqual(["r", "b", "b"]);
  });

  it("Per-Turn asks the router every time", async () => {
    await combo("sm5", ["openai/a", "openai/b"], "smart", { router_model: "openai/r", policy: "per-turn" });
    const up = fakeUpstream(routed("openai/b", 0.9));
    const s = { "x-session-id": "s-turn" };
    await call(up, "/openai/v1/chat/completions", chat(token, hi("sm5"), s));
    await call(up, "/openai/v1/chat/completions", chat(token, hi("sm5"), s));
    expect(models(up)).toEqual(["r", "b", "r", "b"]);
  });
});
