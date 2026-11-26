import { readFile } from "node:fs/promises";
import { PublishError, callJson, need, type Publisher } from "./types.ts";

export const graphVersion = (config: Record<string, string>) => config.graph_version || "v23.0";

/**
 * Facebook Page Reels: start an upload session, send the bytes to rupload.facebook.com, then finish it as
 * published. Needs a Page access token with pages_manage_posts, pages_read_engagement and pages_show_list (Meta
 * app review for pages you do not own).
 */
export const facebook: Publisher = {
  kind: "facebook",
  name: "Facebook Reels",
  secretFields: [{ key: "page_access_token", label: "Page access token", help: "a long-lived Page token" }],
  configFields: [
    { key: "page_id", label: "Page id" },
    { key: "graph_version", label: "Graph API version", help: "default v23.0", optional: true },
  ],
  async publish(secret, config, input, ctx) {
    const token = need(secret, "page_access_token", "Facebook");
    const page = encodeURIComponent(need(config, "page_id", "Facebook"));
    const v = graphVersion(config);
    const graph = `https://graph.facebook.com/${v}/${page}/video_reels`;
    const { json: start } = await callJson<{ video_id?: string; upload_url?: string }>(ctx, "Facebook", graph, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ upload_phase: "start", access_token: token }),
    });
    if (!start.video_id) throw new PublishError("Facebook answered no video id");
    const bytes = await readFile(input.file);
    const { json: up } = await callJson<{ success?: boolean }>(ctx, "Facebook upload", start.upload_url ?? `https://rupload.facebook.com/video-upload/${v}/${start.video_id}`, {
      method: "POST",
      headers: { authorization: `OAuth ${token}`, offset: "0", file_size: String(bytes.length), "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (up.success === false) throw new PublishError("Facebook did not take the upload");
    const { json: done } = await callJson<{ success?: boolean }>(ctx, "Facebook", graph, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ upload_phase: "finish", video_id: start.video_id, video_state: "PUBLISHED", description: `${input.title}\n\n${input.caption}`.slice(0, 2200), access_token: token }),
    });
    if (done.success === false) throw new PublishError("Facebook did not publish the reel");
    return { externalId: start.video_id, url: `https://www.facebook.com/reel/${start.video_id}` };
  },
};
