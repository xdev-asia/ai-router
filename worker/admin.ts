import { Hono } from "hono";
import { SYSTEM_COLUMNS, isAdmin, newToken, sha256hex, toSystem, type System } from "./auth";
import { isLevel } from "./savers";
import { consoleUser, sameOrigin } from "./console-auth";
import { checkKey, createApiKeyConnection, getConnection, isStrategy, listConnections, sealApiKey, storedSecret, testConnection } from "./connections";
import { keyShapeOk, mergeSettings, settingsOf } from "./wire";
import { COMBO_NAME, FREE_TIER, PATTERN, hasEnvKey, isCustomProvider, isProvider, memberCombo, parseModel, providerDef, providerIds } from "./providers";
import { customProviderRoutes } from "./custom-providers";
import { loadCombos } from "./route";
import type { AppEnv } from "./env";
import { finishLogin, oauthDef, oauthMissingEnv, pollLogin, startLogin } from "./oauth";
import type { Upstream } from "./proxy";
import { reportRoutes } from "./report";
import { basicChatRoutes } from "./basic-chat";
import { requestDetailRoutes } from "./request-details";
import { backupRoutes } from "./backup";
import { logRoutes } from "./logs";
import { mediaAdminRoutes } from "./media";
import { providerHeaderRoutes } from "./provider-headers";
import { poolExists, proxyPoolRoutes } from "./proxy-pools";
import { webToolAdminRoutes } from "./web-tools";
import { modelRoutes } from "./models-admin";
import { visionAdapterRoutes } from "./vision";
import { translatorRoutes } from "./translator";
import { getTokenSaver, mergeTokenSaver, saveTokenSaver } from "./settings";
import { TIMEOUTS_HINT, getTimeouts, mergeTimeouts, saveTimeouts } from "./timeouts";
import { STRATEGIES, configError, getComboSettings, isStrategy as isComboStrategy, mergeComboSettings, readConfig, resetCombo, saveComboSettings } from "./combo-strategy";
import { currentMonth, monthRange } from "./usage";
import { QUOTA_PROVIDERS, consumeResetCredit, codexResetCredits, fetchQuota, getHiddenRows, isQuotaProvider, quotaConnection, setHiddenRows } from "./quota";

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

type SystemRow = Parameters<typeof toSystem>[0];

const isCap = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
const isName = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 100;
const isApiKey = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 4096;
const isPriority = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 1000;
const NO_BOX = { error: "not_configured", hint: "set the CONNECTIONS_KEY secret: 32 random bytes, base64" } as const;

const TAKEN = "Combo name already exists";

/**
 * Why a combo's name or members are refused, or null. Members: up to 50 strings, each `provider/model`, `claude-*`,
 * or another existing combo (`combo/<name>` or its bare name); never the combo itself (`self` is its current name).
 */
