/**
 * MCP tokens: tokens the owner makes for AI clients on /mcp (mcp.ts), each with a level per group of tools and an
 * optional expiry. A token is shown once, on create; only its SHA-256 and last 4 characters are kept. An MCP token
 * reaches /mcp only, never the admin API, and no tool makes or lists MCP tokens.
 */
import type { Hono } from "hono";
import { sha256hex } from "./auth";
import type { AppEnv } from "./env";

export const GROUPS = ["combos", "models", "systems", "connections", "usage", "settings"] as const;
export type Group = (typeof GROUPS)[number];
export type Level = "none" | "read" | "write";
export type Scopes = Record<Group, Level>;

/** Groups with nothing to change: read is their highest level. */
const READ_ONLY: ReadonlySet<Group> = new Set(["usage"]);
export const EXPIRY_DAYS = [7, 30, 90] as const;
const DEFAULT_EXPIRY_DAYS = 90;

/** Every group at write (read where nothing can be changed): what the admin token may do. */
export const ALL: Scopes = Object.fromEntries(GROUPS.map((g) => [g, READ_ONLY.has(g) ? "read" : "write"])) as Scopes;

/** True when `level` covers what a tool needs: write covers read. */
export const allows = (level: Level, need: "read" | "write") => level === "write" || (level === "read" && need === "read");

/** The scopes in a request body: every group present, missing ones "none". Null when one is not a group or a level. */
export function readScopes(v: unknown): Scopes | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = Object.fromEntries(GROUPS.map((g) => [g, "none"])) as Scopes;
  for (const [k, level] of Object.entries(v)) {
    if (!(GROUPS as readonly string[]).includes(k)) return null;
    if (level !== "none" && level !== "read" && level !== "write") return null;
    if (level === "write" && READ_ONLY.has(k as Group)) return null;
    out[k as Group] = level;
  }
  return out;
}

/** A new MCP token: `xmcp_` + 32 random bytes, base64url (43 chars). */
function newMcpToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "xmcp_" + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Row {
  id: string;
  name: string;
  hint: string;
  scopes: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
}
const COLUMNS = "id, name, hint, scopes, created_at, expires_at, last_used_at";
const view = (r: Row) => ({ ...r, scopes: readScopes(JSON.parse(r.scopes)) ?? readScopes({})! });

const now = () => Math.floor(Date.now() / 1000);
const isName = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 100;

/** The scopes of a token that is known and not expired, and its id; null otherwise. Notes the use at most once a minute. */
export async function mcpTokenAccess(db: D1Database, token: string, waitUntil: (p: Promise<unknown>) => void): Promise<{ id: string; scopes: Scopes } | null> {
  if (!token.startsWith("xmcp_")) return null;
  const row = await db.prepare(`SELECT ${COLUMNS} FROM mcp_token WHERE token_sha256 = ?`).bind(await sha256hex(token)).first<Row>();
  const t = now();
  if (!row || (row.expires_at !== null && row.expires_at <= t)) return null;
  if (row.last_used_at === null || t - row.last_used_at >= 60) {
    waitUntil(db.prepare("UPDATE mcp_token SET last_used_at = ? WHERE id = ?").bind(t, row.id).run().catch(() => undefined));
  }
  return { id: row.id, scopes: view(row).scopes };
}

/** Owner-only, under /admin (admin.ts): list, create (the token once), change name and levels, revoke. */
export function mcpTokenRoutes(a: Hono<AppEnv>): void {
  a.get("/mcp-tokens", async (c) => {
    const r = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM mcp_token ORDER BY created_at DESC, id`).all<Row>();
    return c.json(r.results.map(view));
  });

  a.post("/mcp-tokens", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const scopes = readScopes(b?.scopes ?? {});
    const days = b && "expires_days" in b ? b.expires_days : DEFAULT_EXPIRY_DAYS;
    if (!b || !isName(b.name) || !scopes || !(days === null || (EXPIRY_DAYS as readonly unknown[]).includes(days))) {
      return c.json({ error: "invalid_input", hint: `name: 1-100 chars; scopes: {${GROUPS.join(", ")}}: none, read or write (usage: read at most); expires_days: ${EXPIRY_DAYS.join(", ")} or null` }, 400);
    }
    const token = newMcpToken();
    const id = crypto.randomUUID();
    const created = now();
    const expires = days === null ? null : created + (days as number) * 86400;
    const row: Row = { id, name: b.name.trim(), hint: token.slice(-4), scopes: JSON.stringify(scopes), created_at: created, expires_at: expires, last_used_at: null };
    await c.env.DB.prepare("INSERT INTO mcp_token (id, name, token_sha256, hint, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, row.name, await sha256hex(token), row.hint, row.scopes, created, expires)
      .run();
    return c.json({ ...view(row), token }, 201);
  });

  a.patch("/mcp-tokens/:id", async (c) => {
    const id = c.req.param("id");
    const cur = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM mcp_token WHERE id = ?`).bind(id).first<Row>();
    if (!cur) return c.json({ error: "not_found" }, 404);
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) return c.json({ error: "invalid_input" }, 400);
    const next = { ...cur };
    if ("name" in b) {
      if (!isName(b.name)) return c.json({ error: "invalid_input", field: "name" }, 400);
      next.name = b.name.trim();
    }
    if ("scopes" in b) {
      const s = readScopes(b.scopes);
      if (!s) return c.json({ error: "invalid_input", field: "scopes" }, 400);
      next.scopes = JSON.stringify(s);
    }
    await c.env.DB.prepare("UPDATE mcp_token SET name = ?, scopes = ? WHERE id = ?").bind(next.name, next.scopes, id).run();
    return c.json(view(next));
  });

  a.delete("/mcp-tokens/:id", async (c) => {
    const r = await c.env.DB.prepare("DELETE FROM mcp_token WHERE id = ?").bind(c.req.param("id")).run();
    if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });
}
