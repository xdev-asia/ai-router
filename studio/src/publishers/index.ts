import { facebook } from "./facebook.ts";
import { instagram } from "./instagram.ts";
import { telegram } from "./telegram.ts";
import { tiktok } from "./tiktok.ts";
import type { Publisher } from "./types.ts";
import { youtube } from "./youtube.ts";
import { zalo } from "./zalo.ts";

export const PUBLISHERS: Publisher[] = [youtube, tiktok, facebook, instagram, telegram, zalo];

export const publisherOf = (kind: string): Publisher | undefined => PUBLISHERS.find((p) => p.kind === kind);
