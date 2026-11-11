import type { Env } from "./env";

export interface System {
  id: string;
  name: string;
  monthly_token_cap: number | null;
  disabled: boolean;
  created_at: number;
  /** JSON array of model patterns; null means Claude only. See providers.ts. */
  allowed_models: string | null;
}

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings without an early exit. */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** A new gateway token: `xllm_` + 32 random bytes, base64url (43 chars). */
export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "xllm_" + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The token a caller sent: `x-api-key` (what the Anthropic SDK sends) or `Authorization: Bearer`. */
export function presentedToken(req: Request): string | null {
  const key = req.headers.get("x-api-key");
  if (key) return key;
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  return m?.[1] ?? null;
}

type SystemRow = Omit<System, "disabled"> & { disabled: number };

export const toSystem = (r: SystemRow): System => ({ ...r, disabled: r.disabled === 1 });

export async function systemForToken(db: D1Database, token: string): Promise<System | null> {
  const row = await db
    .prepare("SELECT id, name, monthly_token_cap, disabled, created_at, allowed_models FROM system WHERE token_sha256 = ?")
    .bind(await sha256hex(token))
    .first<SystemRow>();
  return row ? toSystem(row) : null;
}

/** The Anthropic key of a system, from the ANTHROPIC_KEYS secret. Never logged. */
export function anthropicKeyFor(env: Env, systemId: string): string | null {
  if (!env.ANTHROPIC_KEYS) return null;
  try {
    const keys = JSON.parse(env.ANTHROPIC_KEYS) as Record<string, unknown>;
    const k = keys[systemId];
    return typeof k === "string" && k !== "" ? k : null;
  } catch {
    return null;
  }
}

/** True when the request carries the admin bearer token. Always false while ADMIN_TOKEN_SHA256 is unset. */
export async function isAdmin(env: Env, req: Request): Promise<boolean> {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  const expected = env.ADMIN_TOKEN_SHA256;
  const valid = expected !== undefined && /^[0-9a-f]{64}$/.test(expected);
  const got = await sha256hex(m?.[1] ?? "");
  return safeEqual(got, valid ? expected : "0".repeat(64)) && valid && m !== null;
}
