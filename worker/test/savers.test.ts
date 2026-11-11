import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { compressText } from "../savers";
import { CAVEMAN_PROMPTS } from "../savers/vendor/cavemanPrompts.js";
import { PONYTAIL_PROMPTS } from "../savers/vendor/ponytailPrompt.js";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, messagesInit, reset, usageRows } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const REPLY = { model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } };

/** 400 lines of build noise with many repeated lines: RTK's dedup filter shortens it a lot. */
const NOISY = Array.from({ length: 400 }, (_, i) => (i % 4 === 0 ? `step ${i} done` : "warning: something repeated in the build log")).join("\n");

const set = (id: string, v: { rtk?: number; caveman?: string | null; ponytail?: string | null; allowed_models?: string | null }) =>
  env.DB.prepare("UPDATE system SET rtk = COALESCE(?, rtk), caveman = ?, ponytail = ?, allowed_models = COALESCE(?, allowed_models) WHERE id = ?")
    .bind(v.rtk ?? null, v.caveman ?? null, v.ponytail ?? null, v.allowed_models ?? null, id)
    .run();

function claudeBody() {
  return {
    model: "claude-opus-5-5",
    max_tokens: 100,
    system: "You help.",
    messages: [
      { role: "user", content: NOISY },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "build", input: {} }, { type: "tool_use", id: "t2", name: "build", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: NOISY },
          { type: "tool_result", tool_use_id: "t2", content: NOISY, is_error: true },
        ],
      },
    ],
  };
}

beforeEach(reset);

describe("RTK filters", () => {
  it("shortens long noisy output and leaves short text alone", () => {
    const [out, saved] = compressText(NOISY);
    expect(saved).toBeGreaterThan(NOISY.length * 0.3);
    expect(out.length).toBe(NOISY.length - saved);
    expect(compressText("short output")).toEqual(["short output", 0]);
  });
});

describe("/anthropic with savers", () => {
  it("off (default): the client's bytes go upstream unchanged", async () => {
    const token = await addSystem("chat");
    const up = fakeUpstream(() => json(REPLY));
    const init = messagesInit(token, claudeBody());
    await call(up, "/anthropic/v1/messages", init);
    expect(up.bodies[0]).toBe(init.body);
  });

  it("RTK compresses successful tool results only; Caveman is appended to the system prompt; bytes saved are recorded", async () => {
    const token = await addSystem("chat");
    await set("chat", { rtk: 1, caveman: "full" });
    const up = fakeUpstream(() => json(REPLY));
    await call(up, "/anthropic/v1/messages", messagesInit(token, claudeBody()));
    const sent = JSON.parse(up.bodies[0]!);
    expect(sent.system).toBe(`You help.\n\n${CAVEMAN_PROMPTS.full}`);
    expect(sent.messages[0].content).toBe(NOISY); // user text untouched
    expect(sent.messages[2].content[0].content.length).toBeLessThan(NOISY.length * 0.7);
    expect(sent.messages[2].content[1].content).toBe(NOISY); // error kept whole
    const [row] = await usageRows("chat");
    expect(row!.rtk_saved_bytes).toBe(NOISY.length - sent.messages[2].content[0].content.length);
  });

  it("`x-gateway-token-saver: off` turns them all off for one request", async () => {
    const token = await addSystem("chat");
    await set("chat", { rtk: 1, caveman: "ultra", ponytail: "full" });
    const up = fakeUpstream(() => json(REPLY));
    const init = messagesInit(token, claudeBody(), { "x-gateway-token-saver": "off" });
    await call(up, "/anthropic/v1/messages", init);
    expect(up.bodies[0]).toBe(init.body);
  });

  it("appends to a block system prompt once, after cached blocks", async () => {
    const token = await addSystem("chat");
    await set("chat", { ponytail: "lite" });
    const up = fakeUpstream(() => json(REPLY));
    const body = { ...claudeBody(), system: [{ type: "text", text: "Cached.", cache_control: { type: "ephemeral" } }, { type: "text", text: PONYTAIL_PROMPTS.lite }] };
    await call(up, "/anthropic/v1/messages", messagesInit(token, body));
    expect(JSON.parse(up.bodies[0]!).system).toEqual(body.system); // already there: not added twice
  });
});

describe("/openai with savers", () => {
  it("adds a system message for OpenAI-compatible providers and compresses tool messages, once per combo attempt", async () => {
    const token = await addSystem("chat");
    await set("chat", { rtk: 1, ponytail: "lite", allowed_models: JSON.stringify(["combo/*"]) });
    await env.DB.prepare("INSERT INTO combo (name, targets, updated_at) VALUES ('c', ?, 1)").bind(JSON.stringify(["groq/a", "openai/b"])).run();
    const up = fakeUpstream((req) =>
      req.url.includes("groq") ? json({ error: { message: "busy" } }, 503) : json({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    );
    const res = await call(up, "/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/c",
        messages: [
          { role: "user", content: "build it" },
          { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "build", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "x", content: NOISY },
        ],
      }),
    });
    expect(res.res.status).toBe(200);
    for (const raw of up.bodies) {
      const sent = JSON.parse(raw);
      expect(sent.messages[0]).toEqual({ role: "system", content: PONYTAIL_PROMPTS.lite });
      expect(sent.messages.filter((m: { role: string }) => m.role === "system")).toHaveLength(1);
      expect(sent.messages[3].content.length).toBeLessThan(NOISY.length * 0.7);
    }
  });

  it("Caveman on a Claude target goes into the translated system prompt", async () => {
    const token = await addSystem("chat");
    await set("chat", { caveman: "lite" });
    const up = fakeUpstream(() => json(REPLY));
    await call(up, "/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "system", content: "Be kind." }, { role: "user", content: "hi" }] }),
    });
    expect(JSON.parse(up.bodies[0]!).system).toBe(`Be kind.\n\n${CAVEMAN_PROMPTS.lite}`);
  });
});

describe("admin", () => {
  const patch = (body: unknown) =>
    call(fakeUpstream(() => json({})), "/admin/systems/chat", {
      method: "PATCH",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("sets and validates rtk, caveman and ponytail", async () => {
    await addSystem("chat");
    const ok = JSON.parse((await patch({ rtk: true, caveman: "ultra", ponytail: null })).text);
    expect(ok).toMatchObject({ rtk: true, caveman: "ultra", ponytail: null });
    for (const bad of [{ rtk: 1 }, { caveman: "wenyan" }, { ponytail: "max" }]) {
      expect((await patch(bad)).res.status, JSON.stringify(bad)).toBe(400);
    }
  });
});
