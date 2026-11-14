import { isLevel, type Level } from "./savers";

/**
 * Gateway-wide settings, one JSON value per key in the `setting` table.
 *
 * "token_saver": the savers every system gets. A system's own Caveman or
 * Ponytail level wins over the gateway's; RTK is on when either has it on. The custom prompt and Headroom exist
 * only here. One request can opt out of all of it with `x-gateway-token-saver: off`.
 */
export interface TokenSaverSettings {
  rtk: boolean;
  caveman: Level | null;
  ponytail: Level | null;
  /** Appended to the system prompt of every request, after the savers' own instructions. */
  custom_prompt: string | null;
  /** A Headroom proxy that shortens the messages before they go to the provider. Its URL gets the request content. */
  headroom: { enabled: boolean; url: string | null };
}

export const TOKEN_SAVER_OFF: TokenSaverSettings = { rtk: false, caveman: null, ponytail: null, custom_prompt: null, headroom: { enabled: false, url: null } };

const MAX_PROMPT = 4000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** `current` with the fields of `patch` laid over it; null when a field is not a valid setting. */
export function mergeTokenSaver(current: TokenSaverSettings, patch: Record<string, unknown>): TokenSaverSettings | null {
  const next: TokenSaverSettings = { ...current, headroom: { ...current.headroom } };
  if ("rtk" in patch) {
    if (typeof patch.rtk !== "boolean") return null;
    next.rtk = patch.rtk;
  }
  for (const f of ["caveman", "ponytail"] as const) {
    if (!(f in patch)) continue;
    const v = patch[f];
    if (v !== null && !isLevel(v)) return null;
    next[f] = v;
  }
  if ("custom_prompt" in patch) {
    const v = patch.custom_prompt;
    if (v !== null && (typeof v !== "string" || v.length > MAX_PROMPT)) return null;
    next.custom_prompt = v === null || v.trim() === "" ? null : v.trim();
  }
  if ("headroom" in patch) {
    const h = patch.headroom;
    if (!isObj(h) || typeof h.enabled !== "boolean" || !(h.url === null || isHttpUrl(h.url)) || (h.enabled && h.url === null)) return null;
    next.headroom = { enabled: h.enabled, url: h.url as string | null };
  }
  return next;
}

export async function getTokenSaver(db: D1Database): Promise<TokenSaverSettings> {
  const row = await db.prepare("SELECT value FROM setting WHERE key = 'token_saver'").first<{ value: string }>();
  if (!row) return TOKEN_SAVER_OFF;
  try {
    // Read through the same validation as a write, so a damaged row falls back to "off" instead of half applying.
    return mergeTokenSaver(TOKEN_SAVER_OFF, JSON.parse(row.value) as Record<string, unknown>) ?? TOKEN_SAVER_OFF;
  } catch {
    return TOKEN_SAVER_OFF;
  }
}

export async function saveTokenSaver(db: D1Database, value: TokenSaverSettings): Promise<void> {
  await db
    .prepare("INSERT INTO setting (key, value, updated_at) VALUES ('token_saver', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(JSON.stringify(value), Math.floor(Date.now() / 1000))
    .run();
}
