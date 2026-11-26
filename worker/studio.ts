import type { Context, Hono } from "hono";
import type { AppEnv } from "./env";
import type { Upstream } from "./proxy";
import { newToken, sha256hex } from "./auth";

/**
 * Clip Studio (`studio/`), the sidecar that makes short clips through this gateway and posts them to channels.
 * The console reaches its API through /admin/studio/* (console sign-in here, the shared STUDIO_SECRET there); the
 * finished clips and covers are public at /studio/files/<id>.(mp4|jpg), for previews, Instagram and Zalo.
 */

/** The system whose gateway token the studio uses: made, or its token renewed, by POST /admin/studio/connect. */
export const STUDIO_SYSTEM = "studio";

const PASS_REQUEST = ["content-type", "accept", "range"];
const PASS_RESPONSE = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"];

function studioBase(c: Context<AppEnv>): { url: string; secret: string } | null {
  const url = c.env.STUDIO_URL?.trim().replace(/\/+$/, "");
  const secret = c.env.STUDIO_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}

const notConfigured = (c: Context<AppEnv>) =>
  c.json({ error: "not_configured", message: "the studio is not set up: STUDIO_URL and STUDIO_SECRET (made by compose's init service)" }, 503);

/** Sends one request on to the studio and hands back its answer with only the headers a browser needs. */
async function forward(c: Context<AppEnv>, send: Upstream, url: string, secret: string | null): Promise<Response> {
  const headers = new Headers();
  for (const k of PASS_REQUEST) {
    const v = c.req.header(k);
    if (v) headers.set(k, v);
  }
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  const method = c.req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();
  let res: Response;
  try {
    res = await send(new Request(url, { method, headers, body }));
  } catch {
    return c.json({ error: "studio_unreachable", message: "could not reach the studio" }, 502);
  }
  const out = new Headers();
  for (const k of PASS_RESPONSE) {
    const v = res.headers.get(k);
    if (v) out.set(k, v);
  }
  if (!out.has("cache-control")) out.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, headers: out });
}

/** Mounted under /admin, which has already checked console access. */
export function studioAdminRoutes(a: Hono<AppEnv>, send: Upstream): void {
  a.get("/studio/status", async (c) => {
    const base = studioBase(c);
    if (!base) return c.json({ configured: false, reachable: false, connected: false });
    try {
      const res = await send(new Request(`${base.url}/api/settings`, { headers: { authorization: `Bearer ${base.secret}` } }));
      if (!res.ok) return c.json({ configured: true, reachable: false, connected: false, message: `the studio answered ${res.status}` });
      const s = (await res.json()) as { has_token?: unknown; public_base_url?: unknown; can_store?: unknown };
      const system = await c.env.DB.prepare("SELECT id FROM system WHERE id = ?").bind(STUDIO_SYSTEM).first();
      return c.json({ configured: true, reachable: true, connected: s.has_token === true && !!system, system: STUDIO_SYSTEM, public_base_url: s.public_base_url ?? null, can_store: s.can_store === true });
    } catch {
      return c.json({ configured: true, reachable: false, connected: false, message: "could not reach the studio" });
    }
  });

  /**
   * Makes the `studio` system (allowed every model; the owner can narrow it on the Systems page) or renews its
   * token, and hands the token and this gateway's public files address to the studio. The token never comes back.
   */
  a.post("/studio/connect", async (c) => {
    const base = studioBase(c);
    if (!base) return notConfigured(c);
    const token = newToken();
    const hash = await sha256hex(token);
    const existing = await c.env.DB.prepare("SELECT id FROM system WHERE id = ?").bind(STUDIO_SYSTEM).first();
    if (existing) await c.env.DB.prepare("UPDATE system SET token_sha256 = ? WHERE id = ?").bind(hash, STUDIO_SYSTEM).run();
    else
      await c.env.DB.prepare("INSERT INTO system (id, name, token_sha256, monthly_token_cap, disabled, allowed_models, created_at) VALUES (?, ?, ?, NULL, 0, ?, ?)")
        .bind(STUDIO_SYSTEM, "Clip Studio", hash, JSON.stringify(["*"]), Math.floor(Date.now() / 1000))
        .run();
    const origin = new URL(c.req.url).origin;
    let res: Response;
    try {
      res = await send(
        new Request(`${base.url}/api/settings`, {
          method: "PUT",
          headers: { authorization: `Bearer ${base.secret}`, "content-type": "application/json" },
          body: JSON.stringify({ ai_router_token: token, public_base_url: `${origin}/studio` }),
        }),
      );
    } catch {
      return c.json({ error: "studio_unreachable", message: "could not reach the studio" }, 502);
    }
    if (!res.ok) return c.json({ error: "studio_refused", message: `the studio answered ${res.status}` }, 502);
    return c.json({ connected: true, system: STUDIO_SYSTEM, created: !existing });
  });

  a.all("/studio/api/*", async (c) => {
    const base = studioBase(c);
    if (!base) return notConfigured(c);
    const url = new URL(c.req.url);
    const rest = url.pathname.slice(url.pathname.indexOf("/studio/api/") + "/studio/api".length);
    return forward(c, send, `${base.url}/api${rest}${url.search}`, base.secret);
  });
}

/** Public, no sign-in: a finished clip or its cover (project ids are random UUIDs). */
export function studioFileRoutes(app: Hono<AppEnv>, send: Upstream): void {
  app.get("/studio/files/:name{[0-9a-f-]{36}\\.(mp4|jpg)}", async (c) => {
    const base = studioBase(c);
    if (!base) return c.text("not found", 404);
    return forward(c, send, `${base.url}/files/${c.req.param("name")}`, null);
  });
}
