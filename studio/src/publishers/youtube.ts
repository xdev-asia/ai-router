import { readFile } from "node:fs/promises";
import { callJson, need, type Publisher } from "./types.ts";

/**
 * YouTube Shorts: the Data API v3 resumable upload. A vertical video of 3 minutes or less is a Short; "#Shorts" in
 * the title helps. An unverified API project's uploads are locked private until Google audits it.
 */
export const youtube: Publisher = {
  kind: "youtube",
  name: "YouTube",
  secretFields: [
    { key: "client_id", label: "OAuth client ID" },
    { key: "client_secret", label: "OAuth client secret" },
    { key: "refresh_token", label: "Refresh token", help: "scope https://www.googleapis.com/auth/youtube.upload" },
  ],
  configFields: [
    { key: "privacy", label: "Privacy", help: "public, unlisted or private (default public)", optional: true },
    { key: "category_id", label: "Category id", help: "default 22 (People & Blogs)", optional: true },
  ],
  async publish(secret, config, input, ctx) {
    const { json: tok } = await callJson<{ access_token?: string }>(ctx, "Google OAuth", "https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: need(secret, "client_id", "YouTube"),
        client_secret: need(secret, "client_secret", "YouTube"),
        refresh_token: need(secret, "refresh_token", "YouTube"),
        grant_type: "refresh_token",
      }),
    });
    if (!tok.access_token) throw new Error("Google OAuth answered no access token");
    const auth = `Bearer ${tok.access_token}`;
    const bytes = await readFile(input.file);
    const title = (/#shorts/i.test(input.title) ? input.title : `${input.title} #Shorts`).slice(0, 100);
    const meta = {
      snippet: { title, description: input.caption.slice(0, 5000), tags: input.hashtags.slice(0, 15), categoryId: config.category_id || "22" },
      status: { privacyStatus: config.privacy || "public", selfDeclaredMadeForKids: false },
    };
    const { res: start } = await callJson(ctx, "YouTube", "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": "video/mp4",
        "x-upload-content-length": String(bytes.length),
      },
      body: JSON.stringify(meta),
    });
    const location = start.headers.get("location");
    if (!location) throw new Error("YouTube answered no upload URL");
    const { json: video } = await callJson<{ id?: string }>(ctx, "YouTube", location, {
      method: "PUT",
      headers: { authorization: auth, "content-type": "video/mp4" },
      body: bytes,
    });
    if (!video.id) throw new Error("YouTube answered no video id");
    return { externalId: video.id, url: `https://www.youtube.com/shorts/${video.id}` };
  },
};
