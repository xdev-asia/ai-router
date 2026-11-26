import { readFile } from "node:fs/promises";
import { PublishError, at, callJson, need, wait, type PublishContext, type Publisher } from "./types.ts";

const CHUNK = 10 * 1024 * 1024;

/**
 * TikTok's chunk rule: chunks of `chunk` bytes, the last one takes the rest (up to 128 MB); a file under two
 * chunks goes whole, as one chunk the size of the file.
 */
export function chunkPlan(size: number, chunk = CHUNK): { chunkSize: number; count: number } {
  if (size < chunk * 2) return { chunkSize: size, count: 1 };
  return { chunkSize: chunk, count: Math.max(1, Math.floor(size / chunk)) };
}

interface Envelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

const ok = <T>(name: string, j: Envelope<T>): T => {
  if (j.error?.code && j.error.code !== "ok") throw new PublishError(`${name}: ${j.error.code} ${j.error.message ?? ""}`.trim());
  if (!j.data) throw new PublishError(`${name} answered no data`);
  return j.data;
};

/**
 * TikTok: Content Posting API, Direct Post with FILE_UPLOAD. Until TikTok audits the app, every post is SELF_ONLY
 * (only the account sees it) and the account must be private.
 */
export const tiktok: Publisher = {
  kind: "tiktok",
  name: "TikTok",
  secretFields: [
    { key: "client_key", label: "Client key" },
    { key: "client_secret", label: "Client secret" },
    { key: "refresh_token", label: "Refresh token", help: "scope video.publish; TikTok may hand back a new one, which is stored" },
  ],
  configFields: [{ key: "privacy_level", label: "Privacy level", help: "SELF_ONLY until the app is audited; then PUBLIC_TO_EVERYONE", optional: true }],
  async publish(secret, config, input, ctx) {
    const { json: tok } = await callJson<{ access_token?: string; refresh_token?: string; error?: string; error_description?: string }>(
      ctx,
      "TikTok OAuth",
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: need(secret, "client_key", "TikTok"),
          client_secret: need(secret, "client_secret", "TikTok"),
          grant_type: "refresh_token",
          refresh_token: need(secret, "refresh_token", "TikTok"),
        }),
      },
    );
    if (!tok.access_token) throw new PublishError(`TikTok OAuth: ${tok.error ?? "no access token"} ${tok.error_description ?? ""}`.trim());
    const auth = { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json; charset=UTF-8" };
    const bytes = await readFile(input.file);
    const plan = chunkPlan(bytes.length);
    const { json: init } = await callJson<Envelope<{ publish_id?: string; upload_url?: string }>>(ctx, "TikTok", "https://open.tiktokapis.com/v2/post/publish/video/init/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        post_info: { title: `${input.title}\n${input.hashtags.map((h) => `#${h}`).join(" ")}`.slice(0, 2200), privacy_level: config.privacy_level || "SELF_ONLY" },
        source_info: { source: "FILE_UPLOAD", video_size: bytes.length, chunk_size: plan.chunkSize, total_chunk_count: plan.count },
      }),
    });
    const { publish_id, upload_url } = ok("TikTok", init);
    if (!publish_id || !upload_url) throw new PublishError("TikTok answered no upload URL");
    for (let i = 0; i < plan.count; i++) {
      const start = i * plan.chunkSize;
      const end = i === plan.count - 1 ? bytes.length : start + plan.chunkSize;
      const res = await ctx.fetch(at(ctx, upload_url), {
        method: "PUT",
        headers: { "content-type": "video/mp4", "content-length": String(end - start), "content-range": `bytes ${start}-${end - 1}/${bytes.length}` },
        body: bytes.subarray(start, end),
      });
      if (!res.ok) throw new PublishError(`TikTok upload ${res.status}`);
    }
    const id = await status(ctx, auth, publish_id);
    const rotated = tok.refresh_token && tok.refresh_token !== secret.refresh_token ? { ...secret, refresh_token: tok.refresh_token } : undefined;
    return { externalId: id ?? publish_id, url: null, ...(rotated ? { secret: rotated } : {}) };
  },
};

/** Waits for TikTok to finish the post; the post id when TikTok says it (public posts only). */
async function status(ctx: PublishContext, headers: Record<string, string>, publishId: string): Promise<string | null> {
  for (let i = 0; i < (ctx.pollTries ?? 120); i++) {
    const { json } = await callJson<Envelope<{ status?: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }>>(
      ctx,
      "TikTok",
      "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      { method: "POST", headers, body: JSON.stringify({ publish_id: publishId }) },
    );
    const d = ok("TikTok", json);
    if (d.status === "PUBLISH_COMPLETE") return d.publicaly_available_post_id?.[0] != null ? String(d.publicaly_available_post_id[0]) : null;
    if (d.status === "FAILED") throw new PublishError(`TikTok: ${d.fail_reason ?? "the post failed"}`);
    await wait(ctx);
  }
  throw new PublishError("TikTok took too long to process the video");
}
