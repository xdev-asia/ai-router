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
const setVision = async (cfg: unknown) => {
  const r = await admin("PUT", "/vision-adapter", cfg);
  expect(r.res.status).toBe(200);
};

/** Fake images: never real data. */
const IMG_A = "data:image/png;base64,QUFBQQ==";
const IMG_B = "https://images.test/b.jpg";
const withImages = (model: string, ...urls: string[]) => ({
  model,
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "what is this?" }, ...urls.map((url) => ({ type: "image_url", image_url: { url } }))],
    },
  ],
});
type Body = { model: string; stream?: boolean; messages: { role: string; content: unknown }[] };
const bodies = (up: { bodies: string[] }) => up.bodies.map((b) => JSON.parse(b) as Body);
/** Answers the adapter models with a description of the image they were sent, and any other model with "ok". */
const describer = (failing: string[] = []) =>
  fakeUpstream(async (req) => {
    const b = (await req.clone().json()) as Body;
    if (failing.includes(b.model)) return json({ error: { message: "vision down", type: "server_error" } }, 500);
    if (b.model.startsWith("vis")) {
      const parts = b.messages[0].content as { type: string; image_url?: { url: string } }[];
      const url = parts.find((p) => p.type === "image_url")?.image_url?.url;
      return json(completion(`${b.model} saw ${url === IMG_A ? "a red cat" : "a blue dog"}`, b.model));
    }
    return json(completion("ok", b.model));
  });

let token = "";
beforeEach(async () => {
  await reset();
  token = await addSystem("chat");
  await env.DB.prepare("UPDATE system SET allowed_models = '[\"*\"]' WHERE id = 'chat'").run();
});

describe("vision adapter API", () => {
  it("starts off, saves a valid config and normalises its names", async () => {
    expect(JSON.parse((await admin("GET", "/vision-adapter")).text)).toEqual({ enabled: false, models: [], applies_to: [] });
    const put = await admin("PUT", "/vision-adapter", { enabled: true, models: [" openai/vis-a ", "claude-sonnet-5"], applies_to: ["groq/*", "combo/team", "claude-haiku-5-5"] });
    expect(put.res.status).toBe(200);
    const want = { enabled: true, models: ["openai/vis-a", "anthropic/claude-sonnet-5"], applies_to: ["groq/*", "combo/team", "anthropic/claude-haiku-5-5"] };
    expect(JSON.parse(put.text)).toEqual(want);
    expect(JSON.parse((await admin("GET", "/vision-adapter")).text)).toEqual(want);
    // A PUT with some fields keeps the others.
    expect(JSON.parse((await admin("PUT", "/vision-adapter", { enabled: false })).text)).toEqual({ ...want, enabled: false });
  });

  it("refuses a config that is not valid", async () => {
    const bad = [
      { enabled: "yes" },
      { models: "openai/vis-a" },
      { models: ["combo/team"] },
      { models: ["not a model"] },
      { models: ["openai/vis-a", "openai/vis-a"] },
      { models: Array.from({ length: 11 }, (_, i) => `openai/vis-${i}`) },
      { applies_to: ["no spaces allowed"] },
      { applies_to: [42] },
      { applies_to: Array.from({ length: 51 }, (_, i) => `openai/m-${i}`) },
      // On needs a model to describe with and a model to apply to.
      { enabled: true, models: [], applies_to: ["*"] },
      { enabled: true, models: ["openai/vis-a"], applies_to: [] },
    ];
    for (const b of bad) {
      const r = await admin("PUT", "/vision-adapter", b);
      expect(r.res.status, JSON.stringify(b)).toBe(400);
      expect(JSON.parse(r.text)).toMatchObject({ error: "invalid_input" });
    }
    expect((await admin("PUT", "/vision-adapter", undefined)).res.status).toBe(400);
    expect(JSON.parse((await admin("GET", "/vision-adapter")).text)).toEqual({ enabled: false, models: [], applies_to: [] });
  });

  it("needs the admin token", async () => {
    const r = await call(fakeUpstream(() => json({})), "/admin/vision-adapter", { headers: { authorization: "Bearer wrong" } });
    expect(r.res.status).toBe(401);
  });
});

