import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { facebook } from "../src/publishers/facebook.ts";
import { instagram } from "../src/publishers/instagram.ts";
import { telegram } from "../src/publishers/telegram.ts";
import { chunkPlan, tiktok } from "../src/publishers/tiktok.ts";
import type { PublishContext, PublishInput } from "../src/publishers/types.ts";
import { youtube } from "../src/publishers/youtube.ts";
import { zalo } from "../src/publishers/zalo.ts";
import { fakeServer, type Reply, type Seen } from "./fake-server.ts";

const tmp = mkdtempSync(join(tmpdir(), "clip-pub-"));
const file = join(tmp, "final.mp4");
writeFileSync(file, Buffer.alloc(1000, 7));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const input: PublishInput = { file, videoUrl: "https://clips.example.com/public/x/final.mp4", coverUrl: "https://clips.example.com/public/x/cover.jpg", title: "Tiêu đề", caption: "Mô tả\n\n#a #b", hashtags: ["a", "b"], links: [] };

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function platform(handle: (r: Seen, url: string) => Reply): Promise<{ ctx: PublishContext; seen: Seen[] }> {
  const s = await fakeServer(handle);
  close = s.close;
  return { ctx: { fetch, base: s.url, pollMs: 1, pollTries: 5 }, seen: s.seen };
}

describe("YouTube", () => {
  it("refreshes the token, starts a resumable upload, sends the bytes", async () => {
    const { ctx, seen } = await platform((r, url) => {
      if (r.path === "/token") return { json: { access_token: "ya29.test" } };
      if (r.path.startsWith("/upload/youtube/v3/videos")) return { headers: { location: `${url}/upload/session/1` } };
      if (r.path === "/upload/session/1") return { json: { id: "abc123" } };
      return { status: 404 };
    });
    const out = await youtube.publish({ client_id: "cid", client_secret: "cs", refresh_token: "rt" }, { privacy: "unlisted" }, input, ctx);
    expect(out).toEqual({ externalId: "abc123", url: "https://www.youtube.com/shorts/abc123" });
    expect(new URLSearchParams(seen[0]!.text).get("grant_type")).toBe("refresh_token");
    expect(seen[1]!.path).toBe("/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status");
    expect(seen[1]!.headers["x-upload-content-length"]).toBe("1000");
    expect(seen[1]!.headers.authorization).toBe("Bearer ya29.test");
    const meta = JSON.parse(seen[1]!.text);
    expect(meta.snippet.title).toBe("Tiêu đề #Shorts");
    expect(meta.status.privacyStatus).toBe("unlisted");
    expect(seen[2]!.method).toBe("PUT");
    expect(seen[2]!.body.length).toBe(1000);
  });

  it("says Google's error, not the URL", async () => {
    const { ctx } = await platform(() => ({ status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }));
    await expect(youtube.publish({ client_id: "a", client_secret: "b", refresh_token: "c" }, {}, input, ctx)).rejects.toThrow("Google OAuth 400: invalid_grant: Token has been expired or revoked.");
  });
});

describe("TikTok", () => {
  it("plans chunks as TikTok wants them", () => {
    expect(chunkPlan(3_000_000)).toEqual({ chunkSize: 3_000_000, count: 1 });
    expect(chunkPlan(15 * 1024 * 1024)).toEqual({ chunkSize: 15 * 1024 * 1024, count: 1 });
    expect(chunkPlan(25 * 1024 * 1024)).toEqual({ chunkSize: 10 * 1024 * 1024, count: 2 });
  });

  it("inits a FILE_UPLOAD post, PUTs the chunk, waits for PUBLISH_COMPLETE, keeps a rotated refresh token", async () => {
    let looks = 0;
    const { ctx, seen } = await platform((r, url) => {
      if (r.path === "/v2/oauth/token/") return { json: { access_token: "act.test", refresh_token: "rft.new" } };
      if (r.path === "/v2/post/publish/video/init/") return { json: { data: { publish_id: "p_1", upload_url: `${url}/upload/?id=1` }, error: { code: "ok" } } };
      if (r.path === "/upload/?id=1") return { status: 201 };
      if (r.path === "/v2/post/publish/status/fetch/") return { json: { data: { status: ++looks < 2 ? "PROCESSING_UPLOAD" : "PUBLISH_COMPLETE" }, error: { code: "ok" } } };
      return { status: 404 };
    });
    const out = await tiktok.publish({ client_key: "ck", client_secret: "cs", refresh_token: "rft.old" }, {}, input, ctx);
    expect(out).toEqual({ externalId: "p_1", url: null, secret: { client_key: "ck", client_secret: "cs", refresh_token: "rft.new" } });
    const init = JSON.parse(seen[1]!.text);
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 1000, chunk_size: 1000, total_chunk_count: 1 });
    expect(init.post_info.privacy_level).toBe("SELF_ONLY");
    expect(seen[2]!.headers["content-range"]).toBe("bytes 0-999/1000");
    expect(JSON.parse(seen[3]!.text)).toEqual({ publish_id: "p_1" });
  });

  it("fails with TikTok's reason", async () => {
    const { ctx } = await platform((r, url) => {
      if (r.path === "/v2/oauth/token/") return { json: { access_token: "a" } };
      if (r.path === "/v2/post/publish/video/init/") return { json: { data: { publish_id: "p", upload_url: `${url}/u` }, error: { code: "ok" } } };
      if (r.path === "/u") return { status: 201 };
      return { json: { data: { status: "FAILED", fail_reason: "spam_risk_too_many_posts" }, error: { code: "ok" } } };
    });
    await expect(tiktok.publish({ client_key: "k", client_secret: "s", refresh_token: "r" }, {}, input, ctx)).rejects.toThrow("spam_risk_too_many_posts");
  });
});

