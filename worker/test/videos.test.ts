import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addSystem, call, fakeUpstream, reset } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const auth = (token: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
const allow = (id: string) => env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(["openai/*"]), id).run();

beforeEach(reset);

describe("video jobs: GET /v1/videos/<id> and its content", () => {
  it("follows a job to the provider and account that made it, and passes the MP4 on", async () => {
    const token = await addSystem("clips");
    await allow("clips");
    const up = fakeUpstream((req) => {
      const u = new URL(req.url);
      if (req.method === "POST") return json({ id: "video_abc123", object: "video", status: "queued" });
      if (u.pathname === "/v1/videos/video_abc123") return json({ id: "video_abc123", status: "completed" });
      if (u.pathname === "/v1/videos/video_abc123/content") return new Response("MP4BYTES", { headers: { "content-type": "video/mp4", "content-length": "8" } });
      return json({ error: { message: "no" } }, 404);
    });
    const made = await call(up, "/v1/videos", auth(token, { method: "POST", body: JSON.stringify({ model: "openai/sora-2", prompt: "waves", seconds: "4" }) }));
    expect(made.res.status).toBe(200);
    expect(JSON.parse(made.text).id).toBe("video_abc123");

    const status = await call(up, "/v1/videos/video_abc123", auth(token));
    expect(status.res.status).toBe(200);
    expect(JSON.parse(status.text).status).toBe("completed");
    expect(up.calls[1]!.url).toBe("https://api.openai.com/v1/videos/video_abc123");
    expect(up.calls[1]!.headers.get("authorization")).toBe("Bearer sk-test-openai");

    const content = await call(up, "/v1/videos/video_abc123/content?variant=video", auth(token));
    expect(content.res.status).toBe(200);
    expect(content.res.headers.get("content-type")).toBe("video/mp4");
    expect(content.text).toBe("MP4BYTES");
    expect(up.calls[2]!.url).toBe("https://api.openai.com/v1/videos/video_abc123/content?variant=video");
    // The key never comes back.
    expect(status.text + content.text).not.toContain("sk-test-openai");
  });

  it("answers 404 for a job this system did not make, or an unknown one, without calling the provider", async () => {
    const a = await addSystem("a");
    const b = await addSystem("b");
    await allow("a");
    const up = fakeUpstream(() => json({ id: "video_mine", status: "queued" }));
    await call(up, "/v1/videos", auth(a, { method: "POST", body: JSON.stringify({ model: "openai/sora-2", prompt: "x" }) }));
    expect((await call(up, "/v1/videos/video_mine", auth(b))).res.status).toBe(404);
    expect((await call(up, "/v1/videos/video_other", auth(a))).res.status).toBe(404);
    expect((await call(up, "/v1/videos/video_mine/content", auth(b))).res.status).toBe(404);
    expect((await call(up, "/v1/videos/video_mine", {})).res.status).toBe(401);
    expect(up.calls).toHaveLength(1);
  });
});
