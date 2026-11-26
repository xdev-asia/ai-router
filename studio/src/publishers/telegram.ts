import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { PublishError, callJson, need, type Publisher } from "./types.ts";

/** Telegram: the Bot API's sendVideo to a channel or group the bot can post in. Bots send files of 50 MB at most. */
export const telegram: Publisher = {
  kind: "telegram",
  name: "Telegram",
  secretFields: [{ key: "bot_token", label: "Bot token", help: "from @BotFather" }],
  configFields: [{ key: "chat_id", label: "Chat", help: "@channelname or a numeric chat id; the bot must be an admin of a channel" }],
  async publish(secret, config, input, ctx) {
    const token = need(secret, "bot_token", "Telegram");
    const chat = need(config, "chat_id", "Telegram");
    const body = new FormData();
    body.set("chat_id", chat);
    body.set("caption", `${input.title}\n\n${input.caption}`.slice(0, 1024));
    body.set("supports_streaming", "true");
    body.set("width", "1080");
    body.set("height", "1920");
    body.set("video", await openAsBlob(input.file, { type: "video/mp4" }), basename(input.file));
    const { json } = await callJson<{ ok?: boolean; description?: string; result?: { message_id?: number; chat?: { username?: string } } }>(
      ctx,
      "Telegram",
      `https://api.telegram.org/bot${token}/sendVideo`,
      { method: "POST", body },
    );
    if (!json.ok || !json.result?.message_id) throw new PublishError(`Telegram: ${json.description ?? "the video was not sent"}`);
    const user = json.result.chat?.username ?? (chat.startsWith("@") ? chat.slice(1) : null);
    return { externalId: String(json.result.message_id), url: user ? `https://t.me/${user}/${json.result.message_id}` : null };
  },
};
