// POST /v1/messages for every model: Claude-format clients (Claude Code) reach other providers and combos through the
// chat router (FR-TRN-02, FR-TRN-03, FR-TRN-07, FR-TRN-12, FR-API-02, FR-API-05). Anthropic-format targets keep the
// byte-for-byte passthrough (proxy.test.ts).
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { chatToMessage, messageAsEvents } from "../translate/anthropic-openai";
import { addSystem, call, chunked, fakeUpstream, messagesInit, reset, usageRows } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const allow = (id: string, patterns: string[]) => env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(patterns), id).run();
const SSE = { status: 200, headers: { "content-type": "text/event-stream" } };

const completion = (message: Record<string, unknown>, finish = "stop") => ({
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "gpt-5-2026",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 } },
});

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "gpt-5-2026", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usageChunk = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "gpt-5-2026", choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } } })}\n\n`;

/** The SSE events of an Anthropic stream, checking each `event:` line names its data's type. */
function events(text: string): Record<string, any>[] {
  return text
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map((b) => {
      const ev = /^event: (.+)$/m.exec(b)?.[1];
      const data = JSON.parse(/^data: (.+)$/m.exec(b)![1]!);
      expect(data.type).toBe(ev);
      return data;
    });
}

beforeEach(reset);

describe("POST /v1/messages to a non-Anthropic model", () => {
  it("translates a Claude Code style request to chat", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() => json(completion({ content: "done" })));
    const { res, text } = await call(
      up,
      "/v1/messages",
      messagesInit(token, {
        model: "openai/gpt-5",
        max_tokens: 1000,
        system: [
          { type: "text", text: "You are a coding agent." },
          { type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Look at this." },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should read the file.", signature: "sig" },
              { type: "text", text: "Reading it." },
              { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.ts" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "const a = 1;" }] },
              { type: "text", text: "Now fix it.", cache_control: { type: "ephemeral" } },
            ],
          },
        ],
        tools: [
          { name: "Read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
          { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        ],
        tool_choice: { type: "any", disable_parallel_tool_use: true },
        thinking: { type: "enabled", budget_tokens: 20000 },
        stop_sequences: ["END"],
        temperature: 0.3,
      }),
    );
    expect(res.status, text).toBe(200);
    expect(new URL(up.calls[0]!.url).pathname).toBe("/v1/chat/completions");
    const sent = JSON.parse(up.bodies[0]!);
    expect(sent.model).toBe("gpt-5");
    expect(sent.messages).toEqual([
      { role: "system", content: "You are a coding agent.\n\nBe brief." },
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this." },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      },
      { role: "assistant", content: "Reading it.", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Read", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "toolu_1", content: "const a = 1;" },
      { role: "user", content: [{ type: "text", text: "Now fix it." }] },
    ]);
    // A server tool (typed) only Anthropic runs is left out; the client's own tools go as functions.
    expect(sent.tools).toEqual([
      { type: "function", function: { name: "Read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    ]);
    expect(sent).toMatchObject({ tool_choice: "required", parallel_tool_calls: false, reasoning_effort: "high", stop: ["END"], temperature: 0.3, max_tokens: 1000 });
    expect(sent.stream).toBeUndefined();
  });

  it("answers a Claude message: thinking, text, tool use, stop reason and usage", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() =>
      json(
        completion(
          {
            reasoning_content: "Let me think.",
            content: "Fixing.",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "Edit", arguments: '{"path":"a.ts"}' } }],
          },
          "tool_calls",
        ),
      ),
    );
    const { res, text } = await call(up, "/v1/messages", messagesInit(token, { model: "openai/gpt-5", max_tokens: 100, messages: [{ role: "user", content: "fix" }] }));
    expect(res.status, text).toBe(200);
    const msg = JSON.parse(text);
    expect(msg).toMatchObject({
      type: "message",
      role: "assistant",
      model: "openai/gpt-5",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 15, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
    });
    expect(msg.id).toMatch(/^msg_/);
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "Let me think.", signature: "" },
      { type: "text", text: "Fixing." },
      { type: "tool_use", id: "call_1", name: "Edit", input: { path: "a.ts" } },
    ]);
    // Metered once, by the chat router.
    const rows = await usageRows("app");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "openai", input_tokens: 15, output_tokens: 4 });
  });

  it("streams Anthropic events from a chat stream", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() =>
      chunked(
        [
          chunk({ role: "assistant", content: "" }),
          chunk({ reasoning_content: "Hmm" }),
          chunk({ content: "Hel" }),
          chunk({ content: "lo" }),
          chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "Read", arguments: "" } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
          chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "Read", arguments: '{"path":"b.ts"}' } }] }),
          chunk({}, "tool_calls"),
          usageChunk,
          "data: [DONE]\n\n",
        ],
        SSE,
      ),
    );
    const { res, text } = await call(up, "/v1/messages", messagesInit(token, { model: "openai/gpt-5", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status, text).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sent = JSON.parse(up.bodies[0]!);
    expect(sent).toMatchObject({ stream: true, stream_options: { include_usage: true } });

    const ev = events(text);
    expect(ev.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(ev[0]!.message).toMatchObject({ type: "message", role: "assistant", model: "openai/gpt-5", content: [], stop_reason: null });
    expect(ev[1]).toEqual({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
    expect(ev[2]).toEqual({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm" } });
    expect(ev[4]).toEqual({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    expect(ev[5]).toEqual({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } });
    expect(ev[8]).toEqual({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_a", name: "Read", input: {} } });
    expect(ev[9]).toEqual({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } });
    expect(ev[12]).toEqual({ type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "call_b", name: "Read", input: {} } });
    expect(ev[13]).toEqual({ type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"path":"b.ts"}' } });
    expect(ev[15]).toEqual({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } });
    const rows = await usageRows("app");
    expect(rows).toHaveLength(1);
  });

  it("a whole message sent as events (runChat answered JSON to a stream request)", async () => {
    const msg = chatToMessage(completion({ content: "hi there" }), "combo/fuse");
    const text = await new Response(messageAsEvents(msg)).text();
    const ev = events(text);
    expect(ev.map((e) => e.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(ev[2]!.delta).toEqual({ type: "text_delta", text: "hi there" });
    expect(ev[4]!.delta.stop_reason).toBe("end_turn");
  });

  it("an error chunk ends the stream with an error event", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() => chunked([chunk({ content: "Hel" }), `data: ${JSON.stringify({ error: { message: "overloaded", type: "server_error" } })}\n\n`], SSE));
    const { text } = await call(up, "/v1/messages", messagesInit(token, { model: "openai/gpt-5", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }));
    const ev = events(text);
    expect(ev.at(-1)).toEqual({ type: "error", error: { type: "api_error", message: "overloaded" } });
  });

  it("routes a combo and names the target that answered", async () => {
    const token = await addSystem("app");
    await allow("app", ["combo/*", "openai/*"]);
    await env.DB.prepare("INSERT INTO combo (name, targets, updated_at) VALUES ('fast', '[\"openai/gpt-5\"]', 1)").run();
    const up = fakeUpstream(() => json(completion({ content: "ok" })));
    const { res, text } = await call(up, "/v1/messages", messagesInit(token, { model: "combo/fast", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status, text).toBe(200);
    expect(res.headers.get("x-gateway-target")).toBe("openai/gpt-5");
    expect(JSON.parse(text).content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("answers errors in the Anthropic shape", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() => json(completion({ content: "never" })));
    const denied = await call(up, "/v1/messages", messagesInit(token, { model: "groq/llama-4", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
    expect(denied.res.status).toBe(403);
    expect(JSON.parse(denied.text)).toEqual({ type: "error", error: { type: "permission_error", message: "this system may not use groq/llama-4" } });
    const unknown = await call(up, "/v1/messages", messagesInit(token, { model: "nope/x/y", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
    expect(unknown.res.status).toBe(404);
    expect(JSON.parse(unknown.text).error.type).toBe("not_found_error");
    const bad = await call(up, "/v1/messages", messagesInit(token, { model: "openai/gpt-5", max_tokens: 10, messages: [{ role: "user", content: [{ type: "video", source: {} }] }] }));
    expect(bad.res.status).toBe(400);
    expect(JSON.parse(bad.text)).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(up.calls).toHaveLength(0);
  });

  it("keeps a provider error's status, in the Anthropic shape", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() => json({ error: { message: "Rate limit reached", type: "rate_limit_error" } }, 429));
    const { res, text } = await call(up, "/v1/messages", messagesInit(token, { model: "openai/gpt-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(429);
    expect(JSON.parse(text)).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
  });
});

describe("POST /v1/messages/count_tokens to a non-Anthropic model", () => {
  it("estimates locally: about 4 characters per token, no provider call", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() => json({}));
    const { res, text } = await call(up, "/v1/messages/count_tokens", messagesInit(token, { model: "openai/gpt-5", system: "abcd", messages: [{ role: "user", content: "abcdefgh" }] }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({ input_tokens: 3 });
    expect(up.calls).toHaveLength(0);
  });
});
