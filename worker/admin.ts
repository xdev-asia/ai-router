import { Hono } from "hono";
import { SYSTEM_COLUMNS, isAdmin, newToken, sha256hex, toSystem, type System } from "./auth";
import { isLevel } from "./savers";
import { consoleUser, sameOrigin } from "./console-auth";
import { createApiKeyConnection, getConnection, isStrategy, listConnections, sealApiKey, testConnection } from "./connections";
import { COMBO_NAME, PATTERN, PROVIDERS, hasEnvKey, isProvider, parseModel, providerDef, type ProviderId } from "./providers";
import type { AppEnv } from "./env";
import { finishLogin, oauthDef, startLogin } from "./oauth";
import type { Upstream } from "./proxy";
import { reportRoutes } from "./report";
import { getTokenSaver, mergeTokenSaver, saveTokenSaver } from "./settings";
import { currentMonth, monthRange } from "./usage";

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

type SystemRow = Parameters<typeof toSystem>[0];

const isCap = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
const isName = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 100;
const isApiKey = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 4096;
const NO_BOX = { error: "not_configured", hint: "set the CONNECTIONS_KEY secret: 32 random bytes, base64" } as const;

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function getSystem(db: D1Database, id: string): Promise<System | null> {
  const row = await db.prepare(`SELECT ${SYSTEM_COLUMNS} FROM system WHERE id = ?`).bind(id).first<SystemRow>();
  return row ? toSystem(row) : null;
}

/**
 * Owner-only management: `Authorization: Bearer <admin token>` checked against ADMIN_TOKEN_SHA256,
 * or the console's xDev ID session cookie (see console-auth.ts).
 * A system's plain token is returned once, on create and rotate, and stored only as its SHA-256.
 */
