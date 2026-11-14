import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const completion = (content: string, model = "m") => ({
  id: "chatcmpl-up",
  object: "chat.completion",
  model,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
});
const chat = (token: string, body: unknown) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const admin = (method: string, path: string, body?: unknown) =>
  call(fakeUpstream(() => json({})), `/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Fake audio: never a real recording. */
const CLIP_A = "QUFBQQ==";
const CLIP_B = "QkJCQg==";
const withAudio = (model: string, ...clips: string[]) => ({
  model,
  stream: false,
  messages: [{ role: "user", content: [{ type: "text", text: "what was said?" }, ...clips.map((data) => ({ type: "input_audio", input_audio: { data, format: "wav" } }))] }],
});
type Body = { model: string; messages: { role: string; content: unknown }[] };
const bodies = (up: { bodies: string[] }) => up.bodies.map((b) => JSON.parse(b) as Body);
/** Answers the audio models with what they heard, and any other model with "ok". */
const listener = (failing: string[] = []) =>
  fakeUpstream(async (req) => {
    const b = (await req.clone().json()) as Body;
    if (failing.includes(b.model)) return json({ error: { message: "audio down", type: "server_error" } }, 500);
    if (b.model.startsWith("ear")) {
      const parts = b.messages[0].content as { type: string; input_audio?: { data: string } }[];
      const data = parts.find((p) => p.type === "input_audio")?.input_audio?.data;
      return json(completion(`${b.model} heard ${data === CLIP_A ? "hello" : "goodbye"}`, b.model));
    }
    return json(completion("ok", b.model));
  });

let token = "";
beforeEach(async () => {
  await reset();
  token = await addSystem("chat");
  await env.DB.prepare("UPDATE system SET allowed_models = '[\"*\"]' WHERE id = 'chat'").run();
});

describe("audio adapter API", () => {
  it("starts off, saves apart from the vision adapter, and refuses a config that is not valid", async () => {
    expect(JSON.parse((await admin("GET", "/audio-adapter")).text)).toEqual({ enabled: false, models: [], applies_to: [] });
    const put = await admin("PUT", "/audio-adapter", { enabled: true, models: ["openai/ear-a"], applies_to: ["groq/*"] });
    expect(put.res.status).toBe(200);
    expect(JSON.parse((await admin("GET", "/audio-adapter")).text)).toEqual({ enabled: true, models: ["openai/ear-a"], applies_to: ["groq/*"] });
    expect(JSON.parse((await admin("GET", "/vision-adapter")).text)).toEqual({ enabled: false, models: [], applies_to: [] });
    for (const b of [{ enabled: "yes" }, { models: ["combo/team"] }, { enabled: true, models: [] }]) {
      expect((await admin("PUT", "/audio-adapter", b)).res.status, JSON.stringify(b)).toBe(400);
    }
  });

  it("needs the admin token", async () => {
    const r = await call(fakeUpstream(() => json({})), "/admin/audio-adapter", { headers: { authorization: "Bearer wrong" } });
    expect(r.res.status).toBe(401);
  });
});

describe("audio adapter in the chat path", () => {
  it("replaces each clip with the adapter model's transcript, numbers them, and meters the adapter calls", async () => {
    await admin("PUT", "/audio-adapter", { enabled: true, models: ["openai/ear-a"], applies_to: ["groq/*"] });
    const up = listener();
    const r = await call(up, "/openai/v1/chat/completions", chat(token, withAudio("groq/llama", CLIP_A, CLIP_B, CLIP_A)));
    expect(r.res.status).toBe(200);
    const all = bodies(up);
    expect(all.filter((b) => b.model === "ear-a")).toHaveLength(2);
    const main = all[all.length - 1];
    expect(main.model).toBe("llama");
    expect(main.messages[0].content).toEqual([
      { type: "text", text: "what was said?" },
      { type: "text", text: "[Audio 1: ear-a heard hello]" },
      { type: "text", text: "[Audio 2: ear-a heard goodbye]" },
      { type: "text", text: "[Audio 1: ear-a heard hello]" },
    ]);
    expect(up.bodies[up.bodies.length - 1]).not.toContain("input_audio");
    expect(await usageRows("chat")).toHaveLength(3);
  });

  it("tries the next adapter model, and answers 502 when none can transcribe", async () => {
    await admin("PUT", "/audio-adapter", { enabled: true, models: ["openai/ear-a", "openai/ear-b"], applies_to: ["*"] });
    const up = listener(["ear-a"]);
    const r = await call(up, "/openai/v1/chat/completions", chat(token, withAudio("groq/llama", CLIP_B)));
    expect(r.res.status).toBe(200);
    expect(JSON.stringify(bodies(up).at(-1)?.messages)).toContain("[Audio 1: ear-b heard goodbye]");

    const down = listener(["ear-a", "ear-b"]);
    const bad = await call(down, "/openai/v1/chat/completions", chat(token, withAudio("groq/llama", CLIP_A)));
    expect(bad.res.status).toBe(502);
    expect(JSON.parse(bad.text)).toMatchObject({ error: { code: "audio_adapter_failed" } });
    expect(down.calls.every((c) => new URL(c.url).host === "api.openai.com")).toBe(true);
  });

  it("leaves a request alone when the adapter is off or does not apply to its model", async () => {
    await admin("PUT", "/audio-adapter", { enabled: true, models: ["openai/ear-a"], applies_to: ["mistral/*"] });
    const up = listener();
    expect((await call(up, "/openai/v1/chat/completions", chat(token, withAudio("groq/llama", CLIP_A)))).res.status).toBe(200);
    expect(bodies(up).map((b) => b.model)).toEqual(["llama"]);
    expect(up.bodies[0]).toContain("input_audio");
  });
});
