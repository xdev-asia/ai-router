import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, sse, usageRows } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "Hello there." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 4, output_tokens: 3 },
};

const post = (body: unknown, token = ADMIN_TOKEN): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(reset);

describe("POST /admin/chat/completions (console chat)", () => {
  it("answers as the chosen system and records its usage", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(() => json(MESSAGE));
    const { res, text } = await call(up, "/admin/chat/completions", post({ system: "chat", model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    const body = JSON.parse(text);
    expect(body.choices[0].message.content).toBe("Hello there.");
    // The `system` field picks the system; it is never sent upstream.
    expect(JSON.parse(up.bodies[0]!)).not.toHaveProperty("system", "play");
    const rows = await usageRows("chat");
    expect(rows).toHaveLength(1);
    expect(text).not.toContain(token);
  });

  it("streams", async () => {
    await addSystem("chat");
    const up = fakeUpstream(
      () =>
        new Response(
          sse([
            { type: "message_start", message: { ...MESSAGE, content: [], usage: { input_tokens: 4, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
          ]),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const { res, text } = await call(up, "/admin/chat/completions", post({ system: "chat", model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(text).toContain('"content":"Hi"');
    expect(text).toContain("data: [DONE]");
  });

  it("refuses without console access", async () => {
    await addSystem("chat");
    const up = fakeUpstream(() => json(MESSAGE));
    expect((await call(up, "/admin/chat/completions", { method: "POST", body: "{}" })).res.status).toBe(401);
    const gateway = await addSystem("other");
    expect((await call(up, "/admin/chat/completions", post({ system: "other", model: "claude-opus-5-5", messages: [] }, gateway))).res.status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("refuses an unknown, a disabled or a capped system before calling upstream", async () => {
    await addSystem("off", { disabled: true });
    await addSystem("capped", { cap: 5 });
    await env.DB.prepare("INSERT INTO usage (system_id, provider, model, status, streamed, input_tokens, output_tokens, at) VALUES ('capped', 'anthropic', 'x', 200, 0, 5, 5, ?)")
      .bind(Math.floor(Date.now() / 1000))
      .run();
    const up = fakeUpstream(() => json(MESSAGE));
    const msg = { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] };
    expect((await call(up, "/admin/chat/completions", post({ ...msg }))).res.status).toBe(400);
    expect((await call(up, "/admin/chat/completions", post({ ...msg, system: "nope" }))).res.status).toBe(404);
    expect((await call(up, "/admin/chat/completions", post({ ...msg, system: "off" }))).res.status).toBe(403);
    expect((await call(up, "/admin/chat/completions", post({ ...msg, system: "capped" }))).res.status).toBe(429);
    expect(up.calls).toHaveLength(0);
  });

  it("lists the models the chosen system may use", async () => {
    await addSystem("chat");
    await env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = 'chat'").bind(JSON.stringify(["combo/fast"])).run();
    await env.DB.prepare("INSERT INTO combo (name, targets, updated_at) VALUES ('fast', ?, 0), ('slow', ?, 0)")
      .bind(JSON.stringify(["claude-haiku-5-5"]), JSON.stringify(["claude-opus-5-5"]))
      .run();
    const up = fakeUpstream(() => json({ data: [] }));
    const { res, text } = await call(up, "/admin/chat/models?system=chat", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(JSON.parse(text).data.map((m: { id: string }) => m.id)).toEqual(["combo/fast"]);
    expect((await call(up, "/admin/chat/models?system=nope", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).res.status).toBe(404);
  });
});
