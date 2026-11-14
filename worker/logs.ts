import type { Context, Hono, Next } from "hono";
import { presentedToken, sha256hex } from "./auth";
import type { AppEnv } from "./env";
import { capture, observabilityOn, writeDetail } from "./request-details";

/**
 * The console's Logs page (a short request log): one line per request to the gateway's API paths.
 * A line holds the method, path, status, time taken, system, model and, for a failure, the error message the
 * caller got. Never a token, key or request content: messages are cut and anything key-like is masked.
 */

export const KEEP_ROWS = 500;
export const KEEP_MINUTES = 15;
const MAX_MESSAGE = 300;

export interface LogLine {
  id: number;
  at: number;
  level: "info" | "warn" | "error";
  method: string;
  path: string;
  status: number;
  took_ms: number;
  system_id: string | null;
  model: string | null;
  message: string | null;
}

/** Masks anything that looks like a key or a bearer token. Providers echo part of a refused key in their errors. */
export function redact(s: string): string {
  return s
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/\b(?:sk|gsk|xllm|AIza|rk|pk|tvly|sess)[-_A-Za-z0-9*.]{4,}/g, "***")
    .replace(/\S*\*{3,}\S*/g, "***");
}

/** The JSON body a client posted, as text, or null for any other request. */
async function bodyOf(req: Request): Promise<string | null> {
  if (req.method !== "POST" || !(req.headers.get("content-type") ?? "").includes("application/json")) return null;
  return req.text().catch(() => null);
}

function modelOf(body: string | null): string | null {
  if (body === null) return null;
  try {
    const m = (JSON.parse(body) as { model?: unknown }).model;
    return typeof m === "string" ? m.slice(0, 200) : null;
  } catch {
    return null;
  }
}

async function messageOf(res: Response): Promise<string | null> {
  if (res.status < 400 || !(res.headers.get("content-type") ?? "").includes("json")) return null;
  try {
    const b = (await res.json()) as { error?: { message?: unknown } | string; message?: unknown };
    const e = b.error;
    const m = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : typeof b.message === "string" ? b.message : null;
    return m === null ? null : redact(m).slice(0, MAX_MESSAGE);
  } catch {
    return null;
  }
}

async function systemOf(db: D1Database, req: Request): Promise<string | null> {
  const token = presentedToken(req);
  if (!token) return null;
  const r = await db.prepare("SELECT id FROM system WHERE token_sha256 = ?").bind(await sha256hex(token)).first<{ id: string }>();
  return r?.id ?? null;
}

/** Middleware: writes the line after the answer, in the background. */
export async function logRequest(c: Context<AppEnv>, next: Next): Promise<void> {
  const url = new URL(c.req.url);
  // /v1/v1/… is sent again through the app as /v1/…, which writes its own line.
  if (url.pathname.startsWith("/v1/v1/") || c.req.method === "OPTIONS") return next();
  const startedAt = Date.now();
  const db = c.env.DB;
  const body = bodyOf(c.req.raw.clone());
  const model = body.then(modelOf);
  // Read beside the request, so the setting adds no wait.
  const observe = observabilityOn(db).catch(() => false);
  await next();
  const res = c.res;
  const message = res.status >= 400 ? messageOf(res.clone()) : Promise.resolve(null);
  const req = c.req.raw;
  const system = systemOf(db, req).catch(() => null);
  if (await observe) {
    const at = { at: startedAt, path: url.pathname.slice(0, 200), status: res.status, model: await model, request: await body };
    const kept = capture(res, startedAt, async (text, ttft, streamed) => writeDetail(db, at, await system, text, ttft, streamed));
    c.res = kept.res;
    c.executionCtx.waitUntil(kept.done.catch((e: unknown) => console.error("request detail write failed", e instanceof Error ? e.name : "error")));
  }
  const write = async () => {
    const status = res.status;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    await db.batch([
      db
        .prepare("INSERT INTO log (at, level, method, path, status, took_ms, system_id, model, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(startedAt, level, req.method, url.pathname.slice(0, 200), status, Date.now() - startedAt, await system, await model, await message),
      db.prepare("DELETE FROM log WHERE at < ?").bind(Date.now() - KEEP_MINUTES * 60_000),
      db.prepare("DELETE FROM log WHERE id <= (SELECT id FROM log ORDER BY id DESC LIMIT 1 OFFSET ?)").bind(KEEP_ROWS),
    ]);
  };
  c.executionCtx.waitUntil(write().catch((e: unknown) => console.error("log write failed", e instanceof Error ? e.name : "error")));
}

export function logRoutes(a: Hono<AppEnv>): void {
  /** Newest first. `level`: only that level; `q`: path, model, system or message containing it; `after`: lines newer than that id. */
  a.get("/logs", async (c) => {
    const where: string[] = [];
    const binds: unknown[] = [];
    const level = c.req.query("level");
    if (level === "info" || level === "warn" || level === "error") {
      where.push("level = ?");
      binds.push(level);
    }
    const q = c.req.query("q")?.trim();
    if (q) {
      where.push("(path LIKE ? OR model LIKE ? OR system_id LIKE ? OR message LIKE ?)");
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      binds.push(like, like, like, like);
    }
    const after = Number(c.req.query("after"));
    if (Number.isInteger(after) && after > 0) {
      where.push("id > ?");
      binds.push(after);
    }
    const sql = `SELECT * FROM log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${KEEP_ROWS}`;
    // LIKE escape: SQLite needs the ESCAPE clause on each LIKE.
    const r = await c.env.DB.prepare(sql.replace(/LIKE \?/g, "LIKE ? ESCAPE '\\'")).bind(...binds).all<LogLine>();
    return c.json({ logs: r.results, kept: { rows: KEEP_ROWS, minutes: KEEP_MINUTES } }, 200, { "cache-control": "no-store" });
  });
  a.delete("/logs", async (c) => {
    await c.env.DB.prepare("DELETE FROM log").run();
    return c.body(null, 204);
  });
}
