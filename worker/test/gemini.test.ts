import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addSystem, call, fakeUpstream, reset, usageRows } from "./helpers";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const allow = (id: string, patterns: string[]) => env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(patterns), id).run();

/** A Gemini request, the gateway token in `x-goog-api-key` (what the Google GenAI SDK and Gemini CLI send). */
const gem = (token: string | null, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { "x-goog-api-key": token } : {}), ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const COMPLETION = {
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "gpt-5-2026",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 } },
};

const sseChat = (chunks: unknown[]) => chunks.map((ch) => `data: ${JSON.stringify(ch)}\n\n`).join("") + "data: [DONE]\n\n";

const STREAM = [
  { id: "c", object: "chat.completion.chunk", model: "gpt-5-2026", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
  { id: "c", object: "chat.completion.chunk", model: "gpt-5-2026", choices: [{ index: 0, delta: { content: "Hel" } }] },
  { id: "c", object: "chat.completion.chunk", model: "gpt-5-2026", choices: [{ index: 0, delta: { content: "lo" } }] },
  {
    id: "c",
    object: "chat.completion.chunk",
    model: "gpt-5-2026",
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_up", type: "function", function: { name: "weather", arguments: '{"city":' } }] } }],
  },
  { id: "c", object: "chat.completion.chunk", model: "gpt-5-2026", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Hanoi"}' } }] } }] },
  { id: "c", object: "chat.completion.chunk", model: "gpt-5-2026", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  { id: "c", object: "chat.completion.chunk", model: "gpt-5-2026", choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } },
];

/** What both stream forms carry, chunk by chunk. */
const STREAM_OUT = [
  { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] }, index: 0 }], modelVersion: "gpt-5-2026", responseId: "c" },
  { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] }, index: 0 }], modelVersion: "gpt-5-2026", responseId: "c" },
  {
    candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call_up", name: "weather", args: { city: "Hanoi" } } }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 12 },
    modelVersion: "gpt-5-2026",
    responseId: "c",
  },
];

beforeEach(reset);

