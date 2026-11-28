import type { Hono, MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";
import { BUILTIN_PREFIXES, isBuiltinProvider, runWithCustomProviders, setCustomProviders, type CustomProviderRow } from "./providers";

/**
 * The owner's providers (custom providers, OpenAI or Anthropic compatible). One is an id, a name, a
 * format and an https base URL (plain http for a server on the local network); it then takes API-key connections and routes as `<id>/<model>` like a built-in one.
 *
 * Base URL, as each format's own SDK takes it:
 *   openai     the URL with its version path (`https://llm.example.com/v1`); the gateway adds /chat/completions, /models
 *   anthropic  the host, like ANTHROPIC_BASE_URL (`https://llm.example.com`); the gateway adds /v1/messages, /v1/models
 *
 * Delete is refused (409 in_use) while the provider has connections, so a key is never dropped without the owner
 * deleting it; once they are gone, the provider's added and disabled models and its account strategy go with it.
 */

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const FORMATS = ["openai", "anthropic"] as const;
type Format = (typeof FORMATS)[number];

interface Row extends CustomProviderRow {
  created_at: number;
  updated_at: number;
}

const COLUMNS = "id, name, format, base_url, created_at, updated_at";
const now = () => Math.floor(Date.now() / 1000);

async function readRows(db: D1Database): Promise<Row[]> {
  return (await db.prepare(`SELECT ${COLUMNS} FROM custom_provider ORDER BY created_at, id`).all<Row>()).results;
}

/** Reads the owner's providers into providers.ts. A database without the table (before migration 0016) has none. */
export async function loadCustomProviders(db: D1Database): Promise<void> {
  try {
    setCustomProviders(await readRows(db));
  } catch {
    setCustomProviders([]);
  }
}

/**
 * Runs before the gateway and admin routes, so the provider lookups see this request's custom providers, and only
 * this request's: another request read at the same time keeps its own.
 */
export const withCustomProviders: MiddlewareHandler<AppEnv> = async (c, next) => {
  let rows: Row[] = [];
  try {
    rows = await readRows(c.env.DB);
  } catch {
    // no table yet (before migration 0016): no custom providers
  }
  await runWithCustomProviders(rows, next);
};

const isFormat = (v: unknown): v is Format => typeof v === "string" && (FORMATS as readonly string[]).includes(v);
const name = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" && v.trim().length <= 100 ? v.trim() : null);

/**
 * A host on this machine or its local network: loopback, a private IPv4 address, host.docker.internal or a
 * one-label name (a compose service such as `ollama`). Such a server (a local Ollama, LM Studio) speaks plain http.
 */
export function localHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "host.docker.internal") return true;
  if (/^[a-z0-9-]+$/.test(h) && !/^\d+$/.test(h)) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!ip) return false;
  const a = Number(ip[1]);
  const b = Number(ip[2]);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A host no provider may point at: the unspecified address and the link-local range (cloud metadata, 169.254/16). */
export function blockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "0.0.0.0" || h === "::" || h === "::0") return true;
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * An https URL (or http to a local host, `localHost`) with no credentials, query or fragment, without its trailing
 * slashes; null otherwise. The unspecified address and the link-local metadata range are refused on either scheme.
 */
export function baseUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 500) return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  const scheme = u.protocol === "https:" || (u.protocol === "http:" && localHost(u.hostname));
  if (!scheme || blockedHost(u.hostname) || u.username || u.password || u.search || u.hash) return null;
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const bad = (message: string) => ({ error: "invalid_request", message });

export function customProviderRoutes(a: Hono<AppEnv>): void {
  a.get("/custom-providers", async (c) => c.json(await readRows(c.env.DB)));

  a.post("/custom-providers", async (c) => {
    const b = await readJson(c.req.raw);
    const id = typeof b?.id === "string" ? b.id.trim() : "";
    if (!ID.test(id)) return c.json(bad("id: 2 to 32 lowercase letters, digits or -, starting with a letter"), 400);
    const n = name(b?.name);
    if (!n) return c.json(bad("name: 1 to 100 characters"), 400);
    if (!isFormat(b?.format)) return c.json(bad("format: openai or anthropic"), 400);
    const url = baseUrl(b?.base_url);
    if (!url) return c.json(bad("base_url: an https URL with no credentials, query or fragment"), 400);
    if (isBuiltinProvider(id) || BUILTIN_PREFIXES.has(id)) return c.json({ error: "taken", message: `${id} is a built-in provider or alias` }, 409);
    const t = now();
    const r = await c.env.DB.prepare(`INSERT INTO custom_provider (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`)
      .bind(id, n, b!.format, url, t, t)
      .run();
    if (!r.meta.changes) return c.json({ error: "taken", message: `${id} already exists` }, 409);
    await loadCustomProviders(c.env.DB);
    return c.json({ id, name: n, format: b!.format, base_url: url, created_at: t, updated_at: t }, 201);
  });

  a.patch("/custom-providers/:id", async (c) => {
    const id = c.req.param("id");
    const cur = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM custom_provider WHERE id = ?`).bind(id).first<Row>();
    if (!cur) return c.json({ error: "not_found" }, 404);
    const b = await readJson(c.req.raw);
    if (!b) return c.json(bad("a JSON object"), 400);
    const next = { ...cur };
    if ("name" in b) {
      const n = name(b.name);
      if (!n) return c.json(bad("name: 1 to 100 characters"), 400);
      next.name = n;
    }
    if ("format" in b) {
      if (!isFormat(b.format)) return c.json(bad("format: openai or anthropic"), 400);
      next.format = b.format;
    }
    if ("base_url" in b) {
      const url = baseUrl(b.base_url);
      if (!url) return c.json(bad("base_url: an https URL with no credentials, query or fragment"), 400);
      next.base_url = url;
    }
    next.updated_at = now();
    await c.env.DB.prepare("UPDATE custom_provider SET name = ?, format = ?, base_url = ?, updated_at = ? WHERE id = ?").bind(next.name, next.format, next.base_url, next.updated_at, id).run();
    await loadCustomProviders(c.env.DB);
    return c.json(next);
  });

  a.delete("/custom-providers/:id", async (c) => {
    const id = c.req.param("id");
    const db = c.env.DB;
    if (!(await db.prepare("SELECT 1 FROM custom_provider WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
    const n = (await db.prepare("SELECT COUNT(*) AS n FROM connection WHERE provider = ?").bind(id).first<number>("n")) ?? 0;
    if (n > 0) return c.json({ error: "in_use", message: `delete its ${n} connection(s) first`, connections: n }, 409);
    await db.batch([
      db.prepare("DELETE FROM custom_provider WHERE id = ?").bind(id),
      db.prepare("DELETE FROM model_custom WHERE provider = ?").bind(id),
      db.prepare("DELETE FROM model_disabled WHERE provider = ?").bind(id),
      db.prepare("DELETE FROM provider_setting WHERE provider = ?").bind(id),
    ]);
    await loadCustomProviders(db);
    return c.body(null, 204);
  });
}
