import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, sse } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const admin = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) } });

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "Hello there." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 4, output_tokens: 3 },
};

const chat = (token: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

interface Detail {
  id: number;
  at: number;
  system_id: string | null;
  model: string | null;
  path: string;
  status: number;
  took_ms: number;
  ttft_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  request: string | null;
  response: string | null;
  thinking: string | null;
}

async function details(): Promise<Detail[]> {
  const up = fakeUpstream(() => json({}));
  const { res, text } = await call(up, "/admin/request-details", admin());
  expect(res.status).toBe(200);
  return (JSON.parse(text) as { details: Detail[] }).details;
}

async function turnOn(on = true): Promise<void> {
  const { res, text } = await call(fakeUpstream(() => json({})), "/admin/observability", admin({ method: "PUT", body: JSON.stringify({ enabled: on }) }));
  expect(res.status).toBe(200);
  expect(JSON.parse(text)).toEqual({ enabled: on });
}

beforeEach(reset);

describe("observability (request details)", () => {
  it("is off until the owner turns it on, and then records nothing new when turned off again", async () => {
    const up0 = fakeUpstream(() => json({}));
    expect(JSON.parse((await call(up0, "/admin/observability", admin())).text)).toEqual({ enabled: false });
    const token = await addSystem("chat");
    const up = fakeUpstream(() => json(MESSAGE));
    await call(up, "/v1/chat/completions", chat(token, { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }));
    expect(await details()).toHaveLength(0);

    await turnOn();
    await call(up, "/v1/chat/completions", chat(token, { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }));
    expect(await details()).toHaveLength(1);

    await turnOn(false);
    await call(up, "/v1/chat/completions", chat(token, { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }));
    expect(await details()).toHaveLength(1);
  });

  it("keeps the client request, the reply text and its tokens, and never the gateway token", async () => {
    await turnOn();
    const token = await addSystem("chat");
    const up = fakeUpstream(() => json(MESSAGE));
    await call(up, "/v1/chat/completions", chat(token, { model: "claude-opus-5-5", messages: [{ role: "user", content: "what is 2+2" }] }));
    const [d] = await details();
    expect(d!.system_id).toBe("chat");
    expect(d!.model).toBe("claude-opus-5-5");
    expect(d!.path).toBe("/v1/chat/completions");
    expect(d!.status).toBe(200);
    expect(d!.request).toContain("what is 2+2");
    expect(d!.response).toBe("Hello there.");
    expect(d!.input_tokens).toBe(4);
    expect(d!.output_tokens).toBe(3);
    const all = JSON.stringify(await details());
    expect(all).not.toContain(token);
  });

  it("puts a streamed reply together and notes the time to the first chunk", async () => {
    await turnOn();
    const token = await addSystem("chat");
    const up = fakeUpstream(
      () =>
        new Response(
          sse([
            { type: "message_start", message: { ...MESSAGE, content: [], usage: { input_tokens: 7, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
            { type: "message_stop" },
          ]),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const { text } = await call(up, "/v1/chat/completions", chat(token, { model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(text).toContain("data: [DONE]");
    const [d] = await details();
    expect(d!.response).toBe("Hello");
    expect(d!.ttft_ms).not.toBeNull();
    expect(d!.output_tokens).toBe(2);
  });

  it("masks anything key-like in the request and cuts long bodies", async () => {
    await turnOn();
    const token = await addSystem("chat");
    const up = fakeUpstream(() => json(MESSAGE));
    const secret = "sk-ant-api03-" + "x".repeat(40);
    await call(up, "/v1/chat/completions", chat(token, { model: "claude-opus-5-5", messages: [{ role: "user", content: `my key is ${secret} ${"y".repeat(20_000)}` }] }));
    const [d] = await details();
    expect(d!.request).not.toContain(secret);
    expect(d!.request!.length).toBeLessThanOrEqual(5 * 1024 + 20);
  });

  it("shows one detail, filters by model and clears them all; only the owner sees them", async () => {
    await turnOn();
    const token = await addSystem("chat");
    const up = fakeUpstream(() => json(MESSAGE));
    await call(up, "/v1/chat/completions", chat(token, { model: "claude-opus-5-5", messages: [{ role: "user", content: "a" }] }));
    await call(up, "/v1/chat/completions", chat(token, { model: "claude-haiku-5-5", messages: [{ role: "user", content: "b" }] }));
    const list = await details();
    expect(list.map((d) => d.model)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);

    const one = await call(up, `/admin/request-details/${list[1]!.id}`, admin());
    expect((JSON.parse(one.text) as Detail).model).toBe("claude-opus-5-5");
    expect((await call(up, "/admin/request-details/999999", admin())).res.status).toBe(404);

    const filtered = JSON.parse((await call(up, "/admin/request-details?model=haiku", admin())).text) as { details: Detail[] };
    expect(filtered.details.map((d) => d.model)).toEqual(["claude-haiku-5-5"]);

    expect((await call(up, "/admin/request-details", { headers: { authorization: `Bearer ${token}` } })).res.status).toBe(401);
    expect((await call(up, "/admin/request-details", admin({ method: "DELETE" }))).res.status).toBe(204);
    expect(await details()).toHaveLength(0);
  });

  it("refuses a setting that is not a yes or no", async () => {
    const up = fakeUpstream(() => json({}));
    expect((await call(up, "/admin/observability", admin({ method: "PUT", body: JSON.stringify({ enabled: "yes" }) }))).res.status).toBe(400);
    const row = await env.DB.prepare("SELECT value FROM setting WHERE key = 'observability'").first();
    expect(row).toBeNull();
  });
});
