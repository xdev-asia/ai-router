import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Settings from the environment (README, Settings). Read once at start. */
export interface Config {
  port: number;
  dataDir: string;
  aiRouterUrl: string;
  aiRouterToken: string;
  /** Every /api call carries `Authorization: Bearer <secret>`: the ai-router Worker in front of this service. */
  secret: string;
  /** 32 bytes, base64: seals channel credentials in the database. */
  channelsKey: Buffer | null;
  /** Where the internet reaches this service, for Instagram's video_url and Zalo's cover and link. */
  publicBaseUrl: string | null;
  subtitleFont: string;
  /** A folder of font files for the subtitles (SUBTITLE_FONTS_DIR), besides the system's fonts. */
  fontsDir: string | null;
}

/**
 * The shared secret: STUDIO_SECRET, else the contents of the file STUDIO_SECRET_FILE names (Docker: generated on
 * the first run, like the Codex relay's). The service does not start without one.
 */
export function studioSecret(env: NodeJS.ProcessEnv, read = (path: string) => readFileSync(path, "utf8")): string {
  let s = env.STUDIO_SECRET;
  if (!s && env.STUDIO_SECRET_FILE) {
    try {
      s = read(env.STUDIO_SECRET_FILE).trim();
    } catch {
      throw new Error("STUDIO_SECRET_FILE cannot be read");
    }
  }
  if (!s) throw new Error("set STUDIO_SECRET or STUDIO_SECRET_FILE");
  if (s.length < 16) throw new Error("the studio secret must be at least 16 characters");
  return s;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let raw = env.CHANNELS_KEY;
  if (!raw && env.CHANNELS_KEY_FILE) {
    try {
      raw = readFileSync(env.CHANNELS_KEY_FILE, "utf8").trim();
    } catch {
      throw new Error("CHANNELS_KEY_FILE cannot be read");
    }
  }
  const key = raw ? Buffer.from(raw, "base64") : null;
  if (key && key.length !== 32) throw new Error("CHANNELS_KEY must be 32 bytes, base64 (openssl rand -base64 32)");
  return {
    port: Number(env.PORT ?? 8791),
    dataDir: resolve(env.STUDIO_DATA_DIR ?? "data"),
    aiRouterUrl: (env.AI_ROUTER_URL ?? "http://localhost:8787").replace(/\/+$/, ""),
    aiRouterToken: env.AI_ROUTER_TOKEN ?? "",
    secret: studioSecret(env),
    channelsKey: key,
    publicBaseUrl: env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/+$/, "") : null,
    subtitleFont: env.SUBTITLE_FONT ?? "DejaVu Sans",
    fontsDir: env.SUBTITLE_FONTS_DIR ? resolve(env.SUBTITLE_FONTS_DIR) : null,
  };
}
