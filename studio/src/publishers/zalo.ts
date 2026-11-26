import { PublishError, callJson, need, type Publisher } from "./types.ts";

/**
 * Zalo Official Account: an article (Zalo OA's "bài viết") with the clip's cover, its text and links to where the
 * clip is up (the other channels of this project, or final.mp4 at PUBLIC_BASE_URL). The OA API's video upload is
 * for article videos that Zalo reviews separately; this MVP posts the link instead. Zalo refresh tokens are used
 * once: the new one Zalo hands back is stored.
 */
export const zalo: Publisher = {
  kind: "zalo",
  name: "Zalo OA",
  secretFields: [
    { key: "app_id", label: "App id" },
    { key: "secret_key", label: "App secret key" },
    { key: "refresh_token", label: "OA refresh token", help: "used once; the new one is stored after each post" },
  ],
  configFields: [{ key: "author", label: "Author shown on the article", optional: true }],
  async publish(secret, config, input, ctx) {
    const { json: tok } = await callJson<{ access_token?: string; refresh_token?: string; error?: number | string; error_name?: string; message?: string }>(
      ctx,
      "Zalo OAuth",
      "https://oauth.zaloapp.com/v4/oa/access_token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", secret_key: need(secret, "secret_key", "Zalo") },
        body: new URLSearchParams({ app_id: need(secret, "app_id", "Zalo"), refresh_token: need(secret, "refresh_token", "Zalo"), grant_type: "refresh_token" }),
      },
    );
    if (!tok.access_token) throw new PublishError(`Zalo OAuth: ${tok.error_name ?? tok.message ?? tok.error ?? "no access token"}`);
    const rotated = tok.refresh_token ? { ...secret, refresh_token: tok.refresh_token } : undefined;
    const links = [...input.links, ...(input.videoUrl ? [input.videoUrl] : [])];
    if (!input.coverUrl || !links.length) throw new PublishError("Zalo posts an article linking to the clip: set PUBLIC_BASE_URL, or publish to another channel first");
    const body = [
      { type: "text", content: input.caption.replace(/\n/g, "<br>") },
      ...links.map((l) => ({ type: "text", content: `<a href="${encodeURI(l)}">${escapeHtml(l)}</a>` })),
    ];
    const { json } = await callJson<{ error?: number; message?: string; data?: { token?: string; id?: string } }>(ctx, "Zalo", "https://openapi.zalo.me/v2.0/article/create", {
      method: "POST",
      headers: { "content-type": "application/json", access_token: tok.access_token },
      body: JSON.stringify({
        type: "normal",
        title: input.title.slice(0, 150),
        author: (config.author || "Clip Studio").slice(0, 50),
        cover: { cover_type: "photo", photo_url: input.coverUrl, status: "show" },
        description: input.caption.slice(0, 300),
        body,
        status: "show",
        comment: "show",
      }),
    });
    if (json.error && json.error !== 0) {
      // The rotated token is still kept: the old one no longer works.
      const err = new PublishError(`Zalo ${json.error}: ${json.message ?? "the article was not created"}`) as PublishError & { secret?: Record<string, string> };
      if (rotated) err.secret = rotated;
      throw err;
    }
    return { externalId: json.data?.id ?? json.data?.token ?? "", url: null, ...(rotated ? { secret: rotated } : {}) };
  },
};

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