export function adminRoutes(upstream: Upstream): Hono<AppEnv> {
  const a = new Hono<AppEnv>();

  a.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    const req = c.req.raw;
    if (req.headers.has("authorization")) {
      // A wrong token is refused even when a console cookie is also present.
      if (!(await isAdmin(c.env, req))) return c.json({ error: "unauthorized" }, 401);
      return next();
    }
    // Console signed in with xDev ID. Writes must come from the console's own pages (no cross-site requests).
    if (!(await consoleUser(c.env, req))) return c.json({ error: "unauthorized" }, 401);
    if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return c.json({ error: "forbidden" }, 403);
    await next();
  });

  a.get("/systems", async (c) => {
    const r = await c.env.DB.prepare(`SELECT ${SYSTEM_COLUMNS} FROM system ORDER BY id`).all<SystemRow>();
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
    if ("allowed_models" in b) {
      const v = b.allowed_models;
      // null: Claude only. Otherwise up to 50 patterns: "*", "provider/*", "provider/model" or "combo/name".
      if (v !== null && !(Array.isArray(v) && v.length <= 50 && v.every((p) => typeof p === "string" && PATTERN.test(p)))) {
        return c.json({ error: "invalid_input", field: "allowed_models" }, 400);
      }
      next.allowed_models = v === null ? null : JSON.stringify([...new Set(v as string[])]);
    }
    if ("rtk" in b) {
      if (typeof b.rtk !== "boolean") return c.json({ error: "invalid_input", field: "rtk" }, 400);
      next.rtk = b.rtk;
    }
    for (const f of ["caveman", "ponytail"] as const) {
      if (!(f in b)) continue;
      if (b[f] !== null && !isLevel(b[f])) return c.json({ error: "invalid_input", field: f, hint: "lite, full, ultra or null" }, 400);
      next[f] = b[f] as string | null;
    }
    await c.env.DB.prepare("UPDATE system SET name = ?, monthly_token_cap = ?, disabled = ?, allowed_models = ?, rtk = ?, caveman = ?, ponytail = ? WHERE id = ?")
      .bind(next.name, next.monthly_token_cap, next.disabled ? 1 : 0, next.allowed_models, next.rtk ? 1 : 0, next.caveman, next.ponytail, id)
      .run();
    return c.json(next);
  });

  /** Combos: `combo/<name>` tries `targets` ("provider/model" or "claude-*") in order. */
  a.get("/combos", async (c) => {
    const r = await c.env.DB.prepare("SELECT name, targets, updated_at FROM combo ORDER BY name").all<{ name: string; targets: string; updated_at: number }>();
    return c.json(r.results.map((x) => ({ name: x.name, targets: JSON.parse(x.targets) as string[], updated_at: x.updated_at })));
  });

  a.put("/combos/:name", async (c) => {
    const name = c.req.param("name");
    const b = await readJson(c.req.raw);
    const targets = b?.targets;
    const valid =
      COMBO_NAME.test(name) &&
      Array.isArray(targets) &&
      targets.length >= 1 &&
      targets.length <= 10 &&
      targets.every((t) => parseModel(t)?.kind === "target");
    if (!valid) return c.json({ error: "invalid_input", hint: "name: ^[a-z][a-z0-9-]{0,31}$, targets: 1-10 of provider/model or claude-*" }, 400);
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare("INSERT INTO combo (name, targets, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET targets = excluded.targets, updated_at = excluded.updated_at")
      .bind(name, JSON.stringify(targets), now)
      .run();
    return c.json({ name, targets, updated_at: now });
  });

  a.delete("/combos/:name", async (c) => {
    const r = await c.env.DB.prepare("DELETE FROM combo WHERE name = ?").bind(c.req.param("name")).run();
    if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  /**
   * Connections: provider accounts, several per provider, tried in priority order (connections.ts).
   * A key goes in once and never comes back out: answers carry only its last 4 characters (`hint`).
   */
  a.get("/connections", async (c) => c.json(await listConnections(c.env.DB)));

  /**
   * The providers the gateway can reach, for the console. `env_key`: the environment holds a key for it.
   * `key_url`: the provider's page for creating a key. `strategy`: how its connections are picked.
   */
  a.get("/providers", async (c) => {
    const set = await c.env.DB.prepare("SELECT provider, strategy FROM provider_setting").all<{ provider: string; strategy: string }>();
    const strategy = new Map(set.results.map((x) => [x.provider, x.strategy]));
    return c.json(
      (Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
        const def = providerDef(id);
        return { id, name: def.name, format: def.format, auth: [def.auth ?? "api_key"], env_key: hasEnvKey(c.env, id), key_url: def.keyUrl ?? null, strategy: strategy.get(id) ?? "fill-first", color: def.color, mark: def.mark };
      }),
    );
  });

  /** "fill-first": connections in priority order. "round-robin": the one that answered longest ago first. */
  a.put("/providers/:id/strategy", async (c) => {
    const provider = c.req.param("id");
    if (!isProvider(provider)) return c.json({ error: "not_found" }, 404);
    const b = await readJson(c.req.raw);
    if (!b || !isStrategy(b.strategy)) return c.json({ error: "invalid_input", hint: "strategy: fill-first or round-robin" }, 400);
    await (b.strategy === "fill-first"
      ? c.env.DB.prepare("DELETE FROM provider_setting WHERE provider = ?").bind(provider)
      : c.env.DB.prepare("INSERT INTO provider_setting (provider, strategy) VALUES (?, ?) ON CONFLICT (provider) DO UPDATE SET strategy = excluded.strategy").bind(provider, b.strategy)
    ).run();
    return c.json({ provider, strategy: b.strategy });
  });

  /**
   * Subscription login (oauth.ts). `start` answers the provider's sign-in page to open. `finish` takes what the
   * provider sent the browser back with: the whole address (`callback_url`) or its `code` and `state`.
   */
  a.post("/oauth/:provider/start", async (c) => {
    const r = await startLogin(c.env, c.req.param("provider"));
    if (r.ok) return c.json({ authorize_url: r.url });
    return r.error === "not_configured" ? c.json(NO_BOX, 500) : c.json({ error: "not_found" }, 404);
  });

  a.post("/oauth/:provider/finish", async (c) => {
    const provider = c.req.param("provider");
    if (!oauthDef(provider)) return c.json({ error: "not_found" }, 404);
    const b = await readJson(c.req.raw);
    let code: unknown = b?.code;
    let state: unknown = b?.state;
    if (typeof b?.callback_url === "string") {
      try {
        const u = new URL(b.callback_url);
        code = u.searchParams.get("code");
        state = u.searchParams.get("state");
      } catch {
        // falls through to invalid_input
      }
    }
    if (typeof code !== "string" || code === "" || typeof state !== "string" || state === "") {
      return c.json({ error: "invalid_input", hint: "callback_url: the address the browser ended on, or code and state" }, 400);
    }
    const r = await finishLogin(c.env, upstream, provider, code, state);
    if (!r.ok) return c.json({ error: r.error, message: r.message }, r.status);
    return c.json(await getConnection(c.env.DB, r.id), 201);
  });

  /** Checks the connection's key at the provider (its model list; no tokens spent). Always 200 with `{ok}`. */
  a.post("/connections/:id/test", async (c) => {
    const result = await testConnection(c.env, upstream, c.req.param("id"));
    return result ? c.json(result) : c.json({ error: "not_found" }, 404);
  });

  /** Sets the order accounts are tried in: `ids` is every connection of the provider, first to last. */
  a.put("/providers/:id/order", async (c) => {
    const provider = c.req.param("id");
    if (!isProvider(provider)) return c.json({ error: "not_found" }, 404);
    const b = await readJson(c.req.raw);
    const ids = b?.ids;
    const current = (await listConnections(c.env.DB)).filter((x) => x.provider === provider);
    const valid =
      Array.isArray(ids) &&
      ids.length === current.length &&
      new Set(ids).size === ids.length &&
      ids.every((id) => typeof id === "string" && current.some((x) => x.id === id));
    if (!valid) return c.json({ error: "invalid_input", hint: "ids: every connection id of this provider, once each" }, 400);
    const now = Math.floor(Date.now() / 1000);
    if (ids.length > 0) {
      await c.env.DB.batch(
        (ids as string[]).map((id, i) => c.env.DB.prepare("UPDATE connection SET priority = ?, updated_at = ? WHERE id = ?").bind(i + 1, now, id)),
      );
    }
    return c.json((await listConnections(c.env.DB)).filter((x) => x.provider === provider));
  });

  a.post("/connections", async (c) => {
    const b = await readJson(c.req.raw);
    if (!b || typeof b.provider !== "string" || !isProvider(b.provider) || !isName(b.name) || !isApiKey(b.api_key)) {
      return c.json({ error: "invalid_input", hint: "provider: a known provider id, name: 1-100 chars, api_key: the provider's key" }, 400);
    }
    if (providerDef(b.provider).auth === "oauth") {
      return c.json({ error: "invalid_input", hint: "this provider takes a sign-in, not an API key: POST /admin/oauth/:provider/start" }, 400);
    }
    const created = await createApiKeyConnection(c.env, b.provider, b.name.trim(), b.api_key.trim());
    if (!created) return c.json(NO_BOX, 500);
    return c.json(created, 201);
  });

  a.patch("/connections/:id", async (c) => {
    const id = c.req.param("id");
    const cur = await getConnection(c.env.DB, id);
    if (!cur) return c.json({ error: "not_found" }, 404);
    const b = await readJson(c.req.raw);
    if (!b) return c.json({ error: "invalid_input" }, 400);
    const sets: string[] = [];
    const args: unknown[] = [];
    if ("name" in b) {
      if (!isName(b.name)) return c.json({ error: "invalid_input", field: "name" }, 400);
      sets.push("name = ?");
      args.push(b.name.trim());
    }
    if ("disabled" in b) {
      if (typeof b.disabled !== "boolean") return c.json({ error: "invalid_input", field: "disabled" }, 400);
      sets.push("disabled = ?");
      args.push(b.disabled ? 1 : 0);
    }
    if ("priority" in b) {
      if (typeof b.priority !== "number" || !Number.isSafeInteger(b.priority) || b.priority < 1) return c.json({ error: "invalid_input", field: "priority" }, 400);
      sets.push("priority = ?");
      args.push(b.priority);
    }
    if ("api_key" in b) {
      if (cur.auth_type !== "api_key" || !isApiKey(b.api_key)) return c.json({ error: "invalid_input", field: "api_key" }, 400);
      const sealed = await sealApiKey(c.env, b.api_key.trim());
      if (!sealed) return c.json(NO_BOX, 500);
      // A new key starts clean: what the old key was refused or limited for no longer holds.
      sets.push("secret = ?", "hint = ?", "cooldown_until = 0", "backoff_level = 0", "last_error = NULL", "last_error_at = NULL");
      args.push(sealed.secret, sealed.hint);
    }
    if (sets.length > 0) {
      await c.env.DB.prepare(`UPDATE connection SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...args, Math.floor(Date.now() / 1000), id)
        .run();
    }
    return c.json(await getConnection(c.env.DB, id));
  });

  a.delete("/connections/:id", async (c) => {
    const r = await c.env.DB.prepare("DELETE FROM connection WHERE id = ?").bind(c.req.param("id")).run();
    if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
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

  reportRoutes(a);

  /** The savers every system gets (settings.ts). PUT takes any of the fields and keeps the others. */
  a.get("/token-saver", async (c) => c.json(await getTokenSaver(c.env.DB)));

  a.put("/token-saver", async (c) => {
    const b = await readJson(c.req.raw);
    const next = b ? mergeTokenSaver(await getTokenSaver(c.env.DB), b) : null;
    if (!next) {
      return c.json({ error: "invalid_input", hint: "rtk: boolean; caveman, ponytail: lite, full, ultra or null; custom_prompt: up to 4000 chars or null; headroom: {enabled, url}" }, 400);
    }
    await saveTokenSaver(c.env.DB, next);
    return c.json(next);
  });

  a.all("*", (c) => c.json({ error: "not_found" }, 404));

  return a;
}
