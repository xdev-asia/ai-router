import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AiRouter } from "../src/ai-router.ts";
import { studioSecret, type Config } from "../src/config.ts";
import { open, seal } from "../src/crypto.ts";
import { Store } from "../src/db.ts";
import { scrub } from "../src/queue.ts";
import { createApp, loadSettings } from "../src/server.ts";

const tmp = mkdtempSync(join(tmpdir(), "clip-srv-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const key = Buffer.alloc(32, 9);
const SECRET = "studio-secret-for-tests-only";

function app() {
  const config: Config = { port: 0, dataDir: tmp, aiRouterUrl: "http://127.0.0.1:9", aiRouterToken: "t", channelsKey: key, secret: SECRET, publicBaseUrl: null, subtitleFont: "DejaVu Sans", fontsDir: null };
  const store = new Store(":memory:");
  return { store, app: createApp({ store, ai: new AiRouter({ baseUrl: config.aiRouterUrl, token: "t" }), config }) };
}
const auth = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };

describe("crypto", () => {
  it("seals and opens; a changed byte is refused", () => {
    const s = seal(key, { a: "b" });
    expect(open(key, s)).toEqual({ a: "b" });
    const bad = s.slice(0, -2) + (s.endsWith("A") ? "BB" : "AA");
    expect(() => open(key, bad)).toThrow();
  });
});

describe("API", () => {
  it("needs the shared secret on /api", async () => {
    const { app: a } = app();
    expect((await a.request("/api/projects")).status).toBe(401);
    expect((await a.request("/api/projects", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await a.request("/api/projects", { headers: auth })).status).toBe(200);
    expect((await a.request("/health")).status).toBe(200);
  });

  it("stores channel credentials sealed and never answers them", async () => {
    const { app: a, store } = app();
    const res = await a.request("/api/channels", { method: "POST", headers: auth, body: JSON.stringify({ kind: "telegram", secret: { bot_token: "123:SECRET" }, config: { chat_id: "@c" } }) });
    expect(res.status).toBe(201);
    const text = JSON.stringify(await res.json()) + JSON.stringify(await (await a.request("/api/channels", { headers: auth })).json());
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain('"secret"');
    const ch = store.channels()[0]!;
    expect(ch.secret).not.toContain("SECRET");
    expect(open(key, ch.secret)).toEqual({ bot_token: "123:SECRET" });
  });

  it("refuses a channel without its required fields", async () => {
    const { app: a } = app();
    const res = await a.request("/api/channels", { method: "POST", headers: auth, body: JSON.stringify({ kind: "youtube", secret: { client_id: "x" }, config: {} }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("secret.client_secret is needed");
  });

  it("creates a project in line and refuses to publish before it is rendered", async () => {
    const { app: a } = app();
    const res = await a.request("/api/projects", { method: "POST", headers: auth, body: JSON.stringify({ topic: "mẹo AI", chat_model: "a/b", image_model: "c/d", mode: "image" }) });
    expect(res.status).toBe(201);
    const { project } = await res.json();
    expect(project).toMatchObject({ step: "script", status: "queued", language: "vi", duration: 30 });
    const pub = await a.request(`/api/projects/${project.id}/publish`, { method: "POST", headers: auth, body: JSON.stringify({ channels: ["x"] }) });
    expect(pub.status).toBe(409);
  });

  it("serves only the clip and its cover without sign-in, and no path tricks", async () => {
    const { app: a } = app();
    const id = "00000000-0000-4000-8000-000000000001";
    mkdirSync(join(tmp, "projects", id), { recursive: true });
    writeFileSync(join(tmp, "projects", id, "final.mp4"), "0123456789");
    writeFileSync(join(tmp, "projects", id, "voice-01.mp3"), "v");
    const r = await a.request(`/files/${id}.mp4`, { headers: { range: "bytes=2-5" } });
    expect(r.status).toBe(206);
    expect(await r.text()).toBe("2345");
    expect(r.headers.get("content-range")).toBe("bytes 2-5/10");
    expect((await a.request(`/files/${id}.jpg`)).status).toBe(404);
    expect((await a.request(`/files/${id}.mp3`)).status).toBe(404);
    expect((await a.request(`/api/projects/${id}/files/voice-01.mp3`, { headers: auth })).status).toBe(200);
    expect((await a.request("/api/projects/00000000-0000-4000-8000-000000000001/files/final.mp4")).status).toBe(401);
    expect((await a.request("/api/projects/..%2F..%2Fetc/files/passwd", { headers: auth })).status).toBe(404);
  });
});

describe("studioSecret", () => {
  it("takes STUDIO_SECRET, else the file STUDIO_SECRET_FILE names", () => {
    const read = (p: string) => (p === "/secrets/studio-secret" ? "from-file-0123456789\n" : (() => { throw new Error("no"); })());
    expect(studioSecret({ STUDIO_SECRET: "from-env-0123456789" }, read)).toBe("from-env-0123456789");
    expect(studioSecret({ STUDIO_SECRET_FILE: "/secrets/studio-secret" }, read)).toBe("from-file-0123456789");
    expect(() => studioSecret({}, read)).toThrow(/STUDIO_SECRET/);
    expect(() => studioSecret({ STUDIO_SECRET_FILE: "/missing" }, read)).toThrow(/cannot be read/);
    expect(() => studioSecret({ STUDIO_SECRET: "short" }, read)).toThrow(/16/);
  });
});

describe("scrub", () => {
  it("hides credential values in a stored error", () => {
    expect(scrub("bad token 123:SECRET here", { bot_token: "123:SECRET" })).toBe("bad token *** here");
  });
});

describe("publishing through the queue", () => {
  it("posts a rendered clip, records the link, stores a rotated credential sealed", async () => {
    const { Queue } = await import("../src/queue.ts");
    const { fakeServer } = await import("./fake-server.ts");
    const zalo = await fakeServer((r) =>
      r.path === "/v4/oa/access_token" ? { json: { access_token: "zat", refresh_token: "rotated-refresh" } } : { json: { error: 0, data: { id: "art1" } } },
    );
    try {
      const { app: a, store } = app();
      const queue = new Queue({ store, ai: new AiRouter({ baseUrl: "http://127.0.0.1:9", token: "t" }), dataDir: tmp, subtitleFont: "x", channelsKey: key, publicBaseUrl: "https://studio.example.com", publish: { base: zalo.url, pollMs: 1 } });
      const id = "00000000-0000-4000-8000-000000000002";
      const now = Date.now();
      store.insertProject({ id, topic: "t", language: "vi", duration: 10, mode: "image", chat_model: "a", image_model: "b", video_model: "", tts_model: "", voice: "", image_size: "1x1", step: "done", status: "done", error: null, plan: { title: "T", description: "D", hashtags: ["h"], scenes: [] }, created_at: now, updated_at: now });
      mkdirSync(join(tmp, "projects", id), { recursive: true });
      writeFileSync(join(tmp, "projects", id, "final.mp4"), "mp4");
      const ch = await (await a.request("/api/channels", { method: "POST", headers: auth, body: JSON.stringify({ kind: "zalo", secret: { app_id: "app", secret_key: "sk-123456", refresh_token: "first-refresh" }, config: {} }) })).json();
      const pub = await a.request(`/api/projects/${id}/publish`, { method: "POST", headers: auth, body: JSON.stringify({ channels: [ch.channel.id] }) });
      expect(pub.status).toBe(201);
      await queue.tick();
      const [row] = store.publications(id);
      expect(row).toMatchObject({ status: "done", external_id: "art1", error: null });
      expect(open(key, store.channel(ch.channel.id)!.secret)).toMatchObject({ refresh_token: "rotated-refresh" });
      const article = JSON.parse(zalo.seen[1]!.text);
      expect(article.cover.photo_url).toBe(`https://studio.example.com/files/${id}.jpg`);
      expect(JSON.stringify(article.body)).toContain(`https://studio.example.com/files/${id}.mp4`);
    } finally {
      await zalo.close();
    }
  });
});

describe("settings from ai-router's console", () => {
  it("stores the gateway token sealed, never answers it, and reads it back at start", async () => {
    const { store, app: a } = app();
    const ai = new AiRouter({ baseUrl: "http://127.0.0.1:9", token: "" });
    const config: Config = { port: 0, dataDir: tmp, aiRouterUrl: "http://ai-router:8787", aiRouterToken: "", channelsKey: key, secret: SECRET, publicBaseUrl: null, subtitleFont: "x", fontsDir: null };
    const b = createApp({ store, ai, config });
    expect((await b.request("/api/settings", { method: "PUT", body: "{}" })).status).toBe(401);
    const res = await b.request("/api/settings", { method: "PUT", headers: auth, body: JSON.stringify({ ai_router_token: "xllm_fake_token_for_tests", public_base_url: "https://router.example.com/studio/" }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("xllm_fake_token_for_tests");
    expect(JSON.parse(text)).toMatchObject({ has_token: true, public_base_url: "https://router.example.com/studio", can_store: true });
    expect(store.setting("ai_router_token")).toMatch(/^sealed:/);
    expect(store.setting("ai_router_token")).not.toContain("xllm_fake_token_for_tests");

    const fresh = new AiRouter({ baseUrl: "http://127.0.0.1:9", token: "" });
    const again: Config = { ...config, publicBaseUrl: null };
    loadSettings(store, again, fresh);
    expect(fresh.hasToken).toBe(true);
    expect(again.publicBaseUrl).toBe("https://router.example.com/studio");
    expect((await a.request("/api/settings", { method: "PUT", headers: auth, body: JSON.stringify({ public_base_url: "ftp://x" }) })).status).toBe(400);
  });
});
