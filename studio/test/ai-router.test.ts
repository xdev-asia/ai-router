import { afterEach, describe, expect, it } from "vitest";
import { AiRouter, AiRouterError } from "../src/ai-router.ts";
import { fakeServer, type Reply, type Seen } from "./fake-server.ts";

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function router(handle: (r: Seen, url: string) => Reply) {
  const s = await fakeServer(handle);
  close = s.close;
  return { ai: new AiRouter({ baseUrl: s.url, token: "test-gateway-token", pollMs: 5 }), seen: s.seen };
}

describe("AiRouter", () => {
  it("sends the gateway token and reads a chat answer", async () => {
    const { ai, seen } = await router(() => ({ json: { choices: [{ message: { content: "xin chào" } }] } }));
    expect(await ai.chat("openai/gpt-5-mini", [{ role: "user", content: "hi" }])).toBe("xin chào");
    expect(seen[0]!.path).toBe("/v1/chat/completions");
    expect(seen[0]!.headers.authorization).toBe("Bearer test-gateway-token");
    expect(JSON.parse(seen[0]!.text)).toMatchObject({ model: "openai/gpt-5-mini", stream: false });
  });

  it("lists models", async () => {
    const { ai } = await router(() => ({ json: { data: [{ id: "openai/gpt-image-1" }, { id: 3 }, { id: "fal/flux" }] } }));
    expect(await ai.models()).toEqual(["openai/gpt-image-1", "fal/flux"]);
  });

  it("asks images as b64_json and decodes them", async () => {
    const { ai, seen } = await router(() => ({ json: { data: [{ b64_json: Buffer.from("PNGDATA").toString("base64") }] } }));
    expect((await ai.image("openai/gpt-image-1", "a cat", "1024x1536")).toString()).toBe("PNGDATA");
    expect(JSON.parse(seen[0]!.text)).toEqual({ model: "openai/gpt-image-1", prompt: "a cat", size: "1024x1536", n: 1, response_format: "b64_json" });
  });

  it("downloads an image answered as a URL, without the token", async () => {
    const { ai, seen } = await router((r, url) => (r.path === "/img.png" ? { body: "BYTES" } : { json: { data: [{ url: `${url}/img.png` }] } }));
    expect((await ai.image("x/y", "p", "1x1")).toString()).toBe("BYTES");
    expect(seen[1]!.headers.authorization).toBeUndefined();
  });

  it("returns speech bytes", async () => {
    const { ai, seen } = await router(() => ({ body: Buffer.from([1, 2, 3]), headers: { "content-type": "audio/mpeg" } }));
    expect([...(await ai.speech("openai/tts-1", "chào", "alloy"))]).toEqual([1, 2, 3]);
    expect(JSON.parse(seen[0]!.text)).toMatchObject({ input: "chào", voice: "alloy", response_format: "mp3" });
  });

  it("polls a video job and fetches its content", async () => {
    let looks = 0;
    const { ai, seen } = await router((r) => {
      if (r.method === "POST") return { json: { id: "vid_1", status: "queued" } };
      if (r.path === "/v1/videos/vid_1") return { json: { id: "vid_1", status: ++looks < 2 ? "in_progress" : "completed" } };
      if (r.path === "/v1/videos/vid_1/content") return { body: "MP4", headers: { "content-type": "video/mp4" } };
      return { status: 404 };
    });
    expect((await ai.video("openai/sora-2", "waves", 4, "720x1280")).toString()).toBe("MP4");
    expect(JSON.parse(seen[0]!.text)).toMatchObject({ seconds: "4", size: "720x1280" });
    expect(seen.map((s) => s.path)).toEqual(["/v1/videos", "/v1/videos/vid_1", "/v1/videos/vid_1", "/v1/videos/vid_1/content"]);
  });

  it("fails a failed video job with its reason", async () => {
    const { ai } = await router((r) => (r.method === "POST" ? { json: { id: "v", status: "failed", error: { message: "moderated" } } } : { status: 404 }));
    await expect(ai.video("a/b", "p", 4, "720x1280")).rejects.toThrow(/moderated/);
  });

  it("passes the gateway's error message on", async () => {
    const { ai } = await router(() => ({ status: 403, json: { error: { message: "this system may not use this model" } } }));
    const e = await ai.chat("a/b", []).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AiRouterError);
    expect((e as AiRouterError).status).toBe(403);
    expect((e as Error).message).toContain("may not use this model");
  });
});
