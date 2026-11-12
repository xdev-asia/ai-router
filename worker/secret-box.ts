import type { Env } from "./env";

/**
 * Seals the connections' credentials for storage in D1: AES-256-GCM under the CONNECTIONS_KEY secret
 * (32 random bytes, base64), a fresh 12-byte nonce per value. Stored as `v1.<nonce>.<ciphertext>`, base64url.
 * Nothing here logs a key or a plain value.
 */

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

async function boxKey(env: Env): Promise<CryptoKey | null> {
  const raw = env.CONNECTIONS_KEY ? fromBase64(env.CONNECTIONS_KEY) : null;
  if (!raw || raw.length !== 32) return null;
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Null while CONNECTIONS_KEY is unset or is not 32 bytes. */
export async function seal(env: Env, plain: string): Promise<string | null> {
  const key = await boxKey(env);
  if (!key) return null;
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(plain));
  return `v1.${toBase64Url(nonce)}.${toBase64Url(new Uint8Array(sealed))}`;
}

/** Null when the value was sealed under another key, was altered, or CONNECTIONS_KEY is unset. */
export async function open(env: Env, sealed: string): Promise<string | null> {
  const [version, nonce64, body64] = sealed.split(".");
  if (version !== "v1" || !nonce64 || !body64) return null;
  const key = await boxKey(env);
  const nonce = fromBase64(nonce64);
  const body = fromBase64(body64);
  if (!key || !nonce || !body) return null;
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body));
  } catch {
    return null;
  }
}
