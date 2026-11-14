import type { Hono } from "hono";
import type { AppEnv } from "./env";

/**
 * Settings → Backup (export and import): the gateway's setup as one JSON file. Never a key, a token or a
 * secret: connections, relay pools, web tool keys, systems and console sessions stay out. An import replaces each
 * table it carries and leaves the others alone.
 */

export const BACKUP_TABLES = ["combo", "model_alias", "model_disabled", "model_custom", "price", "setting", "provider_setting"] as const;
type Table = (typeof BACKUP_TABLES)[number];
const isTable = (t: string): t is Table => (BACKUP_TABLES as readonly string[]).includes(t);

const MAX_ROWS = 5000;

async function columnsOf(db: D1Database, t: Table): Promise<Set<string>> {
  const r = await db.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>();
  return new Set(r.results.map((c) => c.name));
}

const isScalar = (v: unknown): v is string | number | boolean | null =>
  v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

const bad = (message: string) => Response.json({ error: "invalid_input", message }, { status: 400 });

export function backupRoutes(a: Hono<AppEnv>): void {
  a.get("/backup", async (c) => {
    const tables: Record<string, unknown[]> = {};
    for (const t of BACKUP_TABLES) tables[t] = (await c.env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
    return c.json({ version: 1, exported_at: new Date().toISOString(), tables }, 200, {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="ai-router-backup.json"`,
    });
  });

  a.post("/backup", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { version?: unknown; tables?: unknown } | null;
    if (!b || b.version !== 1 || !b.tables || typeof b.tables !== "object" || Array.isArray(b.tables)) return bad("expected {version: 1, tables: {...}}");
    const db = c.env.DB;
    const stmts: D1PreparedStatement[] = [];
    let total = 0;
    for (const [t, rows] of Object.entries(b.tables as Record<string, unknown>)) {
      if (!isTable(t)) return bad(`table ${t}: not part of a backup (${BACKUP_TABLES.join(", ")})`);
      if (!Array.isArray(rows)) return bad(`table ${t}: expected a list of rows`);
      total += rows.length;
      if (total > MAX_ROWS) return bad(`at most ${MAX_ROWS} rows`);
      const cols = await columnsOf(db, t);
      stmts.push(db.prepare(`DELETE FROM ${t}`));
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) return bad(`table ${t}: a row is not an object`);
        const entries = Object.entries(row as Record<string, unknown>);
        if (entries.length === 0) return bad(`table ${t}: an empty row`);
        for (const [k, v] of entries) {
          if (!cols.has(k)) return bad(`table ${t}: unknown column ${k}`);
          if (!isScalar(v)) return bad(`table ${t}.${k}: values are strings, numbers or null`);
        }
        stmts.push(
          db
            .prepare(`INSERT INTO ${t} (${entries.map(([k]) => k).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`)
            .bind(...entries.map(([, v]) => (typeof v === "boolean" ? (v ? 1 : 0) : v))),
        );
      }
    }
    try {
      if (stmts.length > 0) await db.batch(stmts);
    } catch (e) {
      // A row that breaks a constraint: the batch is one transaction, nothing was changed.
      return bad(`the import was refused by the database: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`);
    }
    return c.json({ ok: true, rows: total });
  });
}
