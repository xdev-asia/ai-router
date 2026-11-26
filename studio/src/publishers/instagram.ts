import { PublishError, callJson, need, wait, type Publisher } from "./types.ts";
import { graphVersion } from "./facebook.ts";

/**
 * Instagram Reels (Graph API, an Instagram professional account linked to a Page): a REELS container from a
 * video URL Instagram fetches itself, so PUBLIC_BASE_URL must reach this server, then media_publish once the
 * container is FINISHED. Needs instagram_basic and instagram_content_publish.
 */
export const instagram: Publisher = {
  kind: "instagram",
  name: "Instagram Reels",
  secretFields: [{ key: "access_token", label: "Access token", help: "a long-lived user or Page token with instagram_content_publish" }],
  configFields: [
    { key: "ig_user_id", label: "Instagram user id", help: "the professional account's id (not the @name)" },
    { key: "graph_version", label: "Graph API version", help: "default v23.0", optional: true },
  ],
  async publish(secret, config, input, ctx) {
    if (!input.videoUrl) throw new PublishError("Instagram fetches the video from a public URL: set PUBLIC_BASE_URL");
    const token = need(secret, "access_token", "Instagram");
    const base = `https://graph.facebook.com/${graphVersion(config)}`;
    const user = encodeURIComponent(need(config, "ig_user_id", "Instagram"));
    const post = (path: string, body: Record<string, string>) =>
      callJson<{ id?: string }>(ctx, "Instagram", `${base}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, access_token: token }),
      });
    const { json: container } = await post(`${user}/media`, {
      media_type: "REELS",
      video_url: input.videoUrl,
      caption: `${input.title}\n\n${input.caption}`.slice(0, 2200),
      share_to_feed: "true",
      ...(input.coverUrl ? { cover_url: input.coverUrl } : {}),
    });
    if (!container.id) throw new PublishError("Instagram answered no container id");
    const get = <T>(path: string) => callJson<T>(ctx, "Instagram", `${base}/${path}`, { headers: { authorization: `Bearer ${token}` } });
    for (let i = 0; ; i++) {
      const { json } = await get<{ status_code?: string; status?: string }>(`${encodeURIComponent(container.id)}?fields=status_code,status`);
      if (json.status_code === "FINISHED") break;
      if (json.status_code === "ERROR" || json.status_code === "EXPIRED") throw new PublishError(`Instagram: ${json.status ?? json.status_code}`);
      if (i >= (ctx.pollTries ?? 120)) throw new PublishError("Instagram took too long to process the video");
      await wait(ctx);
    }
    const { json: media } = await post(`${user}/media_publish`, { creation_id: container.id });
    if (!media.id) throw new PublishError("Instagram answered no media id");
    const { json: link } = await get<{ permalink?: string }>(`${encodeURIComponent(media.id)}?fields=permalink`).catch(() => ({ json: {} as { permalink?: string } }));
    return { externalId: media.id, url: link.permalink ?? null };
  },
};