describe("POST /v1beta/models/{model}:generateContent", () => {
  it("translates text, image, system instruction and generationConfig, answers a GenerateContentResponse and meters it", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    const { res, text } = await call(
      up,
      "/v1beta/models/openai%2Fgpt-5:generateContent",
      gem(token, {
        contents: [{ role: "user", parts: [{ text: "hi" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] }],
        systemInstruction: { parts: [{ text: "Be brief." }] },
        generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 100, stopSequences: ["END"], thinkingConfig: { thinkingBudget: 8000 } },
      }),
    );
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer sk-test-openai");
    expect(JSON.parse(up.bodies[0]!)).toEqual({
      model: "gpt-5",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      ],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 100,
      stop: ["END"],
      reasoning_effort: "medium",
    });
    expect(JSON.parse(text)).toEqual({
      candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24, cachedContentTokenCount: 5 },
      modelVersion: "gpt-5-2026",
      responseId: "chatcmpl-up",
    });
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "openai", model: "gpt-5-2026", input_tokens: 15, output_tokens: 4 })]);
  });

  it("takes the token from Authorization: Bearer and the model as models/<provider>/<model>; length is MAX_TOKENS", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json({ ...COMPLETION, choices: [{ index: 0, message: { role: "assistant", content: "cut" }, finish_reason: "length" }] }));
    const { res, text } = await call(
      up,
      "/v1beta/models/models/openai/gpt-5:generateContent",
      gem(null, { contents: [{ parts: [{ text: "hi" }] }] }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(up.bodies[0]!)).toEqual({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] });
    expect(JSON.parse(text).candidates[0].finishReason).toBe("MAX_TOKENS");
  });

  it("round-trips a tool call: declarations, toolConfig, functionCall and functionResponse", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() =>
      json({
        ...COMPLETION,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [{ id: "call_up", type: "function", function: { name: "weather", arguments: '{"city":"Hanoi"}' } }] },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const { res, text } = await call(
      up,
      "/v1beta/models/openai%2Fgpt-5:generateContent",
      gem(token, {
        contents: [
          { role: "user", parts: [{ text: "Weather?" }] },
          { role: "model", parts: [{ text: "Checking." }, { functionCall: { name: "weather", args: { city: "Hue" } } }] },
          { role: "user", parts: [{ functionResponse: { name: "weather", response: { temp: 30 } } }, { text: "And Hanoi?" }] },
        ],
        tools: [
          {
            functionDeclarations: [
              { name: "weather", description: "Weather", parameters: { type: "OBJECT", properties: { city: { type: "STRING" } }, required: ["city"] } },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["weather"] } },
      }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(up.bodies[0]!)).toEqual({
      model: "gpt-5",
      messages: [
        { role: "user", content: "Weather?" },
        { role: "assistant", content: "Checking.", tool_calls: [{ id: "call_0", type: "function", function: { name: "weather", arguments: '{"city":"Hue"}' } }] },
        { role: "tool", tool_call_id: "call_0", content: '{"temp":30}' },
        { role: "user", content: "And Hanoi?" },
      ],
      tools: [
        { type: "function", function: { name: "weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } },
      ],
      tool_choice: { type: "function", function: { name: "weather" } },
    });
    expect(JSON.parse(text).candidates[0]).toEqual({
      content: { role: "model", parts: [{ functionCall: { id: "call_up", name: "weather", args: { city: "Hanoi" } } }] },
      finishReason: "STOP",
      index: 0,
    });
  });

  it("refuses a body that is not JSON, or has no contents, with Google's 400", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    for (const body of ["not json", { contents: [] }, { contents: "x" }]) {
      const { res, text } = await call(up, "/v1beta/models/openai%2Fgpt-5:generateContent", gem(token, body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(text).error).toMatchObject({ code: 400, status: "INVALID_ARGUMENT" });
    }
    expect(up.calls).toHaveLength(0);
  });

  it("refuses a missing or wrong token with Google's 401", async () => {
    const up = fakeUpstream(() => json(COMPLETION));
    for (const init of [gem(null, { contents: [{ parts: [{ text: "hi" }] }] }), gem("xllm_wrong", { contents: [{ parts: [{ text: "hi" }] }] })]) {
      const { res, text } = await call(up, "/v1beta/models/openai%2Fgpt-5:generateContent", init);
      expect(res.status).toBe(401);
      expect(JSON.parse(text).error).toMatchObject({ code: 401, status: "UNAUTHENTICATED" });
    }
    expect(up.calls).toHaveLength(0);
  });

  it("passes a provider error on with its status in Google's shape", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json({ error: { message: "slow down", type: "rate_limit" } }, 429));
    const { res, text } = await call(up, "/v1beta/models/openai%2Fgpt-5:generateContent", gem(token, { contents: [{ parts: [{ text: "hi" }] }] }));
    expect(res.status).toBe(429);
    expect(JSON.parse(text)).toEqual({ error: { code: 429, message: "slow down", status: "RESOURCE_EXHAUSTED" } });
  });

  it("accepts the token as ?key= and never writes it to the log table", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    const { res } = await call(up, `/v1beta/models/openai%2Fgpt-5:generateContent?key=${encodeURIComponent(token)}`, gem(null, { contents: [{ parts: [{ text: "hi" }] }] }));
    expect(res.status).toBe(200);
    const rows = (await env.DB.prepare("SELECT * FROM log").all()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: "POST", path: "/v1beta/models/openai%2Fgpt-5:generateContent", status: 200, system_id: "chat" });
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain("key=");
  });
});

