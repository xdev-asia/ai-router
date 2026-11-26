import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const post = (body: unknown, token = ADMIN_TOKEN): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

const IMAGE = { created: 1, data: [{ b64_json: "iVBORw0KGgo=" }] };

beforeEach(reset);

describe("POST /admin/images/generations (console image playground)", () => {
  it("draws as the chosen system and records its usage", async () => {
    await addSystem("art");
    await env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = 'art'").bind(JSON.stringify(["openai/*"])).run();
    const up = fakeUpstream(() => json(IMAGE));
    const { res, text } = await call(up, "/admin/images/generations", post({ system: "art", model: "openai/gpt-image-1", prompt: "a lighthouse", size: "1024x1024" }));
    expect(res.status).toBe(200);
    expect(JSON.parse(text).data[0].b64_json).toBe("iVBORw0KGgo=");
    expect(up.calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    const sent = JSON.parse(up.bodies[0]!);
    // `system` picks the system and is never sent upstream; the provider gets its own model name.
    expect(sent).not.toHaveProperty("system");
    expect(sent).toMatchObject({ model: "gpt-image-1", prompt: "a lighthouse" });
    expect(await usageRows("art")).toHaveLength(1);
  });

  it("refuses without console access", async () => {
    const gateway = await addSystem("art");
    const up = fakeUpstream(() => json(IMAGE));
    expect((await call(up, "/admin/images/generations", { method: "POST", body: "{}" })).res.status).toBe(401);
    expect((await call(up, "/admin/images/generations", post({ system: "art", model: "openai/gpt-image-1", prompt: "x" }, gateway))).res.status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("refuses an unknown, a disabled or a capped system, and a model the system may not use, before calling upstream", async () => {
    await addSystem("off", { disabled: true });
    await addSystem("capped", { cap: 5 });
    await addSystem("narrow");
    await env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = 'narrow'").bind(JSON.stringify(["groq/*"])).run();
    await env.DB.prepare("INSERT INTO usage (system_id, provider, model, status, streamed, input_tokens, output_tokens, at) VALUES ('capped', 'openai', 'x', 200, 0, 5, 5, ?)")
      .bind(Math.floor(Date.now() / 1000))
      .run();
    const up = fakeUpstream(() => json(IMAGE));
    const req = { model: "openai/gpt-image-1", prompt: "x" };
    expect((await call(up, "/admin/images/generations", post(req))).res.status).toBe(400);
    expect((await call(up, "/admin/images/generations", post({ ...req, system: "nope" }))).res.status).toBe(404);
    expect((await call(up, "/admin/images/generations", post({ ...req, system: "off" }))).res.status).toBe(403);
    expect((await call(up, "/admin/images/generations", post({ ...req, system: "capped" }))).res.status).toBe(429);
    expect((await call(up, "/admin/images/generations", post({ ...req, system: "narrow" }))).res.status).toBe(403);
    expect(up.calls).toHaveLength(0);
  });
});
