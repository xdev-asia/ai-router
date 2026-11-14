import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addSystem, call, chunked, fakeUpstream, messagesInit, reset, sse, usageRows } from "./helpers";

const OK_JSON = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 },
};

const jsonReply = () =>
  new Response(JSON.stringify(OK_JSON), { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } });

beforeEach(reset);

describe("health", () => {
  it("GET /health returns ok without a token", async () => {
    const up = fakeUpstream(jsonReply);
    const { res, text } = await call(up, "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true });
  });
});

describe("authentication", () => {
  it("refuses a request without a token, in the Anthropic error shape, and never calls upstream", async () => {
    const up = fakeUpstream(jsonReply);
    const { res, text } = await call(up, "/anthropic/v1/messages", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(JSON.parse(text)).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    expect(up.calls).toHaveLength(0);
  });

  it("refuses an unknown token", async () => {
    await addSystem("chat");
    const up = fakeUpstream(jsonReply);
    const { res } = await call(up, "/anthropic/v1/messages", messagesInit("xllm_wrong", {}));
    expect(res.status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("accepts the token as Authorization: Bearer too", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(jsonReply);
    const { res } = await call(up, "/anthropic/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("refuses a disabled system with permission_error", async () => {
    const token = await addSystem("off", { disabled: true });
    const up = fakeUpstream(jsonReply);
    const { res, text } = await call(up, "/anthropic/v1/messages", messagesInit(token, {}));
    expect(res.status).toBe(403);
    expect(JSON.parse(text).error.type).toBe("permission_error");
    expect(up.calls).toHaveLength(0);
  });

  it("answers 500 not_configured when the system has no Anthropic key, and tells the SDK not to retry", async () => {
    const token = await addSystem("nokey");
    const up = fakeUpstream(jsonReply);
    const { res, text } = await call(up, "/anthropic/v1/messages", messagesInit(token, {}));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(JSON.parse(text).error.message).toContain("not_configured");
    expect(up.calls).toHaveLength(0);
  });
});

describe("forwarding", () => {
  it("never forwards a gateway token sent as ?key= to the provider", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(jsonReply);
    const body = { model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
    const init = messagesInit(token, body);
    const headers = new Headers(init.headers);
    headers.delete("x-api-key");
    headers.delete("authorization");
    const { res } = await call(up, `/anthropic/v1/messages?beta=true&key=${token}`, { ...init, headers });
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe("https://upstream.test/v1/messages?beta=true");
    expect(up.calls[0]!.url).not.toContain(token);
  });

  it("swaps the gateway token for the system's key and keeps the body, query, version and beta headers", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(jsonReply);
    const body = { model: "claude-opus-5-5", max_tokens: 16000, messages: [{ role: "user", content: "hi" }] };
    const { res, text } = await call(
      up,
      "/anthropic/v1/messages?beta=true",
      messagesInit(token, body, { "anthropic-beta": "server-side-fallback-2026-07-01", cookie: "a=b" }),
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual(OK_JSON);
    expect(res.headers.get("request-id")).toBe("req_1");

    const sent = up.calls[0]!;
    expect(sent.url).toBe("https://upstream.test/v1/messages?beta=true");
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("x-api-key")).toBe("sk-ant-test-chat");
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.headers.get("cookie")).toBeNull();
    expect(sent.headers.get("anthropic-version")).toBe("2026-10-21");
    expect(sent.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(JSON.parse(up.bodies[0]!)).toEqual(body);
  });

  it("records usage of a JSON reply", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(jsonReply);
    await call(up, "/anthropic/v1/messages", messagesInit(token, {}));
    const rows = await usageRows("chat");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "anthropic",
      request_id: "req_1",
      model: "claude-opus-5-5",
      status: 200,
      streamed: 0,
      input_tokens: 10,
      output_tokens: 3,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 7,
    });
  });

  it("passes an upstream error through unchanged and records a row with no tokens", async () => {
    const token = await addSystem("chat");
    const err = { type: "error", error: { type: "invalid_request_error", message: "bad" } };
    const up = fakeUpstream(() => new Response(JSON.stringify(err), { status: 400, headers: { "content-type": "application/json" } }));
    const { res, text } = await call(up, "/anthropic/v1/messages", messagesInit(token, {}));
    expect(res.status).toBe(400);
    expect(JSON.parse(text)).toEqual(err);
    const rows = await usageRows("chat");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 400, input_tokens: 0, output_tokens: 0 });
  });

  it("streams SSE through byte for byte and records usage from message_start and message_delta", async () => {
    const token = await addSystem("chat");
    const body = sse([
      { type: "message_start", message: { id: "msg_2", model: "claude-opus-5-5", usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 4 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ]);
    // Split in odd places, including inside a data line.
    const chunks = [body.slice(0, 17), body.slice(17, 160), body.slice(160)];
    const up = fakeUpstream(() => chunked(chunks, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_2" } }));

    const { res, text } = await call(up, "/anthropic/v1/messages", messagesInit(token, { stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(text).toBe(body);

    const rows = await usageRows("chat");
    expect(rows[0]).toMatchObject({
      streamed: 1,
      request_id: "req_2",
      model: "claude-opus-5-5",
      input_tokens: 20,
      output_tokens: 12,
      cache_read_input_tokens: 4,
    });
  });

  it("forwards count_tokens without recording usage", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(() => new Response(JSON.stringify({ input_tokens: 42 }), { headers: { "content-type": "application/json" } }));
    const { res, text } = await call(up, "/anthropic/v1/messages/count_tokens", messagesInit(token, {}));
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ input_tokens: 42 });
    expect(up.calls[0]!.url).toBe("https://upstream.test/v1/messages/count_tokens");
    expect(await usageRows("chat")).toHaveLength(0);
  });

  it("answers 404 in the Anthropic error shape for other paths", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(jsonReply);
    const { res, text } = await call(up, "/anthropic/v1/files", messagesInit(token, {}));
    expect(res.status).toBe(404);
    expect(JSON.parse(text).error.type).toBe("not_found_error");
    expect(up.calls).toHaveLength(0);
  });
});

describe("monthly cap", () => {
  it("refuses with 429 and x-should-retry: false once this month's tokens reach the cap", async () => {
    const token = await addSystem("capped", { cap: 30 });
    const up = fakeUpstream(jsonReply); // each reply uses 10 + 3 + 5 + 7 = 25 tokens

    expect((await call(up, "/anthropic/v1/messages", messagesInit(token, {}))).res.status).toBe(200);
    expect((await call(up, "/anthropic/v1/messages", messagesInit(token, {}))).res.status).toBe(200); // 25 < 30: allowed, ends at 50

    const third = await call(up, "/anthropic/v1/messages", messagesInit(token, {}));
    expect(third.res.status).toBe(429);
    expect(third.res.headers.get("x-should-retry")).toBe("false");
    expect(JSON.parse(third.text).error.type).toBe("rate_limit_error");
    expect(up.calls).toHaveLength(2);
  });

  it("ignores usage from earlier months", async () => {
    const token = await addSystem("capped", { cap: 30 });
    const lastYear = Math.floor(Date.now() / 1000) - 400 * 86400;
    await env.DB.prepare(
      "INSERT INTO usage (system_id, provider, status, streamed, input_tokens, at) VALUES ('capped', 'anthropic', 200, 0, 1000, ?)",
    )
      .bind(lastYear)
      .run();
    const up = fakeUpstream(jsonReply);
    expect((await call(up, "/anthropic/v1/messages", messagesInit(token, {}))).res.status).toBe(200);
  });
});
