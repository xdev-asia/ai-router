// The API at /v1/* with no provider prefix (SRS FR-API-01, 02, 05, 06, 16, 17, 18).
// ai-router keeps /openai/v1 and /anthropic/v1 and answers the same requests at /v1 too.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addSystem, call, fakeUpstream, messagesInit, reset, usageRows } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const COMPLETION = {
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "gpt-5-2026",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
};
const MESSAGE = {
  id: "msg_up",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 3 },
};

const chatInit = (token: string, body: unknown) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

const allow = (id: string, patterns: string[]) =>
  env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(patterns), id).run();

beforeEach(reset);

describe("/v1 aliases (paths with no provider prefix)", () => {
  it("POST /v1/chat/completions works like /openai/v1/chat/completions, with a usage row", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    const { res, text } = await call(up, "/v1/chat/completions", chatInit(token, { model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(JSON.parse(text).choices[0].message.content).toBe("hello");
    expect(up.calls).toHaveLength(1);
    expect(new URL(up.calls[0].url).pathname).toBe("/v1/chat/completions");
    expect(await usageRows("app")).toHaveLength(1);
  });

  it("POST /v1/messages and /v1/messages/count_tokens go to Anthropic like /anthropic/v1/...", async () => {
    // "chat" has a (fake) Anthropic key in vitest.config.ts.
    const token = await addSystem("chat");
    const up = fakeUpstream((req) => (new URL(req.url).pathname.endsWith("/count_tokens") ? json({ input_tokens: 7 }) : json(MESSAGE)));
    const body = { model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };

    const m = await call(up, "/v1/messages", messagesInit(token, body));
    expect(m.res.status).toBe(200);
    expect(JSON.parse(m.text).id).toBe("msg_up");
    const ct = await call(up, "/v1/messages/count_tokens", messagesInit(token, body));
    expect(ct.res.status).toBe(200);
    expect(JSON.parse(ct.text)).toEqual({ input_tokens: 7 });

    expect(up.calls.map((r) => new URL(r.url).pathname)).toEqual(["/v1/messages", "/v1/messages/count_tokens"]);
    expect(await usageRows("chat")).toHaveLength(1);
  });

  it("GET /v1 and GET /v1/models list the models, like /openai/v1/models", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/gpt-5"]);
    const up = fakeUpstream(() => json({ data: [] }));
    for (const path of ["/v1", "/v1/models", "/openai/v1"]) {
      const { res, text } = await call(up, path, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status, path).toBe(200);
      const list = JSON.parse(text);
      expect(list.object, path).toBe("list");
      expect(list.data.map((m: { id: string }) => m.id), path).toEqual(["openai/gpt-5"]);
    }
  });

  it("asks for the gateway token on /v1 like everywhere else", async () => {
    const up = fakeUpstream(() => json(COMPLETION));
    const { res } = await call(up, "/v1/chat/completions", chatInit("xllm_wrong", { model: "openai/gpt-5", messages: [] }));
    expect(res.status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("/v1/v1/* is the same as /v1/*", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    const { res } = await call(up, "/v1/v1/chat/completions", chatInit(token, { model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(up.calls).toHaveLength(1);
  });

  it("an unknown /v1 path is a 404 in OpenAI shape, and nothing goes upstream", async () => {
    const token = await addSystem("app");
    const up = fakeUpstream(() => json({}));
    const { res, text } = await call(up, "/v1/nope", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    expect(res.status).toBe(404);
    expect(JSON.parse(text).error.code).toBe("not_found");
    expect(up.calls).toHaveLength(0);
  });

  it("allows any origin on /v1 (CORS *), and answers the preflight without a token", async () => {
    const up = fakeUpstream(() => json({}));
    const pre = await call(up, "/v1/chat/completions", {
      method: "OPTIONS",
      headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
    });
    expect(pre.res.status).toBe(204);
    expect(pre.res.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.res.headers.get("access-control-allow-methods")).toContain("POST");
    expect((pre.res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("authorization");

    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up2 = fakeUpstream(() => json(COMPLETION));
    const { res } = await call(up2, "/v1/chat/completions", { ...chatInit(token, { model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] }), headers: { ...chatInit(token, {}).headers, origin: "https://app.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(up.calls).toHaveLength(0);
  });

  it("does not add CORS to the admin API", async () => {
    const up = fakeUpstream(() => json({}));
    const { res } = await call(up, "/admin/systems", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "GET" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("GET /api/health answers without a token, like /health", async () => {
    const up = fakeUpstream(() => json({}));
    const { res, text } = await call(up, "/api/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual(JSON.parse((await call(up, "/health")).text));
    expect(JSON.parse(text)).toMatchObject({ ok: true });
  });
});