describe("POST /v1beta/models/{model}:streamGenerateContent", () => {
  it("with alt=sse answers data: lines, text as it comes, tool call and usage on the last", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => new Response(sseChat(STREAM), { headers: { "content-type": "text/event-stream" } }));
    const { res, text } = await call(up, "/v1beta/models/openai%2Fgpt-5:streamGenerateContent?alt=sse", gem(token, { contents: [{ parts: [{ text: "hi" }] }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sent = JSON.parse(up.bodies[0]!);
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    const events = text.split("\n\n").filter(Boolean);
    expect(events.every((e) => e.startsWith("data: "))).toBe(true);
    expect(events.map((e) => JSON.parse(e.slice(6)))).toEqual(STREAM_OUT);
    expect(await usageRows("chat")).toEqual([expect.objectContaining({ provider: "openai", streamed: 1, input_tokens: 9, output_tokens: 3 })]);
  });

  it("without alt=sse answers one JSON array of the same chunks", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => new Response(sseChat(STREAM), { headers: { "content-type": "text/event-stream" } }));
    const { res, text } = await call(up, "/v1beta/models/openai%2Fgpt-5:streamGenerateContent", gem(token, { contents: [{ parts: [{ text: "hi" }] }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(text)).toEqual(STREAM_OUT);
  });
});

describe("GET /v1beta/models", () => {
  it("lists what /v1/models lists, as models/<id>", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json({ data: [] }));
    const openai = JSON.parse((await call(up, "/v1/models", { headers: { authorization: `Bearer ${token}` } })).text) as { data: { id: string }[] };
    const { res, text } = await call(up, "/v1beta/models", { headers: { "x-goog-api-key": token } });
    expect(res.status).toBe(200);
    const out = JSON.parse(text) as { models: { name: string; supportedGenerationMethods: string[] }[] };
    expect(openai.data.length).toBeGreaterThan(0);
    expect(out.models.map((m) => m.name)).toEqual(openai.data.map((m) => `models/${m.id}`));
    expect(out.models[0]!.supportedGenerationMethods).toEqual(["generateContent", "streamGenerateContent", "countTokens"]);
  });

  it("needs the token", async () => {
    const { res, text } = await call(fakeUpstream(() => json({})), "/v1beta/models");
    expect(res.status).toBe(401);
    expect(JSON.parse(text).error.status).toBe("UNAUTHENTICATED");
  });
});

describe("countTokens", () => {
  it("answers an estimate of the request's tokens, with no provider call and no usage row", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json({}));
    const text = "a".repeat(400);
    const { res, text: out } = await call(up, "/v1beta/models/openai%2Fgpt-5:countTokens", gem(token, { contents: [{ role: "user", parts: [{ text }] }] }));
    expect(res.status, out).toBe(200);
    const n = (JSON.parse(out) as { totalTokens: number }).totalTokens;
    expect(n).toBeGreaterThanOrEqual(90);
    expect(n).toBeLessThanOrEqual(130);
    expect(up.calls).toHaveLength(0);
    expect(await usageRows("chat")).toHaveLength(0);
  });

  it("reads generateContentRequest too, and refuses a model the system may not use", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json({}));
    const ok = await call(up, "/v1beta/models/openai%2Fgpt-5:countTokens", gem(token, { generateContentRequest: { contents: [{ parts: [{ text: "hello there" }] }] } }));
    expect((JSON.parse(ok.text) as { totalTokens: number }).totalTokens).toBeGreaterThan(0);
    const no = await call(up, "/v1beta/models/groq%2Fllama:countTokens", gem(token, { contents: [{ parts: [{ text: "hi" }] }] }));
    expect(no.res.status).toBe(403);
    expect(JSON.parse(no.text).error.status).toBe("PERMISSION_DENIED");
  });
});

describe("embedContent", () => {
  const EMB = { object: "list", data: [{ index: 0, embedding: [0.1, 0.2] }], model: "text-embedding-x", usage: { prompt_tokens: 5, total_tokens: 5 } };

  it("sends the text to the provider's embeddings endpoint and answers in Gemini's shape", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json(EMB));
    const { res, text } = await call(up, "/v1beta/models/openai%2Ftext-embedding-x:embedContent", gem(token, { content: { parts: [{ text: "hello" }, { text: "world" }] } }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({ embedding: { values: [0.1, 0.2] } });
    expect(up.calls[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer sk-test-openai");
    expect(JSON.parse(up.bodies[0]!)).toEqual({ model: "text-embedding-x", input: "hello\nworld" });
    const rows = await usageRows("chat");
    expect(rows[0]).toMatchObject({ provider: "openai", input_tokens: 5 });
  });

  it("batchEmbedContents sends every text in one call and keeps their order", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json({ ...EMB, data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }));
    const body = { requests: [{ content: { parts: [{ text: "a" }] } }, { content: { parts: [{ text: "b" }] } }] };
    const { res, text } = await call(up, "/v1beta/models/openai%2Ftext-embedding-x:batchEmbedContents", gem(token, body));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({ embeddings: [{ values: [1] }, { values: [2] }] });
    expect(JSON.parse(up.bodies[0]!)).toEqual({ model: "text-embedding-x", input: ["a", "b"] });
  });

  it("passes a provider error on in Google's shape", async () => {
    const token = await addSystem("chat");
    await allow("chat", ["openai/*"]);
    const up = fakeUpstream(() => json({ error: { message: "bad input" } }, 400));
    const { res, text } = await call(up, "/v1beta/models/openai%2Ftext-embedding-x:embedContent", gem(token, { content: { parts: [{ text: "x" }] } }));
    expect(res.status).toBe(400);
    expect(JSON.parse(text).error).toMatchObject({ code: 400, status: "INVALID_ARGUMENT", message: "bad input" });
  });
});