describe("Facebook Reels", () => {
  it("starts, uploads to rupload, finishes as published", async () => {
    const { ctx, seen } = await platform((r, url) => {
      const b = r.text && r.headers["content-type"] === "application/json" ? JSON.parse(r.text) : {};
      if (r.path === "/v23.0/123/video_reels" && b.upload_phase === "start") return { json: { video_id: "v9", upload_url: `${url}/video-upload/v23.0/v9` } };
      if (r.path === "/video-upload/v23.0/v9") return { json: { success: true } };
      if (r.path === "/v23.0/123/video_reels" && b.upload_phase === "finish") return { json: { success: true } };
      return { status: 404 };
    });
    const out = await facebook.publish({ page_access_token: "EAAB.test" }, { page_id: "123" }, input, ctx);
    expect(out).toEqual({ externalId: "v9", url: "https://www.facebook.com/reel/v9" });
    expect(seen[1]!.headers.authorization).toBe("OAuth EAAB.test");
    expect(seen[1]!.headers.file_size).toBe("1000");
    expect(JSON.parse(seen[2]!.text)).toMatchObject({ upload_phase: "finish", video_id: "v9", video_state: "PUBLISHED" });
  });
});

describe("Instagram Reels", () => {
  it("makes a REELS container from the public URL, waits for FINISHED, publishes", async () => {
    let looks = 0;
    const { ctx, seen } = await platform((r) => {
      if (r.path === "/v23.0/178/media") return { json: { id: "c1" } };
      if (r.path.startsWith("/v23.0/c1?")) return { json: { status_code: ++looks < 2 ? "IN_PROGRESS" : "FINISHED" } };
      if (r.path === "/v23.0/178/media_publish") return { json: { id: "m1" } };
      if (r.path.startsWith("/v23.0/m1?")) return { json: { permalink: "https://www.instagram.com/reel/XYZ/" } };
      return { status: 404 };
    });
    const out = await instagram.publish({ access_token: "IGQ.test" }, { ig_user_id: "178" }, input, ctx);
    expect(out).toEqual({ externalId: "m1", url: "https://www.instagram.com/reel/XYZ/" });
    expect(JSON.parse(seen[0]!.text)).toMatchObject({ media_type: "REELS", video_url: input.videoUrl, cover_url: input.coverUrl });
    expect(JSON.parse(seen.at(-2)!.text)).toMatchObject({ creation_id: "c1" });
  });

  it("needs a public URL", async () => {
    const { ctx } = await platform(() => ({ status: 500 }));
    await expect(instagram.publish({ access_token: "x" }, { ig_user_id: "1" }, { ...input, videoUrl: null }, ctx)).rejects.toThrow(/PUBLIC_BASE_URL/);
  });
});

describe("Telegram", () => {
  it("sends the video as multipart to sendVideo", async () => {
    const { ctx, seen } = await platform(() => ({ json: { ok: true, result: { message_id: 42, chat: { username: "xdevclips" } } } }));
    const out = await telegram.publish({ bot_token: "123:ABC" }, { chat_id: "@xdevclips" }, input, ctx);
    expect(out).toEqual({ externalId: "42", url: "https://t.me/xdevclips/42" });
    expect(seen[0]!.path).toBe("/bot123:ABC/sendVideo");
    expect(seen[0]!.headers["content-type"]).toMatch(/^multipart\/form-data/);
    expect(seen[0]!.text).toContain('name="chat_id"');
    expect(seen[0]!.text).toContain('filename="final.mp4"');
  });

  it("says Telegram's description", async () => {
    const { ctx } = await platform(() => ({ status: 400, json: { ok: false, description: "Bad Request: chat not found" } }));
    await expect(telegram.publish({ bot_token: "1:A" }, { chat_id: "@nope" }, input, ctx)).rejects.toThrow("chat not found");
  });
});

describe("Zalo OA", () => {
  it("refreshes the token, posts an article linking to the clip, keeps the rotated refresh token", async () => {
    const { ctx, seen } = await platform((r) => {
      if (r.path === "/v4/oa/access_token") return { json: { access_token: "zat", refresh_token: "zrt.new" } };
      if (r.path === "/v2.0/article/create") return { json: { error: 0, data: { token: "tok1" } } };
      return { status: 404 };
    });
    const out = await zalo.publish({ app_id: "app", secret_key: "sk", refresh_token: "zrt.old" }, {}, { ...input, links: ["https://www.youtube.com/shorts/abc"] }, ctx);
    expect(out).toEqual({ externalId: "tok1", url: null, secret: { app_id: "app", secret_key: "sk", refresh_token: "zrt.new" } });
    expect(seen[0]!.headers.secret_key).toBe("sk");
    expect(seen[1]!.headers.access_token).toBe("zat");
    const a = JSON.parse(seen[1]!.text);
    expect(a.cover.photo_url).toBe(input.coverUrl);
    expect(JSON.stringify(a.body)).toContain("https://www.youtube.com/shorts/abc");
  });

  it("keeps the rotated token when the article fails", async () => {
    const { ctx } = await platform((r) => (r.path === "/v4/oa/access_token" ? { json: { access_token: "z", refresh_token: "new" } } : { json: { error: -216, message: "Access token is invalid" } }));
    const e = (await zalo.publish({ app_id: "a", secret_key: "s", refresh_token: "old" }, {}, input, ctx).catch((x: unknown) => x)) as Error & { secret?: Record<string, string> };
    expect(e.message).toContain("-216");
    expect(e.secret?.refresh_token).toBe("new");
  });
});
