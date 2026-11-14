import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, sse, usageRows, type FakeUpstream } from "./helpers";
import { sigV4 } from "../wire";

// The ported providers (worker/wire.ts). Fake keys and hosts only: every secret here is made up (the AWS
// pair is AWS's own published example), and the Vertex service account's RSA key is generated per run.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const COMPLETION = {
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "up-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
};
const MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "up-claude", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 } };
const COMPLETED = { type: "response.completed", response: { id: "resp_1", model: "up-model", usage: { input_tokens: 14, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } } } };
const HELLO = [{ type: "response.created", response: { id: "resp_1" } }, { type: "response.output_text.delta", delta: "Hel" }, { type: "response.output_text.delta", delta: "lo" }, COMPLETED];
const sseResponse = (events: unknown[]) => new Response(sse(events), { headers: { "content-type": "text/event-stream" } });

const admin = (method: string, path: string, body?: unknown, up: FakeUpstream = fakeUpstream(() => json({}))) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const chat = (token: string, model: string, extra: Record<string, unknown> = {}) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
});

const allow = (id: string) => env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(["*"]), id).run();

async function connect(provider: string, apiKey: string, settings?: Record<string, string>): Promise<string> {
  const r = await admin("POST", "/connections", { provider, name: "main", api_key: apiKey, ...(settings ? { settings } : {}) });
  expect(r.res.status, r.text).toBe(201);
  return (JSON.parse(r.text) as { id: string }).id;
}

async function system(): Promise<string> {
  const token = await addSystem("app");
  await allow("app");
  return token;
}

/** None of `secrets` is in the answers, the usage rows, the log, the request details, or the console's lists. */
async function noLeak(secrets: string[], answers: string[]): Promise<void> {
  const stored = [
    JSON.stringify(await usageRows("app")),
    JSON.stringify((await env.DB.prepare("SELECT * FROM log").all()).results),
    JSON.stringify((await env.DB.prepare("SELECT * FROM request_detail").all()).results),
    (await admin("GET", "/connections")).text,
    (await admin("GET", "/providers")).text,
  ];
  for (const text of [...answers, ...stored]) for (const s of secrets) expect(text.includes(s), `leaked ${s.slice(0, 6)}...`).toBe(false);
}

const header = (up: FakeUpstream, i: number, name: string) => up.calls[i]?.headers.get(name) ?? null;
const sent = (up: FakeUpstream, i = 0) => JSON.parse(up.bodies[i] ?? "null") as Record<string, unknown>;

beforeEach(reset);

describe("ported OpenAI-compatible providers", () => {
  const cases: [provider: string, model: string, url: string][] = [
    ["opencode-go", "deepseek-flash", "https://opencode.ai/inference/go/openai/v1/chat/completions"],
    ["opencode-zen", "kimi-k3", "https://opencode.ai/zen/v1/chat/completions"],
    ["synthetic", "hf:zai-org/GLM-5", "https://api.synthetic.new/openai/v1/chat/completions"],
    ["xiaomi-tokenplan", "mimo-v2-pro", "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions"],
    ["api-airforce", "gpt-4o-mini", "https://api.airforce/v1/chat/completions"],
    ["kimchi", "kimi-k2", "https://llm.kimchi.dev/openai/v1/chat/completions"],
    ["minimax", "MiniMax-M2.7", "https://api.minimax.io/v1/chat/completions"],
    ["minimax-cn", "MiniMax-M2.7", "https://api.minimaxi.com/v1/chat/completions"],
    ["ollama", "gpt-oss:120b", "https://ollama.com/v1/chat/completions"],
  ];
  for (const [provider, model, url] of cases) {
    it(`${provider} sends Chat Completions to ${new URL(url).host}`, async () => {
      const key = `sk-fake-${provider}-000000000000`;
      await connect(provider, key);
      const token = await system();
      const up = fakeUpstream(() => json(COMPLETION));
      const { res, text } = await call(up, "/v1/chat/completions", chat(token, `${provider}/${model}`));
      expect(res.status, text).toBe(200);
      expect(up.calls[0]!.url).toBe(url);
      expect(header(up, 0, "authorization")).toBe(`Bearer ${key}`);
      expect(sent(up).model).toBe(model);
      expect((JSON.parse(text) as typeof COMPLETION).choices[0]!.message.content).toBe("hello");
      expect(await usageRows("app")).toEqual([expect.objectContaining({ provider, status: 200, input_tokens: 20, output_tokens: 4 })]);
      await noLeak([key], [text]);
    });
  }

  it("kimchi sends the user agent its service expects", async () => {
    await connect("kimchi", "sk-fake-kimchi-000000000000");
    const up = fakeUpstream(() => json(COMPLETION));
    await call(up, "/v1/chat/completions", chat(await system(), "kimchi/kimi-k2"));
    expect(header(up, 0, "user-agent")).toBe("kimchi/0.1.50");
  });

  it("xiaomi-tokenplan goes to the region the connection names, and refuses an unknown one", async () => {
    await connect("xiaomi-tokenplan", "sk-fake-xiaomi-000000000000", { region: "ams" });
    const up = fakeUpstream(() => json(COMPLETION));
    await call(up, "/v1/chat/completions", chat(await system(), "xiaomi-tokenplan/mimo-v2-pro"));
    expect(up.calls[0]!.url).toBe("https://token-plan-ams.xiaomimimo.com/v1/chat/completions");
    const bad = await admin("POST", "/connections", { provider: "xiaomi-tokenplan", name: "x", api_key: "sk-fake-xiaomi-1", settings: { region: "moon" } });
    expect(bad.res.status).toBe(400);
    const unknown = await admin("POST", "/connections", { provider: "openai", name: "x", api_key: "sk-fake-openai-1", settings: { region: "ams" } });
    expect(unknown.res.status).toBe(400);
  });
});