describe("vision adapter in the chat path", () => {
  it("replaces each image with the adapter model's description, and meters the adapter call", async () => {
    await setVision({ enabled: true, models: ["openai/vis-a"], applies_to: ["groq/*"] });
    const up = describer();
    const r = await call(up, "/openai/v1/chat/completions", chat(token, { ...withImages("groq/llama-3.3-70b-versatile", IMG_A), stream: false }));
    expect(r.res.status).toBe(200);
    const [ask, main] = bodies(up);
    expect(up.calls.map((c) => new URL(c.url).host)).toEqual(["api.openai.com", "api.groq.com"]);
    expect(ask.model).toBe("vis-a");
    expect(ask.stream).not.toBe(true);
    expect(JSON.stringify(ask.messages)).toContain(IMG_A);
    expect(main.model).toBe("llama-3.3-70b-versatile");
    expect(main.messages[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "text", text: "[Image 1: vis-a saw a red cat]" },
    ]);
    expect(up.bodies[1]).not.toContain("image_url");
    const rows = await usageRows("chat");
    expect(rows.map((x) => [x.provider, x.model])).toEqual(expect.arrayContaining([["openai", "vis-a"], ["groq", "llama-3.3-70b-versatile"]]));
    expect(rows).toHaveLength(2);
  });

  it("numbers several images, describes a repeated one once, and keeps an image given as a plain string", async () => {
    await setVision({ enabled: true, models: ["openai/vis-a"], applies_to: ["*"] });
    const up = describer();
    const req = {
      model: "groq/llama",
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: IMG_A }, { type: "text", text: "and" }, { type: "image_url", image_url: { url: IMG_B } }] },
        { role: "assistant", content: "seen" },
        { role: "user", content: [{ type: "image_url", image_url: { url: IMG_A, detail: "high" } }] },
      ],
    };
    const r = await call(up, "/openai/v1/chat/completions", chat(token, req));
    expect(r.res.status).toBe(200);
    const all = bodies(up);
    expect(all.filter((b) => b.model === "vis-a")).toHaveLength(2);
    const main = all.find((b) => b.model === "llama")!;
    expect(main.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "[Image 1: vis-a saw a red cat]" }, { type: "text", text: "and" }, { type: "text", text: "[Image 2: vis-a saw a blue dog]" }] },
      { role: "assistant", content: "seen" },
      { role: "user", content: [{ type: "text", text: "[Image 1: vis-a saw a red cat]" }] },
    ]);
  });

  it("falls back to the next adapter model when one fails", async () => {
    await setVision({ enabled: true, models: ["openai/vis-a", "openrouter/vis-b"], applies_to: ["groq/llama"] });
    const up = describer(["vis-a"]);
    const r = await call(up, "/openai/v1/chat/completions", chat(token, withImages("groq/llama", IMG_A)));
    expect(r.res.status).toBe(200);
    expect(bodies(up).map((b) => b.model)).toEqual(["vis-a", "vis-b", "llama"]);
    expect(bodies(up)[2].messages[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "text", text: "[Image 1: vis-b saw a red cat]" },
    ]);
  });

  it("skips an adapter model with no key and one that is disabled", async () => {
    await env.DB.prepare("INSERT INTO model_disabled (provider, model, created_at) VALUES ('openai', 'vis-off', 1)").run();
    // deepseek has no key in the tests.
    await setVision({ enabled: true, models: ["deepseek/vis-nokey", "openai/vis-off", "openai/vis-c"], applies_to: ["*"] });
    const up = describer();
    const r = await call(up, "/openai/v1/chat/completions", chat(token, withImages("groq/llama", IMG_A)));
    expect(r.res.status).toBe(200);
    expect(bodies(up).map((b) => b.model)).toEqual(["vis-c", "llama"]);
  });

  it("answers 502 and does not call the model when every adapter model fails", async () => {
    await setVision({ enabled: true, models: ["openai/vis-a", "openrouter/vis-b"], applies_to: ["*"] });
    const up = describer(["vis-a", "vis-b"]);
    const r = await call(up, "/openai/v1/chat/completions", chat(token, withImages("groq/llama", IMG_A)));
    expect(r.res.status).toBe(502);
    expect(JSON.parse(r.text)).toMatchObject({ error: { code: "vision_adapter_failed", type: "api_error" } });
    expect(bodies(up).map((b) => b.model)).toEqual(["vis-a", "vis-b"]);
  });

  it("applies to a combo it lists", async () => {
    await env.DB.prepare("INSERT INTO combo (name, targets, updated_at) VALUES ('team', ?, 1)").bind(JSON.stringify(["groq/llama"])).run();
    await setVision({ enabled: true, models: ["openai/vis-a"], applies_to: ["combo/team"] });
    const up = describer();
    const r = await call(up, "/openai/v1/chat/completions", chat(token, withImages("team", IMG_A)));
    expect(r.res.status).toBe(200);
    expect(bodies(up).map((b) => b.model)).toEqual(["vis-a", "llama"]);
  });

  it("is not applied when off, when the model is not listed, or when there is no image", async () => {
    const cfg = { enabled: true, models: ["openai/vis-a"], applies_to: ["groq/llama"] };
    await setVision({ ...cfg, enabled: false });
    let up = describer();
    await call(up, "/openai/v1/chat/completions", chat(token, withImages("groq/llama", IMG_A)));
    expect(bodies(up).map((b) => b.model)).toEqual(["llama"]);
    expect(up.bodies[0]).toContain(IMG_A);

    await setVision(cfg);
    up = describer();
    await call(up, "/openai/v1/chat/completions", chat(token, withImages("openai/gpt-5", IMG_A)));
    expect(bodies(up).map((b) => b.model)).toEqual(["gpt-5"]);
    expect(up.bodies[0]).toContain(IMG_A);

    up = describer();
    await call(up, "/openai/v1/chat/completions", chat(token, { model: "groq/llama", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }));
    expect(bodies(up).map((b) => b.model)).toEqual(["llama"]);
  });
});
