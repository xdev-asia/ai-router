import type { Hono } from "hono";
import type { AppEnv } from "./env";

/**
 * Extra headers the owner adds to every request to a provider (custom headers on a Codex sign-in).
 * Only Codex for now. Stored in the `setting` table under "provider_headers" as {provider: {name: value}}.
 * A header that carries a credential or decides where the request goes cannot be set here.
 */

const PROVIDERS = new Set(["codex"]);
const MAX_HEADERS = 20;
const MAX_VALUE = 512;
const NAME = /^[A-Za-z0-9-]{1,64}$/;
const BLOCKED = new Set(["authorization", "cookie", "host", "content-length", "content-type", "x-relay-secret", "chatgpt-account-id", "proxy-authorization", "connection", "transfer-encoding"]);
const SECRETISH = /key|token|secret|auth|cookie|session/i;

type All = Record<string, Record<string, string>>;

async function readAll(db: D1Database): Promise<All> {
  const row = await db.prepare("SELECT value FROM setting WHERE key = 'provider_headers'").first<{ value: string }>();
  if (!row) return {};
  try {
    const v = JSON.parse(row.value) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as All) : {};
  } catch {
    return {};
  }
}

export async function providerHeaders(db: D1Database, provider: string): Promise<Record<string, string>> {
  const h = (await readAll(db))[provider];
  if (!h) return {};
  // Read through the same check as a write: a damaged row adds nothing it should not.
  return validHeaders(h) ?? {};
}

/** The headers when every name and value may be sent; null otherwise. */
export function validHeaders(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_HEADERS) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!NAME.test(name) || BLOCKED.has(name.toLowerCase()) || SECRETISH.test(name)) return null;
    if (typeof value !== "string" || value.length > MAX_VALUE || /[\r\n]/.test(value)) return null;
    out[name] = value;
  }
  return out;
}

export function providerHeaderRoutes(a: Hono<AppEnv>): void {
  a.get("/providers/:id/headers", async (c) => {
    const id = c.req.param("id");
    if (!PROVIDERS.has(id)) return c.json({ error: "not_found", message: "custom headers are only for codex" }, 404);
    return c.json({ headers: await providerHeaders(c.env.DB, id) });
  });
  a.put("/providers/:id/headers", async (c) => {
    const id = c.req.param("id");
    if (!PROVIDERS.has(id)) return c.json({ error: "not_found", message: "custom headers are only for codex" }, 404);
    const b = (await c.req.json().catch(() => null)) as { headers?: unknown } | null;
    const headers = validHeaders(b?.headers);
    if (!headers)
      return c.json(
        { error: "invalid_request", message: `headers: at most ${MAX_HEADERS}, names of letters, digits and dashes, values up to ${MAX_VALUE} characters; no credential or routing header` },
        400,
      );
    const all = await readAll(c.env.DB);
    all[id] = headers;
    await c.env.DB.prepare(
      "INSERT INTO setting (key, value, updated_at) VALUES ('provider_headers', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
      .bind(JSON.stringify(all), Math.floor(Date.now() / 1000))
      .run();
    return c.json({ headers });
  });
}
