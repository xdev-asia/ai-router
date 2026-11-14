import { describe, expect, it } from "vitest";
import { chatToGeminiRequest, geminiStreamToChat, geminiToChatResponse } from "../gemini";

type Json = Record<string, unknown>;

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("")).body!;

async function chunks(stream: ReadableStream<Uint8Array>): Promise<{ data: Json[]; done: boolean }> {
  const text = await new Response(stream).text();
  const lines = text.split("\n\n").filter(Boolean).map((b) => b.replace(/^data: /, ""));
  return { data: lines.filter((l) => l !== "[DONE]").map((l) => JSON.parse(l) as Json), done: lines.at(-1) === "[DONE]" };
}

describe("chat request -> Gemini request", () => {
  it("puts system messages in systemInstruction and turns roles and settings into Gemini's", () => {
    const g = chatToGeminiRequest({
      model: "gemini-2.5-pro",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "developer", content: [{ type: "text", text: "Use English." }] },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
      ],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 100,
      stop: "END",
      seed: 7,
      response_format: { type: "json_object" },
    });
    expect(g.systemInstruction).toEqual({ role: "user", parts: [{ text: "Be brief.\n\nUse English." }] });
    expect(g.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
      { role: "user", parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }] },
    ]);
    expect(g.generationConfig).toEqual({ temperature: 0.2, topP: 0.9, maxOutputTokens: 100, stopSequences: ["END"], seed: 7, responseMimeType: "application/json" });
  });

  it("sends tool calls as functionCall parts and tool answers as functionResponse parts named after the call", () => {
    const g = chatToGeminiRequest({
      model: "gemini-2.5-flash",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "weather", arguments: '{"city":"Hanoi"}' }, extra_content: { google: { thought_signature: "sig-1" } } },
            { id: "call_b", type: "function", function: { name: "time", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: '{"temp":30}' },
        { role: "tool", tool_call_id: "call_b", content: "noon" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Weather for a city",
            parameters: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false, properties: { city: { type: ["string", "null"], const: "Hanoi" } }, required: ["city"] },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "weather" } },
    });
    expect(g.contents).toEqual([
      { role: "user", parts: [{ text: "weather?" }] },
      { role: "model", parts: [{ functionCall: { name: "weather", args: { city: "Hanoi" } }, thoughtSignature: "sig-1" }, { functionCall: { name: "time", args: {} } }] },
      {
        role: "user",
        parts: [{ functionResponse: { name: "weather", response: { temp: 30 } } }, { functionResponse: { name: "time", response: { result: "noon" } } }],
      },
    ]);
    // Gemini's schema has no $schema, additionalProperties or const, and says nullable instead of a null type.
    expect(g.tools).toEqual([
      { functionDeclarations: [{ name: "weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string", nullable: true, enum: ["Hanoi"] } }, required: ["city"] } }] },
    ]);
    expect(g.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["weather"] } });
  });

  it("reads reasoning_effort as a thinking level for Gemini 3 and a budget for the others", () => {
    expect(chatToGeminiRequest({ model: "gemini-3-pro-preview", messages: [{ role: "user", content: "x" }], reasoning_effort: "xhigh" }).generationConfig).toEqual({
      thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
    });
    expect(chatToGeminiRequest({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "x" }], reasoning_effort: "low" }).generationConfig).toEqual({
      thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
    });
  });

  it("refuses an image given by address: only data URLs can be sent", () => {
    expect(() => chatToGeminiRequest({ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] })).toThrow(/data: URL/);
  });

  it("refuses a request with no messages", () => {
    expect(() => chatToGeminiRequest({ model: "m", messages: [] })).toThrow(/messages/);
  });
});

describe("Gemini answer -> chat completion", () => {
  it("reads text, thoughts, function calls (keeping their signature) and usage, also inside Cloud Code's envelope", () => {
    const answer = {
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: "thinking...", thought: true },
                { text: "Sure." },
                { functionCall: { name: "weather", args: { city: "Hanoi" } }, thoughtSignature: "sig-9" },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 3, cachedContentTokenCount: 2, totalTokenCount: 17 },
        responseId: "r1",
      },
    };
    const c = geminiToChatResponse(answer, "gemini-2.5-pro");
    expect(c).toMatchObject({ object: "chat.completion", model: "gemini-2.5-pro" });
    const choice = (c.choices as Json[])[0]!;
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message).toMatchObject({
      role: "assistant",
      content: "Sure.",
      reasoning_content: "thinking...",
      tool_calls: [{ index: 0, type: "function", function: { name: "weather", arguments: '{"city":"Hanoi"}' }, extra_content: { google: { thought_signature: "sig-9" } } }],
    });
    expect(c.usage).toEqual({ prompt_tokens: 10, completion_tokens: 7, total_tokens: 17, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } });
  });

  it("says length for MAX_TOKENS and content_filter for SAFETY", () => {
    const of = (finishReason: string) => ((geminiToChatResponse({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason }] }, "m").choices as Json[])[0]!.finish_reason);
    expect(of("MAX_TOKENS")).toBe("length");
    expect(of("SAFETY")).toBe("content_filter");
    expect(of("STOP")).toBe("stop");
  });
});

describe("Gemini stream -> chat stream", () => {
  it("streams text and thoughts as deltas, then the calls, the finish reason, the usage chunk and [DONE]", async () => {
    const { data, done } = await chunks(
      geminiStreamToChat(
        sse([
          { response: { candidates: [{ content: { role: "model", parts: [{ text: "hmm", thought: true }] } }] } },
          { response: { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] } },
          { response: { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] } }] } },
          { response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "f", args: { a: 1 } }, thoughtSignature: "sig-2" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } } },
        ]),
        "gemini-2.5-flash",
      ),
    );
    expect(done).toBe(true);
    const deltas = data.filter((d) => (d.choices as Json[]).length).map((d) => (d.choices as Json[])[0]!);
    expect(deltas[0]!.delta).toEqual({ role: "assistant", reasoning_content: "hmm" });
    expect(deltas.map((d) => (d.delta as Json).content).filter(Boolean).join("")).toBe("Hello");
    const calls = deltas.flatMap((d) => ((d.delta as Json).tool_calls as Json[] | undefined) ?? []);
    expect(calls).toEqual([{ index: 0, id: expect.stringMatching(/^call_/), type: "function", function: { name: "f", arguments: '{"a":1}' }, extra_content: { google: { thought_signature: "sig-2" } } }]);
    expect(deltas.at(-1)!.finish_reason).toBe("tool_calls");
    const usage = data.at(-1)!;
    expect(usage.choices).toEqual([]);
    expect(usage.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
    expect(data.every((d) => d.model === "gemini-2.5-flash" && d.object === "chat.completion.chunk")).toBe(true);
  });

  it("passes an error inside the stream on as an error event", async () => {
    const { data } = await chunks(geminiStreamToChat(sse([{ error: { code: 429, message: "quota exhausted", status: "RESOURCE_EXHAUSTED" } }]), "m"));
    expect(data).toEqual([{ error: { message: "quota exhausted", type: "api_error", code: 429 } }]);
  });
});
