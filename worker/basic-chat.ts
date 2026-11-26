import type { Context, Hono } from "hono";
import type { AppEnv } from "./env";
import type { Upstream } from "./proxy";
import { SYSTEM_COLUMNS, toSystem } from "./auth";
import { errorResponse, runChat } from "./route";
import { tokensThisMonth } from "./usage";
import { listModels } from "./models";
import { sendImages } from "./media";

type SystemRow = Parameters<typeof toSystem>[0];

/**
 * Basic chat and the image playground: the console sends an OpenAI chat or images request with `system` naming one of the owner's systems.
 * It runs as that system (its allowed models, savers and monthly cap), so the usage lands on it like any other call.
 * Mounted under /admin, which has already checked console access.
 */
export function basicChatRoutes(a: Hono<AppEnv>, upstream: Upstream): void {
  const systemOf = async (db: D1Database, id: string) => {
    const row = await db.prepare(`SELECT ${SYSTEM_COLUMNS} FROM system WHERE id = ?`).bind(id).first<SystemRow>();
    return row ? toSystem(row) : null;
  };

  // The models the chat's model picker offers: what /v1/models answers that system.
  a.get("/chat/models", async (c) => {
    const system = await systemOf(c.env.DB, c.req.query("system") ?? "");
    if (!system) return c.json({ error: "not_found" }, 404);
    return c.json({ object: "list", data: await listModels(c.env, upstream, system) });
  });

  /** The body without `system`, and that system once it may run: or the error the console shows. */
  const asSystem = async (c: Context<AppEnv>) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(400, "body must be JSON", "invalid_request_error");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse(400, "body must be a JSON object", "invalid_request_error");
    const { system: id, ...rest } = body as Record<string, unknown>;
    if (typeof id !== "string" || !id) return errorResponse(400, "system: the id of the system to run as", "invalid_request_error");
    const system = await systemOf(c.env.DB, id);
    if (!system) return errorResponse(404, `no system ${id}`, "invalid_request_error", "not_found");
    if (system.disabled) return errorResponse(403, "this system is disabled", "permission_error");
    if (system.monthly_token_cap !== null && (await tokensThisMonth(c.env.DB, system.id)) >= system.monthly_token_cap) {
      return errorResponse(429, "monthly token cap reached for this system", "rate_limit_error");
    }
    return { system, body: rest };
  };

  a.post("/chat/completions", async (c) => {
    const r = await asSystem(c);
    if (r instanceof Response) return r;
    return runChat(c, upstream, r.system, r.body);
  });

  // The Media page's image playground: an OpenAI images request run as that system, like /v1/images/generations.
  a.post("/images/generations", async (c) => {
    const r = await asSystem(c);
    if (r instanceof Response) return r;
    return sendImages(c, upstream, r.system, r.body);
  });
}
