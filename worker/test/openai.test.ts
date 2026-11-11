import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { chatToMessages, TranslateError } from "../translate/openai-anthropic";
import { addSystem, call, fakeUpstream, reset, sse, usageRows } from "./helpers";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const chat = (token: string, body: unknown) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [
    { type: "thinking", thinking: "hidden" },
    { type: "text", text: "Checking the weather." },
    { type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Hanoi" } },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
};

beforeEach(reset);

describe("POST /openai/v1/chat/completions", () => {
  it("translates the request, the reply and records usage", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(() => json(MESSAGE));
    const { res, text } = await call(
      up,
      "/openai/v1/chat/completions",
      chat(token, {
        model: "claude-opus-5-5",
        max_tokens: 300,
        stop: "END",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "developer", content: [{ type: "text", text: "Use tools." }] },
          { role: "user", content: [{ type: "text", text: "Weather?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
          { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "weather", arguments: '{"city":"Hue"}' } }] },
          { role: "tool", tool_call_id: "call_0", content: "Sunny" },
          { role: "user", content: "And Hanoi?" },
        ],
        tools: [{ type: "function", function: { name: "weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
        tool_choice: "required",
        parallel_tool_calls: false,
      }),
    );
    expect(res.status).toBe(200);

    const sent = up.calls[0]!;
    expect(sent.url).toBe("https://upstream.test/v1/messages");
    expect(sent.headers.get("x-api-key")).toBe("sk-ant-test-chat");
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.parse(up.bodies[0]!)).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 300,
      stop_sequences: ["END"],
      system: "Be brief.\n\nUse tools.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Weather?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_0", name: "weather", input: { city: "Hue" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_0", content: "Sunny" }, { type: "text", text: "And Hanoi?" }] },
      ],
      tools: [{ name: "weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    });

    const out = JSON.parse(text);
    expect(out.object).toBe("chat.completion");
    expect(out.id).toBe("chatcmpl-msg_1");
    expect(out.model).toBe("claude-opus-5-5");
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    expect(out.choices[0].message).toEqual({
      role: "assistant",
      content: "Checking the weather.",
      tool_calls: [{ id: "toolu_1", type: "function", function: { name: "weather", arguments: '{"city":"Hanoi"}' } }],
    });
    expect(out.usage).toEqual({ prompt_tokens: 15, completion_tokens: 5, total_tokens: 20, prompt_tokens_details: { cached_tokens: 3 } });

    const rows = await usageRows("chat");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", streamed: 0, input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 });
  });

  it("streams OpenAI chunks, numbers tool calls among tool calls, ends with usage and [DONE]", async () => {
    const token = await addSystem("chat");
    const events = [
      { type: "message_start", message: { id: "msg_2", model: "claude-opus-5-5", usage: { input_tokens: 7, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_9", name: "weather", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Hue"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ];
    const up = fakeUpstream(() => new Response(sse(events), { headers: { "content-type": "text/event-stream" } }));
    const { res, text } = await call(
      up,
      "/openai/v1/chat/completions",
      chat(token, { model: "claude-opus-5-5", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(JSON.parse(up.bodies[0]!).stream).toBe(true);

    const datas = text.split("\n\n").filter(Boolean).map((b) => b.replace(/^data: /, ""));
    expect(datas.at(-1)).toBe("[DONE]");
    const chunks = datas.slice(0, -1).map((d) => JSON.parse(d));
    expect(chunks.every((ch) => ch.id === "chatcmpl-msg_2" && ch.object === "chat.completion.chunk")).toBe(true);
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(chunks.map((ch) => ch.choices[0]?.delta?.content).filter(Boolean).join("")).toBe("Hi");
    const toolDeltas = chunks.flatMap((ch) => ch.choices[0]?.delta?.tool_calls ?? []);
    expect(toolDeltas[0]).toEqual({ index: 0, id: "toolu_9", type: "function", function: { name: "weather", arguments: "" } });
    expect(toolDeltas.map((t: { function: { arguments: string } }) => t.function.arguments).join("")).toBe('{"city":"Hue"}');
    expect(toolDeltas.every((t: { index: number }) => t.index === 0)).toBe(true);
    const finish = chunks.find((ch) => ch.choices[0]?.finish_reason);
    expect(finish.choices[0].finish_reason).toBe("tool_calls");
    const last = chunks.at(-1);
    expect(last.choices).toEqual([]);
    expect(last.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 12, total_tokens: 19 });

    expect(await usageRows("chat")).toEqual([expect.objectContaining({ streamed: 1, input_tokens: 7, output_tokens: 12 })]);
  });

  it("without include_usage the stream has no usage chunk", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(
      () =>
        new Response(sse([{ type: "message_start", message: { id: "m", model: "x", usage: {} } }, { type: "message_stop" }]), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const { text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "claude-haiku-5-5", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(text).not.toContain('"usage"');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("refuses with OpenAI-shaped errors before calling upstream", async () => {
    const up = fakeUpstream(() => json(MESSAGE));
    const body = { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] };

    const noToken = await call(up, "/openai/v1/chat/completions", { method: "POST", body: JSON.stringify(body) });
    expect(noToken.res.status).toBe(401);
    expect(JSON.parse(noToken.text).error).toMatchObject({ type: "invalid_request_error", code: "invalid_api_key" });

    const off = await addSystem("off", { disabled: true });
    expect((await call(up, "/openai/v1/chat/completions", chat(off, body))).res.status).toBe(403);

    const capped = await addSystem("capped", { cap: 0 });
    const cap = await call(up, "/openai/v1/chat/completions", chat(capped, body));
    expect(cap.res.status).toBe(429);
    expect(cap.res.headers.get("x-should-retry")).toBe("false");
    expect(JSON.parse(cap.text).error).toMatchObject({ type: "insufficient_quota", code: "monthly_token_cap" });

    const nokey = await addSystem("nokey");
    expect((await call(up, "/openai/v1/chat/completions", chat(nokey, body))).res.status).toBe(500);

    const ok = await addSystem("chat");
    for (const bad of ["not json", { ...body, n: 2 }, { ...body, messages: [] }, { ...body, messages: [{ role: "wizard", content: "x" }] }]) {
      const r = await call(up, "/openai/v1/chat/completions", chat(ok, bad));
      expect(r.res.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.parse(r.text).error.type).toBe("invalid_request_error");
    }
    expect(up.calls).toHaveLength(0);
  });

  it("passes an upstream error on with its status, in the OpenAI envelope", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(() =>
      json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529, { "retry-after": "7", "x-api-key": "leak?" }),
    );
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(529);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(res.headers.get("x-api-key")).toBeNull();
    expect(JSON.parse(text)).toEqual({ error: { message: "Overloaded", type: "overloaded_error", param: null, code: null } });
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ status: 529, input_tokens: 0 })]);
  });
});

describe("GET /openai/v1/models", () => {
  it("lists the provider's models in the OpenAI shape", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(() => json({ data: [{ id: "claude-opus-5-5", created_at: "2026-09-01T00:00:00Z", type: "model" }] }));
    const { res, text } = await call(up, "/openai/v1/models", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe("https://upstream.test/v1/models?limit=1000");
    expect(JSON.parse(text)).toEqual({ object: "list", data: [{ id: "claude-opus-5-5", object: "model", created: 1788220800, owned_by: "anthropic" }] });
    expect(await usageRows("chat")).toHaveLength(0);
  });
});

describe("chatToMessages", () => {
  it("defaults max_tokens, clamps temperature, prefers max_completion_tokens", () => {
    const base = { model: "m", messages: [{ role: "user", content: "hi" }] };
    expect(chatToMessages(base).max_tokens).toBe(8192);
    expect(chatToMessages({ ...base, temperature: 1.7 }).temperature).toBe(1);
    expect(chatToMessages({ ...base, max_tokens: 5, max_completion_tokens: 9 }).max_tokens).toBe(9);
  });

  it("maps tool_choice forms and refuses what it cannot map", () => {
    const base = { model: "m", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "f" } }] };
    expect(chatToMessages({ ...base, tool_choice: "none" }).tool_choice).toEqual({ type: "none" });
    expect(chatToMessages({ ...base, tool_choice: { type: "function", function: { name: "f" } } }).tool_choice).toEqual({ type: "tool", name: "f" });
    expect(() => chatToMessages({ ...base, tool_choice: "sometimes" })).toThrow(TranslateError);
    expect(() => chatToMessages({ ...base, tools: [{ type: "code_interpreter" }] })).toThrow(TranslateError);
    expect(() => chatToMessages({ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://x/a.png" } }] }] })).toThrow(TranslateError);
    expect(() => chatToMessages({ model: "m", messages: [{ role: "system", content: "only system" }] })).toThrow(TranslateError);
  });
});