describe("Anthropic-format lanes", () => {
  const cases: [provider: string, model: string, url: string][] = [
    ["minimax", "MiniMax-M3", "https://api.minimax.io/anthropic/v1/messages?beta=true"],
    ["minimax-cn", "MiniMax-M3", "https://api.minimaxi.com/anthropic/v1/messages?beta=true"],
    ["opencode-zen", "claude-fable-5", "https://opencode.ai/zen/v1/messages"],
    ["opencode-go", "claude-fable-5", "https://opencode.ai/inference/go/anthropic/v1/messages"],
  ];
  for (const [provider, model, url] of cases) {
    it(`${provider}/${model} is sent as a Messages request`, async () => {
      const key = `sk-fake-${provider}-111111111111`;
      await connect(provider, key);
      const up = fakeUpstream(() => json(MESSAGE));
      const { res, text } = await call(up, "/v1/chat/completions", chat(await system(), `${provider}/${model}`));
      expect(res.status, text).toBe(200);
      expect(up.calls[0]!.url).toBe(url);
      expect(header(up, 0, "x-api-key")).toBe(key);
      expect(header(up, 0, "authorization")).toBeNull();
      expect(header(up, 0, "anthropic-version")).toBe("2023-06-01");
      expect(sent(up)).toMatchObject({ model, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
      expect(JSON.parse(text)).toMatchObject({ object: "chat.completion", choices: [{ message: { role: "assistant", content: "hi" } }] });
      expect(await usageRows("app")).toEqual([expect.objectContaining({ provider, input_tokens: 7, output_tokens: 3 })]);
      await noLeak([key], [text]);
    });
  }
});

describe("Responses-format lanes", () => {
  it("perplexity-agent: a chat request goes out as a streamed Responses request and comes back as a completion", async () => {
    const key = "pplx-fake-000000000000";
    await connect("perplexity-agent", key);
    const up = fakeUpstream(() => sseResponse(HELLO));
    const { res, text } = await call(up, "/v1/chat/completions", chat(await system(), "perplexity-agent/openai/gpt-5.5", { max_tokens: 50, temperature: 0.2 }));
    expect(res.status, text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://api.perplexity.ai/v1/responses");
    expect(header(up, 0, "authorization")).toBe(`Bearer ${key}`);
    const body = sent(up);
    expect(body).toMatchObject({ model: "openai/gpt-5.5", stream: true, max_output_tokens: 50, temperature: 0.2, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] });
    // No system message: no instructions. No reasoning asked: none sent.
    expect(body).not.toHaveProperty("instructions");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("include");
    expect(body).not.toHaveProperty("max_tokens");
    expect(JSON.parse(text)).toMatchObject({ choices: [{ message: { content: "Hello" } }], usage: { prompt_tokens: 14, completion_tokens: 3 } });
    expect(await usageRows("app")).toEqual([expect.objectContaining({ provider: "perplexity-agent", input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4 })]);
    await noLeak([key], [text]);
  });

  it("perplexity-agent streams chat chunks, with the system message as instructions", async () => {
    await connect("perplexity-agent", "pplx-fake-000000000000");
    const up = fakeUpstream(() => sseResponse(HELLO));
    const init = chat(await system(), "perplexity-agent/perplexity/sonar", { stream: true, reasoning_effort: "high" });
    const b = JSON.parse(init.body) as { messages: unknown[] };
    b.messages.unshift({ role: "system", content: "be brief" });
    const { res, text } = await call(up, "/v1/chat/completions", { ...init, body: JSON.stringify(b) });
    expect(res.status, text).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(sent(up)).toMatchObject({ instructions: "be brief", reasoning: { effort: "high" } });
    expect(text).toContain('"content":"Hel"');
    expect(text).toContain("data: [DONE]");
  });

  it("opencode-go sends grok models to its Responses endpoint", async () => {
    await connect("opencode-go", "sk-fake-opencode-go-000000");
    const up = fakeUpstream(() => sseResponse(HELLO));
    const { res } = await call(up, "/v1/chat/completions", chat(await system(), "opencode-go/grok-5"));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe("https://opencode.ai/inference/go/openai/v1/responses");
  });

  it("a Responses failure keeps its status and is not shown as a success", async () => {
    await connect("perplexity-agent", "pplx-fake-000000000000");
    const up = fakeUpstream(() => json({ error: { message: "bad model", type: "invalid_request_error" } }, 400));
    const { res, text } = await call(up, "/v1/chat/completions", chat(await system(), "perplexity-agent/nope"));
    expect(res.status).toBe(400);
    expect(text).toContain("bad model");
  });
});

describe("providers with connection settings", () => {
  it("cloudflare-ai needs an account id and calls that account's endpoint", async () => {
    const key = "cf-fake-token-000000000000";
    const missing = await admin("POST", "/connections", { provider: "cloudflare-ai", name: "x", api_key: key });
    expect(missing.res.status).toBe(400);
    expect(missing.text).toContain("account_id");
    await connect("cloudflare-ai", key, { account_id: "0123456789abcdef0123456789abcdef" });
    const up = fakeUpstream(() => json(COMPLETION));
    const { res, text } = await call(up, "/v1/chat/completions", chat(await system(), "cloudflare-ai/@cf/meta/llama-4-scout"));
    expect(res.status, text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions");
    expect(header(up, 0, "authorization")).toBe(`Bearer ${key}`);
    expect(sent(up).model).toBe("@cf/meta/llama-4-scout");
    await noLeak([key], [text]);
  });

  it("azure calls the deployment with an api-key header; settings merge on PATCH and are never returned", async () => {
    const key = "az-fake-key-000000000000";
    for (const settings of [{}, { endpoint: "http://corp.openai.azure.test" }, { endpoint: "https://corp.openai.azure.test", api_version: "latest" }]) {
      expect((await admin("POST", "/connections", { provider: "azure", name: "x", api_key: key, settings })).res.status, JSON.stringify(settings)).toBe(400);
    }
    const id = await connect("azure", key, { endpoint: "https://corp.openai.azure.test/", deployment: "gpt4o-prod" });
    const token = await system();
    const up = fakeUpstream(() => json(COMPLETION));
    const first = await call(up, "/v1/chat/completions", chat(token, "azure/gpt-4o"));
    expect(first.res.status, first.text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://corp.openai.azure.test/openai/deployments/gpt4o-prod/chat/completions?api-version=2024-10-01-preview");
    expect(header(up, 0, "api-key")).toBe(key);
    expect(header(up, 0, "authorization")).toBeNull();

    // A new deployment keeps the endpoint; a new key alone keeps both.
    expect((await admin("PATCH", `/connections/${id}`, { settings: { deployment: "" , api_version: "2025-01-01-preview" } })).res.status).toBe(200);
    expect((await admin("PATCH", `/connections/${id}`, { api_key: "az-fake-key-111111111111" })).res.status).toBe(200);
    expect((await admin("PATCH", `/connections/${id}`, { settings: { endpoint: "ftp://x" } })).res.status).toBe(400);
    await call(up, "/v1/chat/completions", chat(token, "azure/gpt-4o"));
    expect(up.calls[1]!.url).toBe("https://corp.openai.azure.test/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview");
    expect(header(up, 1, "api-key")).toBe("az-fake-key-111111111111");

    const listed = (await admin("GET", "/connections")).text;
    expect(listed).not.toContain("corp.openai.azure.test");
    const providers = JSON.parse((await admin("GET", "/providers")).text) as { id: string; settings?: { name: string }[] }[];
    expect(providers.find((p) => p.id === "azure")?.settings?.map((s) => s.name)).toEqual(["endpoint", "deployment", "api_version"]);
    await noLeak([key, "az-fake-key-111111111111"], [first.text]);
  });

  it("checks an azure key against the endpoint it names", async () => {
    const up = fakeUpstream(() => json({ data: [] }));
    const r = await admin("POST", "/connections/check", { provider: "azure", api_key: "az-fake-key-000000000000", settings: { endpoint: "https://corp.openai.azure.test" } }, up);
    expect(JSON.parse(r.text)).toEqual({ ok: true });
    expect(up.calls[0]!.url).toBe("https://corp.openai.azure.test/openai/models?api-version=2024-10-01-preview");
    expect(header(up, 0, "api-key")).toBe("az-fake-key-000000000000");
  });
});

// AWS's published example credentials (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-signing-request.html).
const AKID = "AKIDEXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

/** One AWS event-stream message (checksums left zero: the gateway does not check them). */
function frame(headers: Record<string, string>, payload: string): Uint8Array {
  const enc = new TextEncoder();
  const hs: number[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const name = enc.encode(k);
    const value = enc.encode(v);
    hs.push(name.length, ...name, 7, value.length >> 8, value.length & 255, ...value);
  }
  const body = enc.encode(payload);
  const total = 12 + hs.length + body.length + 4;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  dv.setUint32(4, hs.length);
  out.set(hs, 12);
  out.set(body, 12 + hs.length);
  return out;
}
const chunk = (inner: unknown) => frame({ ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" }, JSON.stringify({ bytes: btoa(JSON.stringify(inner)) }));
function eventStream(frames: Uint8Array[], split = 7): Response {
  const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) all.set(f, (at += f.length) - f.length);
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      // In small pieces, so a message is read across chunk edges.
      for (let i = 0; i < all.length; i += split) ctrl.enqueue(all.slice(i, i + split));
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/vnd.amazon.eventstream" } });
}

describe("AWS Bedrock", () => {
  it("signs requests as AWS's Signature Version 4 test suite expects (get-vanilla)", async () => {
    const h = await sigV4({ method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: "", accessKeyId: AKID, secretAccessKey: SECRET, region: "us-east-1", service: "service", date: new Date("2015-08-30T12:36:00Z") });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
  });

  it("sends a Claude model to invoke, signed, with Bedrock's body", async () => {
    expect((await admin("POST", "/connections", { provider: "bedrock", name: "x", api_key: SECRET, settings: { region: "us-west-2" } })).res.status).toBe(400);
    await connect("bedrock", SECRET, { access_key_id: AKID, region: "us-west-2", session_token: "fake-session-token-000" });
    const up = fakeUpstream(() => json(MESSAGE));
    const { res, text } = await call(up, "/v1/chat/completions", chat(await system(), "bedrock/us.anthropic.claude-opus-5:0"));
    expect(res.status, text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-opus-5%3A0/invoke");
    expect(header(up, 0, "authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(header(up, 0, "x-amz-security-token")).toBe("fake-session-token-000");
    const body = sent(up);
    expect(body).toMatchObject({ anthropic_version: "bedrock-2023-05-31", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("stream");
    expect(JSON.parse(text)).toMatchObject({ choices: [{ message: { content: "hi" } }] });
    expect(await usageRows("app")).toEqual([expect.objectContaining({ provider: "bedrock", input_tokens: 7, output_tokens: 3 })]);
    await noLeak([SECRET, "fake-session-token-000"], [text]);
  });

  it("streams a Claude model from its event stream", async () => {
    await connect("bedrock", SECRET, { access_key_id: AKID });
    const events = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "up-claude", content: [], usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi there" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const up = fakeUpstream(() => eventStream(events.map(chunk)));
    const { res, text } = await call(up, "/v1/chat/completions", chat(await system(), "br/anthropic.claude-sonnet-5", { stream: true }));
    expect(res.status, text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-5/invoke-with-response-stream");
    expect(text).toContain('"content":"Hi there"');
    expect(text).toContain("data: [DONE]");
    expect(await usageRows("app")).toEqual([expect.objectContaining({ provider: "bedrock", streamed: 1, input_tokens: 7, output_tokens: 3 })]);
  });

  it("reports an exception inside the event stream as an error", async () => {
    await connect("bedrock", SECRET, { access_key_id: AKID });
    const up = fakeUpstream(() => eventStream([frame({ ":message-type": "exception", ":exception-type": "throttlingException", ":content-type": "application/json" }, JSON.stringify({ message: "slow down" }))]));
    const { text } = await call(up, "/v1/chat/completions", chat(await system(), "bedrock/anthropic.claude-sonnet-5", { stream: true }));
    expect(text).toContain("slow down");
  });

  it("refuses a model of another family without calling AWS", async () => {
    await connect("bedrock", SECRET, { access_key_id: AKID });
    await connect("bedrock-xai", SECRET, { access_key_id: AKID });
    const token = await system();
    const up = fakeUpstream(() => json(MESSAGE));
    expect((await call(up, "/v1/chat/completions", chat(token, "bedrock/us.xai.grok-4.6"))).res.status).toBe(400);
    expect((await call(up, "/v1/chat/completions", chat(token, "bedrock-xai/us.anthropic.claude-opus-5"))).res.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });

  it("an AWS error keeps its status and message", async () => {
    await connect("bedrock", SECRET, { access_key_id: AKID });
    const up = fakeUpstream(() => json({ message: "The security token included in the request is invalid." }, 403));
    const { res, text } = await call(up, "/v1/chat/completions", chat(await system(), "bedrock/anthropic.claude-sonnet-5"));
    expect(res.status).toBe(403);
    expect(text).toContain("security token included");
  });

  it("bedrock-xai sends a Grok model's OpenAI body and streams its chunks", async () => {
    await connect("bedrock-xai", SECRET, { access_key_id: AKID, region: "us-east-2" });
    const token = await system();
    const up = fakeUpstream(() => json(COMPLETION));
    const plain = await call(up, "/v1/chat/completions", chat(token, "brx/us.xai.grok-4.6"));
    expect(plain.res.status, plain.text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://bedrock-runtime.us-east-2.amazonaws.com/model/us.xai.grok-4.6/invoke");
    expect(sent(up)).toMatchObject({ messages: [{ role: "user", content: "hi" }] });
    expect(sent(up)).not.toHaveProperty("model");
    expect(JSON.parse(plain.text)).toMatchObject({ choices: [{ message: { content: "hello" } }] });

    up.reply = () =>
      eventStream([
        chunk({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Gr" } }] }),
        chunk({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }),
      ]);
    const streamed = await call(up, "/v1/chat/completions", chat(token, "brx/us.xai.grok-4.6", { stream: true }));
    expect(up.calls[1]!.url).toBe("https://bedrock-runtime.us-east-2.amazonaws.com/model/us.xai.grok-4.6/invoke-with-response-stream");
    expect(streamed.text).toContain('"content":"Gr"');
    expect(streamed.text).toContain("data: [DONE]");
    await noLeak([SECRET], [plain.text, streamed.text]);
  });

  it("checks a key by listing the region's models", async () => {
    const up = fakeUpstream(() => json({ modelSummaries: [] }));
    const r = await admin("POST", "/connections/check", { provider: "bedrock", api_key: SECRET, settings: { access_key_id: AKID, region: "eu-west-1" } }, up);
    expect(JSON.parse(r.text)).toEqual({ ok: true });
    expect(up.calls[0]!.url).toBe("https://bedrock.eu-west-1.amazonaws.com/foundation-models");
    expect(header(up, 0, "authorization")).toContain("/eu-west-1/bedrock/aws4_request");
  });
});

/** A service account JSON with a fresh RSA key, and the public key to check what the gateway signs. */
async function serviceAccount(email: string, extra: Record<string, string> = {}): Promise<{ json: string; publicKey: CryptoKey; pem: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  const json = JSON.stringify({ type: "service_account", project_id: "fake-project", private_key_id: "fake-key-id", private_key: pem, client_email: email, ...extra });
  return { json, publicKey: pair.publicKey, pem: b64.slice(40, 120) };
}
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));

describe("Vertex AI", () => {
  it("signs a JWT for the service account, gets a token from Google, reuses it, and calls the regional endpoint", async () => {
    const sa = await serviceAccount("router@fake-project.iam.gserviceaccount.com", { token_uri: "https://evil.test/token" });
    await connect("vertex", sa.json, { location: "europe-west4" });
    const token = await system();
    const up = fakeUpstream((req) => (req.url.startsWith("https://oauth2.googleapis.com/") ? json({ access_token: "ya29.fake-access-token", expires_in: 3600, token_type: "Bearer" }) : json(COMPLETION)));
    const { res, text } = await call(up, "/v1/chat/completions", chat(token, "vertex/gemini-3.1-pro-preview"));
    expect(res.status, text).toBe(200);

    // Google's token endpoint, whatever token_uri the JSON names.
    expect(up.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(up.bodies[0]);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = form.get("assertion")!.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toMatchObject({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(c))) as Record<string, number | string>;
    expect(claims).toMatchObject({ iss: "router@fake-project.iam.gserviceaccount.com", aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/cloud-platform" });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", sa.publicKey, fromB64url(s), new TextEncoder().encode(`${h}.${c}`))).toBe(true);

    expect(up.calls[1]!.url).toBe("https://europe-west4-aiplatform.googleapis.com/v1/projects/fake-project/locations/europe-west4/endpoints/openapi/chat/completions");
    expect(header(up, 1, "authorization")).toBe("Bearer ya29.fake-access-token");
    expect(sent(up, 1).model).toBe("google/gemini-3.1-pro-preview");

    // The token is kept until it is about to expire.
    await call(up, "/v1/chat/completions", chat(token, "vertex/gemini-3.1-pro-preview"));
    expect(up.calls.map((r) => new URL(r.url).host)).toEqual(["oauth2.googleapis.com", "europe-west4-aiplatform.googleapis.com", "europe-west4-aiplatform.googleapis.com"]);
    await noLeak([sa.pem, "ya29.fake-access-token"], [text]);
  });

  it("vertex-partner calls the global endpoint with the model as named", async () => {
    const sa = await serviceAccount("partner@fake-project.iam.gserviceaccount.com");
    await connect("vertex-partner", sa.json);
    const up = fakeUpstream((req) => (req.url.startsWith("https://oauth2.googleapis.com/") ? json({ access_token: "ya29.fake-partner-token", expires_in: 3600 }) : json(COMPLETION)));
    const { res, text } = await call(up, "/v1/chat/completions", chat(await system(), "vertex-partner/deepseek-ai/deepseek-v3.2-maas"));
    expect(res.status, text).toBe(200);
    expect(up.calls[1]!.url).toBe("https://aiplatform.googleapis.com/v1/projects/fake-project/locations/global/endpoints/openapi/chat/completions");
    expect(sent(up, 1).model).toBe("deepseek-ai/deepseek-v3.2-maas");
  });

  it("a token Google refuses is a 401 for that account, and no chat is sent", async () => {
    const sa = await serviceAccount("refused@fake-project.iam.gserviceaccount.com");
    await connect("vertex", sa.json);
    const up = fakeUpstream(() => json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400));
    const { res, text } = await call(up, "/v1/chat/completions", chat(await system(), "vertex/gemini-3.1-pro-preview"));
    expect(res.status).toBe(401);
    expect(text).toContain("Invalid JWT Signature");
    expect(up.calls).toHaveLength(1);
    await noLeak([sa.pem], [text]);
  });

  it("refuses a key that is not a service account JSON", async () => {
    for (const apiKey of ["not json", JSON.stringify({ client_email: "a@b.test" }), JSON.stringify({ client_email: "a@b.test", private_key: "x", project_id: "p" })]) {
      expect((await admin("POST", "/connections", { provider: "vertex", name: "x", api_key: apiKey })).res.status, apiKey).toBe(400);
    }
    const sa = await serviceAccount("x@fake-project.iam.gserviceaccount.com");
    expect((await admin("POST", "/connections", { provider: "vertex", name: "x", api_key: sa.json, settings: { location: "Mars 1" } })).res.status).toBe(400);
  });
});

describe("the console's provider list", () => {
  it("lists the ported providers with their setting names and free tiers, never values", async () => {
    const providers = JSON.parse((await admin("GET", "/providers")).text) as { id: string; free_tier: boolean; settings?: { name: string; secret?: boolean; required?: boolean }[] }[];
    const by = new Map(providers.map((p) => [p.id, p]));
    for (const id of ["opencode-go", "opencode-zen", "synthetic", "xiaomi-tokenplan", "api-airforce", "kimchi", "minimax", "minimax-cn", "perplexity-agent", "ollama", "cloudflare-ai", "azure", "bedrock", "bedrock-xai", "vertex", "vertex-partner"]) {
      expect(by.has(id), id).toBe(true);
    }
    expect(by.get("bedrock")?.settings).toEqual([
      expect.objectContaining({ name: "access_key_id", required: true }),
      expect.objectContaining({ name: "region" }),
      expect.objectContaining({ name: "session_token", secret: true }),
    ]);
    expect(by.get("openai")).not.toHaveProperty("settings");
    expect(by.get("api-airforce")?.free_tier).toBe(true);
  });
});
