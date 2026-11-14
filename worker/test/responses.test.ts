// POST /v1/responses: the OpenAI Responses API on top of chat routing, so Codex CLI (wire_api = "responses") works.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addSystem, call, chunked, fakeUpstream, reset, usageRows } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const init = (token: string | null, body: unknown) => ({
  method: "POST",
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const allow = (id: string, patterns: string[]) =>
  env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(patterns), id).run();

const completion = (message: Record<string, unknown>, finish = "stop") => ({
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "gpt-5-2026",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 } },
});

/** The SSE events of a Responses stream, as parsed objects, checking each `event:` line names its data's type. */
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

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "gpt-5-2026", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usageChunk = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "gpt-5-2026", choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`;
const SSE = { status: 200, headers: { "content-type": "text/event-stream" } };

beforeEach(reset);

describe("POST /v1/responses", () => {
  it("translates a text input with instructions and answers a response object", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() => json(completion({ content: "hello" })));
    const { res, text } = await call(
      up,
      "/v1/responses",
      init(token, { model: "openai/gpt-5", instructions: "Be brief.", input: "hi", max_output_tokens: 50, temperature: 0.2, reasoning: { effort: "low" }, store: false }),
    );
    expect(res.status).toBe(200);
    expect(new URL(up.calls[0]!.url).pathname).toBe("/v1/chat/completions");
    const sent = JSON.parse(up.bodies[0]!);
    expect(sent.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
    ]);
    expect(sent).toMatchObject({ max_tokens: 50, temperature: 0.2, reasoning_effort: "low" });
    expect(sent.stream).toBeUndefined();

    const out = JSON.parse(text);
    expect(out).toMatchObject({ object: "response", status: "completed", model: "gpt-5-2026", error: null });
    expect(out.id).toMatch(/^resp_/);
    expect(out.output).toHaveLength(1);
    expect(out.output[0]).toMatchObject({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] });
    expect(out.output_text).toBe("hello");
    expect(out.usage).toEqual({ input_tokens: 20, input_tokens_details: { cached_tokens: 5 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 24 });
    expect(await usageRows("app")).toHaveLength(1);
  });

  it("translates message items, tool calls and tool outputs, and answers function_call items", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() =>
      json(completion({ content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } }] }, "tool_calls")),
    );
    const { res, text } = await call(
      up,
      "/v1/responses",
      init(token, {
        model: "openai/gpt-5",
        input: [
          { type: "message", role: "developer", content: [{ type: "input_text", text: "Use tools." }] },
          { role: "user", content: [{ type: "input_text", text: "List files" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
          { type: "reasoning", id: "rs_1", summary: [] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Sure." }] },
          { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"cmd":"pwd"}' },
          { type: "function_call_output", call_id: "call_1", output: "/home" },
        ],
        tools: [
          { type: "function", name: "shell", description: "Run", parameters: { type: "object", properties: { cmd: { type: "string" } } }, strict: false },
          { type: "web_search" },
        ],
        tool_choice: { type: "function", name: "shell" },
        parallel_tool_calls: false,
      }),
    );
    expect(res.status).toBe(200);
    const sent = JSON.parse(up.bodies[0]!);
    expect(sent.messages).toEqual([
      { role: "system", content: "Use tools." },
      { role: "user", content: [{ type: "text", text: "List files" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } }] },
      { role: "assistant", content: "Sure.", tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"cmd":"pwd"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "/home" },
    ]);
    expect(sent.tools).toEqual([{ type: "function", function: { name: "shell", description: "Run", parameters: { type: "object", properties: { cmd: { type: "string" } } }, strict: false } }]);
    expect(sent.tool_choice).toEqual({ type: "function", function: { name: "shell" } });
    expect(sent.parallel_tool_calls).toBe(false);

    const out = JSON.parse(text);
    expect(out.output).toEqual([{ type: "function_call", id: expect.stringMatching(/^fc_/), call_id: "call_2", name: "shell", arguments: '{"cmd":"ls"}', status: "completed" }]);
  });

  it("marks an answer cut by the token limit as incomplete", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() => json(completion({ content: "par" }, "length")));
    const { text } = await call(up, "/v1/responses", init(token, { model: "openai/gpt-5", input: "hi" }));
    const out = JSON.parse(text);
    expect(out.status).toBe("incomplete");
    expect(out.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("streams text as Responses events ending in response.completed with usage", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() => chunked([chunk({ role: "assistant", content: "Hel" }), chunk({ content: "lo" }), chunk({}, "stop") + usageChunk, "data: [DONE]\n\n"], SSE));
    const { res, text } = await call(up, "/v1/responses", init(token, { model: "openai/gpt-5", input: "hi", stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sent = JSON.parse(up.bodies[0]!);
    expect(sent).toMatchObject({ stream: true, stream_options: { include_usage: true } });

    const evs = events(text);
    expect(evs.map((e) => e.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(evs.map((e) => e.sequence_number)).toEqual(evs.map((_, i) => i));
    expect(evs[0]!.response).toMatchObject({ status: "in_progress", output: [] });
    expect(evs[6]).toMatchObject({ text: "Hello", output_index: 0, content_index: 0 });
    const done = evs.at(-1)!.response;
    expect(done.status).toBe("completed");
    expect(done.output[0].content[0].text).toBe("Hello");
    expect(done.usage).toMatchObject({ input_tokens: 12, output_tokens: 3, total_tokens: 15 });
    expect(await usageRows("app")).toHaveLength(1);
  });

  it("streams tool calls as function_call items with argument deltas", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() =>
      chunked(
        [
          chunk({ role: "assistant", content: "Running." }),
          chunk({ tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "shell", arguments: "" } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }),
          chunk({}, "tool_calls"),
          "data: [DONE]\n\n",
        ],
        SSE,
      ),
    );
    const { text } = await call(up, "/v1/responses", init(token, { model: "openai/gpt-5", input: "hi", stream: true }));
    const evs = events(text);
    const types = evs.map((e) => e.type);
    expect(types).toContain("response.function_call_arguments.delta");
    const added = evs.filter((e) => e.type === "response.output_item.added");
    expect(added.map((e) => e.item.type)).toEqual(["message", "function_call"]);
    expect(added[1]!).toMatchObject({ output_index: 1, item: { call_id: "call_9", name: "shell", arguments: "", status: "in_progress" } });
    const argsDone = evs.find((e) => e.type === "response.function_call_arguments.done")!;
    expect(argsDone).toMatchObject({ output_index: 1, arguments: '{"cmd":"ls"}', item_id: added[1]!.item.id });
    // The message item closes before the tool call is added.
    expect(types.indexOf("response.output_text.done")).toBeLessThan(types.lastIndexOf("response.output_item.added"));
    const done = evs.at(-1)!;
    expect(done.type).toBe("response.completed");
    expect(done.response.output.map((o: { type: string }) => o.type)).toEqual(["message", "function_call"]);
    expect(done.response.output[1]).toMatchObject({ call_id: "call_9", arguments: '{"cmd":"ls"}', status: "completed" });
  });

  it("ends a stream the provider cut short with response.failed", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() => chunked([chunk({ role: "assistant", content: "Hel" })], SSE));
    const { text } = await call(up, "/v1/responses", init(token, { model: "openai/gpt-5", input: "hi", stream: true }));
    const evs = events(text);
    expect(evs.at(-1)!.type).toBe("response.failed");
    expect(evs.at(-1)!.response.status).toBe("failed");
  });

  it("refuses a bad body, a missing token and previous_response_id", async () => {
    const token = await addSystem("app");
    const up = fakeUpstream(() => json(completion({ content: "x" })));
    expect((await call(up, "/v1/responses", init(token, "{nope"))).res.status).toBe(400);
    expect((await call(up, "/v1/responses", init(token, { model: "openai/gpt-5" }))).res.status).toBe(400);
    const prev = await call(up, "/v1/responses", init(token, { model: "openai/gpt-5", input: "hi", previous_response_id: "resp_1" }));
    expect(prev.res.status).toBe(400);
    expect(JSON.parse(prev.text).error.message).toContain("previous_response_id");
    const anon = await call(up, "/v1/responses", init(null, { model: "openai/gpt-5", input: "hi" }));
    expect(anon.res.status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("passes a provider error on in the OpenAI error shape, also at /openai/v1/responses", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const up = fakeUpstream(() => json({ error: { message: "bad model", type: "invalid_request_error" } }, 400));
    const { res, text } = await call(up, "/openai/v1/responses", init(token, { model: "openai/gpt-5", input: "hi", stream: true }));
    expect(res.status).toBe(400);
    expect(JSON.parse(text).error.message).toBeTruthy();
  });
});