function comboInputError(name: string, targets: unknown, combos: ReadonlyMap<string, unknown>, self: string | null): string | null {
  if (!COMBO_NAME.test(name)) return "name: letters, numbers, -, _ and . (at most 64)";
  if (!Array.isArray(targets) || targets.length > 50 || !targets.every((t) => typeof t === "string")) return "targets: a list of at most 50 models";
  for (const t of targets as string[]) {
    const nested = memberCombo(t, combos);
    if (nested !== null) {
      if (nested === name || nested === self) return `targets: ${t} is this combo`;
      if (!combos.has(nested)) return `targets: no combo named ${nested}`;
    } else if (parseModel(t)?.kind !== "target") return `targets: ${t} is not provider/model, claude-* or a combo`;
  }
  return null;
}

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

  basicChatRoutes(a, upstream);
  requestDetailRoutes(a);

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

  /**
   * Combos: `combo/<name>` (or the bare name) tries `targets` in order. A member is `provider/model`, `claude-*`,
   * `combo/<name>` or the bare name of another combo; a combo may be empty (calling it is a 400, FR-CMB-31).
   */
  a.get("/combos", async (c) => {
    const r = await c.env.DB.prepare("SELECT name, targets, updated_at, strategy, config FROM combo ORDER BY name").all<{ name: string; targets: string; updated_at: number; strategy: string | null; config: string | null }>();
    return c.json(
      r.results.map((x) => ({
        name: x.name,
        targets: JSON.parse(x.targets) as string[],
        updated_at: x.updated_at,
        strategy: isComboStrategy(x.strategy) ? x.strategy : null,
        config: x.config ? readConfig(x.config) : null,
      })),
    );
  });

  /**
   * A combo's strategy and its settings from a POST/PUT body. `strategy` absent keeps the stored one; null follows
   * the gateway-wide setting; "fallback" drops the combo's settings (FR-CMB-26).
   */
  const strategyInput = (b: Record<string, unknown>, current: { strategy: string | null; config: string | null }) => {
    if ("strategy" in b && b.strategy !== null && !isComboStrategy(b.strategy)) return { error: `strategy: one of ${STRATEGIES.join(", ")}, or null` };
    const bad = "config" in b ? configError(b.config) : null;
    if (bad) return { error: bad };
    const strategy = "strategy" in b ? ((b.strategy as string | null) ?? null) : current.strategy;
    let config = "config" in b ? (b.config === null || b.config === undefined ? null : JSON.stringify(b.config)) : current.config;
    if (strategy === "fallback") config = null;
    return { strategy, config };
  };

  /** Creates a combo; a name already taken is `400 "Combo name already exists"` (FR-CMB-02). */
  a.post("/combos", async (c) => {
    const b = await readJson(c.req.raw);
    const name = typeof b?.name === "string" ? b.name : "";
    const combos = await loadCombos(c.env.DB);
    if (combos.has(name)) return c.json({ error: TAKEN }, 400);
    const bad = comboInputError(name, b?.targets, combos, null);
    if (bad) return c.json({ error: "invalid_input", hint: bad }, 400);
    const st = strategyInput(b!, { strategy: null, config: null });
    if ("error" in st) return c.json({ error: "invalid_input", hint: st.error }, 400);
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare("INSERT INTO combo (name, targets, updated_at, strategy, config) VALUES (?, ?, ?, ?, ?)").bind(name, JSON.stringify(b!.targets), now, st.strategy, st.config).run();
    return c.json({ name, targets: b!.targets, updated_at: now, strategy: st.strategy, config: st.config ? readConfig(st.config) : null }, 201);
  });

  /** Replaces a combo's members (creating it when missing). `name` in the body renames it; members of other combos follow. */
  a.put("/combos/:name", async (c) => {
    const old = c.req.param("name");
    const b = await readJson(c.req.raw);
    const name = typeof b?.name === "string" ? b.name : old;
    const combos = await loadCombos(c.env.DB);
    if (name !== old && combos.has(name)) return c.json({ error: TAKEN }, 400);
    const bad = comboInputError(name, b?.targets, combos, old);
    if (bad) return c.json({ error: "invalid_input", hint: bad }, 400);
    const targets = b!.targets as string[];
    const current = (await c.env.DB.prepare("SELECT strategy, config FROM combo WHERE name = ?").bind(old).first<{ strategy: string | null; config: string | null }>()) ?? { strategy: null, config: null };
    const st = strategyInput(b!, current);
    if ("error" in st) return c.json({ error: "invalid_input", hint: st.error }, 400);
    const now = Math.floor(Date.now() / 1000);
    // An edited combo starts its rotation and its sessions afresh (FR-CMB-11).
    resetCombo(old);
    resetCombo(name);
    if (name === old || !combos.has(old)) {
      await c.env.DB.prepare(
        "INSERT INTO combo (name, targets, updated_at, strategy, config) VALUES (?, ?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET targets = excluded.targets, updated_at = excluded.updated_at, strategy = excluded.strategy, config = excluded.config",
      )
        .bind(name, JSON.stringify(targets), now, st.strategy, st.config)
        .run();
    } else {
      const renames = [...combos]
        .filter(([n, ms]) => n !== old && ms.some((m) => memberCombo(m, combos) === old))
        .map(([n, ms]) =>
          c.env.DB.prepare("UPDATE combo SET targets = ? WHERE name = ?").bind(JSON.stringify(ms.map((m) => (memberCombo(m, combos) === old ? (m.startsWith("combo/") ? `combo/${name}` : name) : m))), n),
        );
      await c.env.DB.batch([c.env.DB.prepare("UPDATE combo SET name = ?, targets = ?, updated_at = ?, strategy = ?, config = ? WHERE name = ?").bind(name, JSON.stringify(targets), now, st.strategy, st.config, old), ...renames]);
    }
    return c.json({ name, targets, updated_at: now, strategy: st.strategy, config: st.config ? readConfig(st.config) : null });
  });

  a.delete("/combos/:name", async (c) => {
    const r = await c.env.DB.prepare("DELETE FROM combo WHERE name = ?").bind(c.req.param("name")).run();
    if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
    resetCombo(c.req.param("name"));
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
      providerIds().map((id) => {
        const def = providerDef(id);
        const base = { id, name: def.name, format: def.format, auth: [def.auth ?? "api_key"], env_key: hasEnvKey(c.env, id), key_url: def.keyUrl ?? null, strategy: strategy.get(id) ?? "fill-first", color: def.color, mark: def.mark, free_tier: FREE_TIER.has(id) };
        // A provider whose connections carry settings (wire.ts) lists their names and rules, never values.
        const settings = settingsOf(id);
        const row = settings ? { ...base, settings } : base;
        // A subscription login whose client comes from variables (Google) names the unset ones, never values.
        const missing = oauthMissingEnv(c.env, id);
        if (missing.length) Object.assign(row, { missing_env: missing });
        // The owner's providers (custom-providers.ts) also say where they point.
        return isCustomProvider(id) ? { ...row, custom: true, base_url: def.baseUrl ?? null } : row;
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
   * Subscription login (oauth.ts). `start` answers, by the provider's flow, the sign-in page to open (`pkce`) or
   * the code for the user to enter (`device`). `finish` (pkce) takes what the provider sent the browser back with:
   * the whole address (`callback_url`), its `code` and `state`, or the `code#state` the provider's page shows.
   * `poll` (device) answers 202 while the user has not entered the code yet, 201 with the connection once done.
   */
  a.post("/oauth/:provider/start", async (c) => {
    const r = await startLogin(c.env, upstream, c.req.param("provider"));
    if (r.ok) {
      if (r.flow === "pkce") return c.json({ flow: "pkce", authorize_url: r.url });
      const { ok: _ok, ...device } = r;
      return c.json(device);
    }
    if (r.error === "provider_refused") return c.json({ error: r.error, message: r.message }, 502);
    if (r.error === "unavailable") return c.json({ error: r.error, message: r.message }, 503);
    return r.error === "not_configured" ? c.json(NO_BOX, 500) : c.json({ error: "not_found" }, 404);
  });

  a.post("/oauth/:provider/poll", async (c) => {
    const provider = c.req.param("provider");
    if (oauthDef(provider)?.flow !== "device") return c.json({ error: "not_found" }, 404);
    const b = await readJson(c.req.raw);
    if (typeof b?.id !== "string" || b.id === "") return c.json({ error: "invalid_input", hint: "id: the sign-in's id from start" }, 400);
    const r = await pollLogin(c.env, upstream, provider, b.id);
    if (r.ok === "pending") return c.json({ status: "pending", interval: r.interval }, 202);
    if (!r.ok) return c.json({ error: r.error, message: r.message }, r.status);
    return c.json(await getConnection(c.env.DB, r.id), 201);
  });

  a.post("/oauth/:provider/finish", async (c) => {
    const provider = c.req.param("provider");
    if (oauthDef(provider)?.flow !== "pkce") return c.json({ error: "not_found" }, 404);
    const b = await readJson(c.req.raw);
    let code: unknown = b?.code;
    let state: unknown = b?.state;
    if (typeof b?.callback_url === "string") {
      try {
        const u = new URL(b.callback_url);
        code = u.searchParams.get("code");
        state = u.searchParams.get("state");
      } catch {
        // Not an address: the `code#state` some providers' pages show (Claude) is read below.
        code = b.callback_url.trim();
      }
    }
    // Claude's page shows the code as `code#state`.
    if (typeof code === "string" && code.includes("#") && (typeof state !== "string" || state === "")) {
      [code, state] = [code.slice(0, code.indexOf("#")), code.slice(code.indexOf("#") + 1)];
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

  /**
   * Quota (FR-QUO): the connections whose provider reports what is left, then one report per connection. The
   * console turns accounts off and on with PATCH /connections/:id; nothing here changes a connection.
   */
  a.get("/quota", async (c) => {
    const connections = (await listConnections(c.env.DB)).filter((x) => isQuotaProvider(x.provider));
    return c.json({ providers: QUOTA_PROVIDERS, connections, hidden: await getHiddenRows(c.env.DB) });
  });

  /** Rows the owner hid, per provider: `{provider, names}`; an empty list shows them all again. */
  a.put("/quota/hidden", async (c) => {
    const b = await readJson(c.req.raw);
    const next = await setHiddenRows(c.env.DB, b?.provider, b?.names);
    return next ? c.json(next) : c.json({ error: "invalid_input", hint: "provider: codex, groq or deepseek; names: up to 50 row names" }, 400);
  });

  a.get("/quota/:id", async (c) => {
    const conn = await quotaConnection(c.env, upstream, c.req.param("id"));
    return conn ? c.json(await fetchQuota(c.env, upstream, conn)) : c.json({ error: "not_found" }, 404);
  });

  a.get("/quota/:id/reset-credits", async (c) => {
    const conn = await quotaConnection(c.env, upstream, c.req.param("id"));
    if (!conn || conn.provider !== "codex") return c.json({ error: "not_found" }, 404);
    const r = await codexResetCredits(c.env, upstream, conn);
    return "credits" in r ? c.json(r) : c.json({ error: "upstream_error", message: r.message }, 502);
  });

  /** Spends one Codex reset credit: the account's windows start again. 409 when none is left. */
  a.post("/quota/:id/reset-credit", async (c) => {
    const conn = await quotaConnection(c.env, upstream, c.req.param("id"));
    if (!conn || conn.provider !== "codex") return c.json({ error: "not_found" }, 404);
    const r = await consumeResetCredit(c.env, upstream, conn);
    if ("windows_reset" in r) return c.json(r);
    if ("error" in r) return c.json(r, 409);
    return c.json({ error: "upstream_error", message: r.message }, 502);
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
    if ("priority" in b && b.priority !== null && !isPriority(b.priority)) return c.json({ error: "invalid_input", field: "priority" }, 400);
    if ("proxy_pool" in b && b.proxy_pool !== null && (typeof b.proxy_pool !== "string" || !(await poolExists(c.env.DB, b.proxy_pool)))) {
      return c.json({ error: "invalid_input", field: "proxy_pool" }, 400);
    }
    if (!keyShapeOk(b.provider, b.api_key.trim())) return c.json({ error: "invalid_input", field: "api_key" }, 400);
    const merged = mergeSettings(b.provider, b.settings);
    if (!merged.ok) return c.json({ error: "invalid_input", field: merged.field }, 400);
    const created = await createApiKeyConnection(c.env, b.provider, b.name.trim(), b.api_key.trim(), {
      priority: (b.priority as number | null | undefined) ?? null,
      proxyPool: (b.proxy_pool as string | null | undefined) ?? null,
      settings: merged.settings,
    });
    if (!created) return c.json(NO_BOX, 500);
    return c.json(created, 201);
  });
  /** The console's Check button: asks the provider with a key that is not stored. The answer never has the key. */
  a.post("/connections/check", async (c) => {
    const b = await readJson(c.req.raw);
    if (!b || typeof b.provider !== "string" || !isProvider(b.provider) || !isApiKey(b.api_key) || providerDef(b.provider).auth === "oauth") {
      return c.json({ error: "invalid_input", hint: "provider: a known API-key provider id, api_key: the provider's key" }, 400);
    }
    if (!keyShapeOk(b.provider, b.api_key.trim())) return c.json({ error: "invalid_input", field: "api_key" }, 400);
    const merged = mergeSettings(b.provider, b.settings);
    if (!merged.ok) return c.json({ error: "invalid_input", field: merged.field }, 400);
    return c.json(await checkKey(c.env, upstream, b.provider, b.api_key.trim(), merged.settings));
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
      if (!isPriority(b.priority)) return c.json({ error: "invalid_input", field: "priority" }, 400);
      sets.push("priority = ?");
      args.push(b.priority);
    }
    if ("proxy_pool" in b) {
      if (b.proxy_pool !== null && (typeof b.proxy_pool !== "string" || !(await poolExists(c.env.DB, b.proxy_pool)))) return c.json({ error: "invalid_input", field: "proxy_pool" }, 400);
      sets.push("proxy_pool = ?");
      args.push(b.proxy_pool);
    }
    if ("api_key" in b || "settings" in b) {
      if (cur.auth_type !== "api_key") return c.json({ error: "invalid_input", field: "api_key" in b ? "api_key" : "settings" }, 400);
      if ("api_key" in b && (!isApiKey(b.api_key) || !keyShapeOk(cur.provider, b.api_key.trim()))) return c.json({ error: "invalid_input", field: "api_key" }, 400);
      // The key and the settings are sealed together: a new key keeps the settings, new settings keep the key.
      const stored = await storedSecret(c.env, id);
      if (!stored) return c.json(NO_BOX, 500);
      const merged = mergeSettings(cur.provider, b.settings, stored.settings);
      if (!merged.ok) return c.json({ error: "invalid_input", field: merged.field }, 400);
      const sealed = await sealApiKey(c.env, "api_key" in b ? (b.api_key as string).trim() : stored.apiKey, merged.settings);
      if (!sealed) return c.json(NO_BOX, 500);
      sets.push("secret = ?", "hint = ?");
      args.push(sealed.secret, sealed.hint);
      // A new key starts clean: what the old key was refused or limited for no longer holds.
      if ("api_key" in b) sets.push("cooldown_until = 0", "backoff_level = 0", "last_error = NULL", "last_error_at = NULL");
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
  logRoutes(a);
  proxyPoolRoutes(a, upstream);
  backupRoutes(a);
  providerHeaderRoutes(a);
  webToolAdminRoutes(a, upstream);
  mediaAdminRoutes(a);
  a.get("/settings/info", (c) => {
    const e = c.env;
    const set = (v: string | undefined) => typeof v === "string" && v.trim() !== "";
    return c.json({
      admin_token: set(e.ADMIN_TOKEN_SHA256),
      oidc: set(e.OIDC_ISSUER) && set(e.OIDC_CLIENT_ID) && set(e.OIDC_CLIENT_SECRET),
      console_emails: (e.CONSOLE_EMAILS ?? "").split(",").filter((x) => x.trim() !== "").length,
      connections_key: set(e.CONNECTIONS_KEY),
      codex_relay: set(e.CODEX_RELAY_URL) && set(e.CODEX_RELAY_SECRET),
    });
  });
  modelRoutes(a, upstream);
  customProviderRoutes(a);
  visionAdapterRoutes(a);
  translatorRoutes(a);

  /** The strategy of a combo without its own, and how many requests round robin keeps a model (combo-strategy.ts). */
  a.get("/combo-settings", async (c) => c.json(await getComboSettings(c.env.DB)));

  a.put("/combo-settings", async (c) => {
    const b = await readJson(c.req.raw);
    const next = b ? mergeComboSettings(await getComboSettings(c.env.DB), b) : null;
    if (!next) return c.json({ error: "invalid_input", hint: `strategy: one of ${STRATEGIES.join(", ")}; sticky_limit: 1 to 1000` }, 400);
    await saveComboSettings(c.env.DB, next);
    return c.json(next);
  });

  /** How long the gateway waits for a provider (timeouts.ts). PUT takes either limit and keeps the other. */
  a.get("/timeouts", async (c) => c.json(await getTimeouts(c.env.DB)));

  a.put("/timeouts", async (c) => {
    const b = await readJson(c.req.raw);
    const next = b ? mergeTimeouts(await getTimeouts(c.env.DB), b) : null;
    if (!next) return c.json({ error: "invalid_input", hint: TIMEOUTS_HINT }, 400);
    await saveTimeouts(c.env.DB, next);
    return c.json(next);
  });

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
