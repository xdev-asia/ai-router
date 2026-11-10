import { Hono } from "hono";
import { isAdmin, newToken, sha256hex, toSystem, type System } from "./auth";
import type { AppEnv } from "./env";
import { currentMonth, monthRange } from "./usage";

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

type SystemRow = Parameters<typeof toSystem>[0];

const isCap = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
const isName = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 100;

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function getSystem(db: D1Database, id: string): Promise<System | null> {
  const row = await db.prepare("SELECT id, name, monthly_token_cap, disabled, created_at FROM system WHERE id = ?").bind(id).first<SystemRow>();
  return row ? toSystem(row) : null;
}

/**
 * Owner-only management, `Authorization: Bearer <admin token>` checked against ADMIN_TOKEN_SHA256.
 * A system's plain token is returned once, on create and rotate, and stored only as its SHA-256.
 */
export function adminRoutes(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();

  a.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (!(await isAdmin(c.env, c.req.raw))) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  a.get("/systems", async (c) => {
    const r = await c.env.DB.prepare("SELECT id, name, monthly_token_cap, disabled, created_at FROM system ORDER BY id").all<SystemRow>();
    return c.json(r.results.map(toSystem));
  });

  a.post("/systems", async (c) => {
    const b = await readJson(c.req.raw);
    const cap = b?.monthly_token_cap ?? null;
    if (!b || typeof b.id !== "string" || !ID.test(b.id) || !isName(b.name) || !isCap(cap)) {
      return c.json({ error: "invalid_input", hint: "id: ^[a-z][a-z0-9-]{1,31}$, name: 1-100 chars, monthly_token_cap: integer >= 0 or null" }, 400);
    }
    if (await getSystem(c.env.DB, b.id)) return c.json({ error: "exists" }, 409);
    const token = newToken();
    await c.env.DB.prepare("INSERT INTO system (id, name, token_sha256, monthly_token_cap, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)")
      .bind(b.id, b.name.trim(), await sha256hex(token), cap, Math.floor(Date.now() / 1000))
      .run();
    return c.json({ id: b.id, token }, 201);
  });

  a.post("/systems/:id/rotate", async (c) => {
    const token = newToken();
    const r = await c.env.DB.prepare("UPDATE system SET token_sha256 = ? WHERE id = ?").bind(await sha256hex(token), c.req.param("id")).run();
    if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
    return c.json({ id: c.req.param("id"), token });
  });

  a.patch("/systems/:id", async (c) => {
    const id = c.req.param("id");
    const cur = await getSystem(c.env.DB, id);
    if (!cur) return c.json({ error: "not_found" }, 404);
    const b = await readJson(c.req.raw);
    if (!b) return c.json({ error: "invalid_input" }, 400);
    const next = { ...cur };
    if ("name" in b) {
      if (!isName(b.name)) return c.json({ error: "invalid_input", field: "name" }, 400);
      next.name = b.name.trim();
    }
    if ("monthly_token_cap" in b) {
      if (!isCap(b.monthly_token_cap)) return c.json({ error: "invalid_input", field: "monthly_token_cap" }, 400);
      next.monthly_token_cap = b.monthly_token_cap;
    }
    if ("disabled" in b) {
      if (typeof b.disabled !== "boolean") return c.json({ error: "invalid_input", field: "disabled" }, 400);
      next.disabled = b.disabled;
    }
    await c.env.DB.prepare("UPDATE system SET name = ?, monthly_token_cap = ?, disabled = ? WHERE id = ?")
      .bind(next.name, next.monthly_token_cap, next.disabled ? 1 : 0, id)
      .run();
    return c.json(next);
  });

  /** `?month=YYYY-MM` (UTC), this month when omitted. One row per system, provider and model. */
  a.get("/usage", async (c) => {
    const q = c.req.query("month");
    let year: number, month: number;
    if (q === undefined) {
      ({ year, month } = currentMonth());
    } else {
      const m = MONTH.exec(q);
      if (!m) return c.json({ error: "invalid_month", hint: "YYYY-MM" }, 400);
      year = Number(m[1]);
      month = Number(m[2]);
    }
    const [start, end] = monthRange(year, month);
    const r = await c.env.DB.prepare(
      `SELECT system_id, provider, model, COUNT(*) AS requests,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
              SUM(cache_read_input_tokens) AS cache_read_input_tokens
       FROM usage WHERE at >= ? AND at < ?
       GROUP BY system_id, provider, model
       ORDER BY system_id, provider, model`,
    )
      .bind(start, end)
      .all();
    return c.json({ month: `${year}-${String(month).padStart(2, "0")}`, rows: r.results });
  });

  a.all("*", (c) => c.json({ error: "not_found" }, 404));

  return a;
}
