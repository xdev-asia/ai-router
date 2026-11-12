import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CAVEMAN_PROMPTS } from "../savers/vendor/cavemanPrompts.js";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, messagesInit, reset } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const admin = (method: string, body?: unknown) =>
  call(fakeUpstream(() => json({})), "/admin/token-saver", {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const put = async (body: unknown) => {
  const r = await admin("PUT", body);
  expect(r.res.status, r.text).toBe(200);
  return JSON.parse(r.text);
};

const MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 2, output_tokens: 1 } };
const COMPLETION = { id: "c", object: "chat.completion", model: "gpt-5", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const claude = (system: string | undefined, extra: Record<string, unknown> = {}) => ({ model: "claude-opus-5-5", max_tokens: 8, ...(system === undefined ? {} : { system }), messages: [{ role: "user", content: "hi" }], ...extra });
const chat = (token: string, body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const NOTE = "Answer in British English.";

beforeEach(reset);

describe("token saver settings", () => {
  it("starts with everything off", async () => {
    expect(JSON.parse((await admin("GET")).text)).toEqual({ rtk: false, caveman: null, ponytail: null, custom_prompt: null, headroom: { enabled: false, url: null } });
  });

  it("saves the fields it is given and keeps the others", async () => {
    await put({ rtk: true, caveman: "lite" });
    const saved = await put({ custom_prompt: `  ${NOTE}  `, headroom: { enabled: true, url: "https://headroom.test" } });
    expect(saved).toEqual({ rtk: true, caveman: "lite", ponytail: null, custom_prompt: NOTE, headroom: { enabled: true, url: "https://headroom.test" } });
    expect(JSON.parse((await admin("GET")).text)).toEqual(saved);
    expect((await put({ custom_prompt: "", caveman: null })).custom_prompt).toBeNull();
  });

  it("refuses values that are not settings", async () => {
    for (const bad of [
      { rtk: "yes" },
      { caveman: "max" },
      { ponytail: 1 },
      { custom_prompt: "x".repeat(4001) },
      { headroom: { enabled: true, url: null } },
      { headroom: { enabled: true, url: "ftp://headroom.test" } },
      { headroom: { enabled: false, url: "not a url" } },
      { headroom: "on" },
    ]) {
      expect((await admin("PUT", bad)).res.status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect(JSON.parse((await admin("GET")).text).rtk).toBe(false);
  });
});

describe("gateway-wide savers", () => {
  it("gives a system without its own setting the gateway's level, and appends the custom prompt last", async () => {
    const token = await addSystem("chat");
    await put({ caveman: "lite", custom_prompt: NOTE });
    const up = fakeUpstream(() => json(MESSAGE));
    await call(up, "/anthropic/v1/messages", messagesInit(token, claude("Be kind.")));
    expect(JSON.parse(up.bodies[0]!).system).toBe(`Be kind.\n\n${CAVEMAN_PROMPTS.lite}\n\n${NOTE}`);
  });

  it("a system's own level wins over the gateway's", async () => {
    const token = await addSystem("chat");
    await env.DB.prepare("UPDATE system SET caveman = 'ultra' WHERE id = 'chat'").run();
    await put({ caveman: "lite" });
    const up = fakeUpstream(() => json(MESSAGE));
    await call(up, "/anthropic/v1/messages", messagesInit(token, claude("Be kind.")));
    expect(JSON.parse(up.bodies[0]!).system).toBe(`Be kind.\n\n${CAVEMAN_PROMPTS.ultra}`);
  });

  it("adds the custom prompt to an OpenAI request as a system message when there is none", async () => {
    const token = await addSystem("chat");
    await env.DB.prepare("UPDATE system SET allowed_models = '[\"openai/*\"]' WHERE id = 'chat'").run();
    await put({ custom_prompt: NOTE });
    const up = fakeUpstream(() => json(COMPLETION));
    await call(up, "/openai/v1/chat/completions", chat(token, { model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] }));
    expect(JSON.parse(up.bodies[0]!).messages).toEqual([
      { role: "system", content: NOTE },
      { role: "user", content: "hi" },
    ]);
  });

  it("leaves the request bytes alone when everything is off, and when the request opts out", async () => {
    const token = await addSystem("chat");
    const body = claude("Be kind.");
    const up = fakeUpstream(() => json(MESSAGE));
    await call(up, "/anthropic/v1/messages", messagesInit(token, body));
    await put({ caveman: "full", custom_prompt: NOTE, rtk: true });
    await call(up, "/anthropic/v1/messages", messagesInit(token, body, { "x-gateway-token-saver": "off" }));
    expect(up.bodies).toEqual([JSON.stringify(body), JSON.stringify(body)]);
  });
});

describe("headroom", () => {
  const ORIGINAL = [
    { role: "system", content: "Be kind." },
    { role: "user", content: "a very long question" },
  ];
  const SHORT = [
    { role: "system", content: "Be kind." },
    { role: "user", content: "short question" },
  ];
  async function setup() {
    const token = await addSystem("chat");
    await env.DB.prepare("UPDATE system SET allowed_models = '[\"openai/*\", \"anthropic/*\"]' WHERE id = 'chat'").run();
    await put({ headroom: { enabled: true, url: "https://headroom.test/base/" } });
    return token;
  }
  const upstreamWith = (compress: () => Response) => fakeUpstream((req) => (new URL(req.url).host === "headroom.test" ? compress() : json(COMPLETION)));

  it("sends the messages to Headroom first, then the compressed ones to the provider", async () => {
    const token = await setup();
    const up = upstreamWith(() => json({ messages: SHORT, tokens_saved: 12 }));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "openai/gpt-5", messages: ORIGINAL, temperature: 0.1 }));
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => r.url)).toEqual(["https://headroom.test/base/v1/compress", "https://api.openai.com/v1/chat/completions"]);
    expect(up.calls[0]!.method).toBe("POST");
    expect(up.calls[0]!.headers.get("authorization")).toBeNull();
    expect(JSON.parse(up.bodies[0]!)).toEqual({ messages: ORIGINAL, model: "gpt-5" });
    expect(JSON.parse(up.bodies[1]!)).toMatchObject({ model: "gpt-5", messages: SHORT, temperature: 0.1 });
  });

  it("keeps the original messages when Headroom fails, answers nonsense or cannot be reached", async () => {
    const token = await setup();
    for (const compress of [
      () => json({ error: "boom" }, 500),
      () => json({ messages: [SHORT[1]] }), // one message short
      () => json({ messages: [{ role: "user", content: "x" }, SHORT[1]] }), // roles changed
      () => new Response("not json"),
      () => {
        throw new Error("down");
      },
    ]) {
      const up = upstreamWith(compress as () => Response);
      const { res } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "openai/gpt-5", messages: ORIGINAL }));
      expect(res.status).toBe(200);
      expect(JSON.parse(up.bodies[up.bodies.length - 1]!).messages).toEqual(ORIGINAL);
    }
  });

  it("is not called when it is off, when the request opts out, or on /anthropic", async () => {
    const token = await setup();
    const hosts = (up: ReturnType<typeof fakeUpstream>) => up.calls.map((r) => new URL(r.url).host);

    const optOut = upstreamWith(() => json({ messages: SHORT }));
    await call(optOut, "/openai/v1/chat/completions", chat(token, { model: "openai/gpt-5", messages: ORIGINAL }, { "x-gateway-token-saver": "off" }));
    expect(hosts(optOut)).toEqual(["api.openai.com"]);

    const messages = fakeUpstream(() => json(MESSAGE));
    await call(messages, "/anthropic/v1/messages", messagesInit(token, claude("Be kind.")));
    expect(hosts(messages)).toEqual(["upstream.test"]);

    await put({ headroom: { enabled: false, url: "https://headroom.test/base/" } });
    const off = upstreamWith(() => json({ messages: SHORT }));
    await call(off, "/openai/v1/chat/completions", chat(token, { model: "openai/gpt-5", messages: ORIGINAL }));
    expect(hosts(off)).toEqual(["api.openai.com"]);
  });
});
