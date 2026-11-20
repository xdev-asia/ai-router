// FR-SEL-18: a client that goes away before the provider answers ends the provider request too; the account is not
// set aside and no other account is tried. A network failure that is not the client's still moves to the next one.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, messagesInit, reset } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const admin = (method: string, path: string, body?: unknown) =>
  call(fakeUpstream(() => json({})), `/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function connect(provider: string, name: string, apiKey: string): Promise<string> {
  const r = await admin("POST", "/connections", { provider, name, api_key: apiKey });
  expect(r.res.status, r.text).toBe(201);
  return (JSON.parse(r.text) as { id: string }).id;
}

const allow = (id: string, patterns: string[]) => env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(patterns), id).run();
const cooldown = async (id: string) => (await env.DB.prepare("SELECT cooldown_until FROM connection WHERE id = ?").bind(id).first<{ cooldown_until: number }>())!.cooldown_until;

/** An upstream that never answers on its own: it waits until its request is aborted, after the client goes away. */
function hangsUntilAborted(client: AbortController) {
  return fakeUpstream(
    (req) =>
      new Promise<Response>((_, reject) => {
        req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        client.abort();
      }),
  );
}

const MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } };

beforeEach(reset);

describe("client goes away before the provider answers", () => {
  it("/v1/chat/completions: aborts the provider request, tries no other account, sets none aside", async () => {
    const token = await addSystem("app");
    await allow("app", ["openai/*"]);
    const a = await connect("openai", "a", "sk-test-a");
    const b = await connect("openai", "b", "sk-test-b");
    const client = new AbortController();
    const up = hangsUntilAborted(client);
    const { res } = await call(up, "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] }),
      signal: client.signal,
    });
    expect(res.status).toBe(499);
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.signal.aborted).toBe(true);
    expect(await cooldown(a)).toBe(0);
    expect(await cooldown(b)).toBe(0);
  });

  it("/v1/messages to Anthropic: the same", async () => {
    const token = await addSystem("app");
    const a = await connect("anthropic", "a", "sk-ant-test-a");
    const b = await connect("anthropic", "b", "sk-ant-test-b");
    const client = new AbortController();
    const up = hangsUntilAborted(client);
    const { res } = await call(up, "/v1/messages", { ...messagesInit(token, { model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }), signal: client.signal });
    expect(res.status).toBe(499);
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.signal.aborted).toBe(true);
    expect(await cooldown(a)).toBe(0);
    expect(await cooldown(b)).toBe(0);
  });
});

describe("network failure that is not the client's", () => {
  it("/v1/messages to Anthropic: sets the account aside and answers from the next one", async () => {
    const token = await addSystem("app");
    const a = await connect("anthropic", "a", "sk-ant-test-a");
    await connect("anthropic", "b", "sk-ant-test-b");
    const up = fakeUpstream((req) => (req.headers.get("x-api-key") === "sk-ant-test-a" ? Promise.reject(new TypeError("network connection lost")) : json(MESSAGE)));
    const { res, text } = await call(up, "/v1/messages", messagesInit(token, { model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status, text).toBe(200);
    expect(up.calls).toHaveLength(2);
    expect(await cooldown(a)).toBeGreaterThan(0);
  });
});
