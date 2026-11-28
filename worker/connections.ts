import type { Env } from "./env";
import { exhaustedUntil, shareLeft, type Limits } from "./limits";
import { ANTHROPIC_VERSION, anthropicBase, isProvider, providerDef, providerKey, type ProviderId } from "./providers";
import { oauthToken } from "./oauth";
import { open, seal } from "./secret-box";
import { checkRequest } from "./wire";
import { errorBody } from "./errors";

/**
 * Provider accounts managed from the console:
 * several per provider, tried in priority order. An account that answers 429, 5xx or refuses its key is set
 * aside for a while and the next one is tried. The key in the environment (ANTHROPIC_KEYS, PROVIDER_KEYS),
 * when there is one, comes after the available accounts.
 */

export type AuthType = "api_key" | "oauth";

export interface Connection {
  id: string;
  provider: string;
  auth_type: AuthType;
  name: string;
  /** Last 4 characters of an API key. */
  hint: string | null;
  /** The provider's id of the account an OAuth connection signed in as. */
  account: string | null;
  expires_at: number | null;
  priority: number;
  disabled: boolean;
  /** The relay pool (proxy-pools.ts) a Codex account sends through; null: CODEX_RELAY_URL. */
  proxy_pool: string | null;
  cooldown_until: number;
  last_error: string | null;
  last_error_at: number | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

type ConnectionRow = Omit<Connection, "disabled"> & { disabled: number };

/** Everything but `secret` and `backoff_level`: what the console may see. */
export const CONNECTION_COLUMNS =
  "id, provider, auth_type, name, hint, account, expires_at, priority, disabled, proxy_pool, cooldown_until, last_error, last_error_at, last_used_at, created_at, updated_at";

export const toConnection = (r: ConnectionRow): Connection => ({ ...r, disabled: r.disabled === 1 });

export async function listConnections(db: D1Database): Promise<Connection[]> {
  const r = await db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM connection ORDER BY provider, priority, created_at`).all<ConnectionRow>();
  return r.results.map(toConnection);
}

export async function getConnection(db: D1Database, id: string): Promise<Connection | null> {
  const row = await db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM connection WHERE id = ?`).bind(id).first<ConnectionRow>();
  return row ? toConnection(row) : null;
}

/** The last 4 characters, only for keys long enough that this gives nothing away (none for a JSON key file). */
const hintOf = (apiKey: string) => (apiKey.length >= 12 && !apiKey.trimStart().startsWith("{") ? apiKey.slice(-4) : null);

/**
 * Sealed `{"api_key": ..., "settings": {...}}` and its hint; null while CONNECTIONS_KEY is unset. The settings
 * (worker/wire.ts: an Azure endpoint, an AWS region...) are sealed with the key and never returned by the API.
 */
export async function sealApiKey(env: Env, apiKey: string, settings?: Record<string, string>): Promise<{ secret: string; hint: string | null } | null> {
  const has = settings && Object.keys(settings).length > 0;
  const secret = await seal(env, JSON.stringify(has ? { api_key: apiKey, settings } : { api_key: apiKey }));
  return secret ? { secret, hint: hintOf(apiKey) } : null;
}

/** `priority` null: after the provider's last account. */
export async function createApiKeyConnection(
  env: Env,
  provider: ProviderId,
  name: string,
  apiKey: string,
  opts: { priority?: number | null; proxyPool?: string | null; settings?: Record<string, string> } = {},
): Promise<Connection | null> {
  const sealed = await sealApiKey(env, apiKey, opts.settings);
  if (!sealed) return null;
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO connection (id, provider, auth_type, name, secret, hint, priority, proxy_pool, created_at, updated_at)
     VALUES (?, ?, 'api_key', ?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(priority), 0) + 1 FROM connection WHERE provider = ?)), ?, ?, ?)`,
  )
    .bind(id, provider, name, sealed.secret, sealed.hint, opts.priority ?? null, provider, opts.proxyPool ?? null, now, now)
    .run();
  return getConnection(env.DB, id);
}

/** The API key and settings inside a sealed secret; null when it cannot be opened (CONNECTIONS_KEY changed) or holds no key. */
export async function secretOf(env: Env, secret: string): Promise<{ apiKey: string; settings: Record<string, string> } | null> {
  const plain = await open(env, secret);
  if (plain === null) return null;
  try {
    const v = JSON.parse(plain) as { api_key?: unknown; settings?: unknown };
    if (typeof v.api_key !== "string" || v.api_key === "") return null;
    const settings: Record<string, string> = {};
    if (v.settings && typeof v.settings === "object") for (const [k, s] of Object.entries(v.settings)) if (typeof s === "string") settings[k] = s;
    return { apiKey: v.api_key, settings };
  } catch {
    return null;
  }
}

/** The API key inside a sealed secret; null when it cannot be opened (CONNECTIONS_KEY changed) or holds none. */
const apiKeyOf = async (env: Env, secret: string): Promise<string | null> => (await secretOf(env, secret))?.apiKey ?? null;

/** An API-key connection's stored key and settings (for a change that keeps one of them); null: none, or unreadable. */
export async function storedSecret(env: Env, id: string): Promise<{ apiKey: string; settings: Record<string, string> } | null> {
  const row = await env.DB.prepare("SELECT secret FROM connection WHERE id = ? AND auth_type = 'api_key'").bind(id).first<{ secret: string }>();
  return row ? secretOf(env, row.secret) : null;
}

export type Strategy = "fill-first" | "round-robin" | "quota-left";
export const isStrategy = (v: unknown): v is Strategy => v === "fill-first" || v === "round-robin" || v === "quota-left";

/** One way to reach a provider: an account from the console, or the key in the environment (`connection` null). */
export interface Candidate {
  connection: string | null;
  backoffLevel: number;
  /** The provider's account id of an OAuth connection (Codex sends it as a header). */
  account: string | null;
  /** The relay pool a Codex account sends through (proxy-pools.ts); null: CODEX_RELAY_URL. */
  proxyPool: string | null;
  /**
   * The key or access token to send. Null: the secret cannot be opened (CONNECTIONS_KEY changed), skip it.
   * `{error}`: an OAuth connection with no usable token: 401, the provider refused to renew it (the user has to
   * sign in again); 502, the sign-in service is unavailable. `force`: renew an OAuth token even when it looks
   * valid (the provider just refused it).
   */
  key: (force?: boolean) => Promise<string | { error: string; status: number } | null>;
  /** The connection's settings (worker/wire.ts); none for the key in the environment. */
  settings?: () => Promise<Record<string, string>>;
}

/**
 * The accounts to try for `provider`, in order: available ones, then the key in the environment, then the ones
 * set aside (soonest back first), so a request is still attempted when nothing else is left. Available ones go by
 * priority ("fill-first", the default), by the one that answered longest ago ("round-robin"), or by the largest
 * share of its limit left ("quota-left").
 *
 * An account is set aside while it cools down after a failure, and, when `model` is given, while the provider's
 * own headers said it is out for that model (limits.ts): it is then not asked until its reset.
 */
export async function candidatesFor(env: Env, provider: ProviderId, systemId: string, now: number, upstream?: (req: Request) => Promise<Response>, model?: string): Promise<Candidate[]> {
  const r = await env.DB.prepare(
    `SELECT c.id, c.secret, c.auth_type, c.account, c.proxy_pool, c.expires_at, c.cooldown_until, c.backoff_level, c.rr_at,
            (SELECT strategy FROM provider_setting WHERE provider = ?1) AS strategy,
            l.requests_limit, l.requests_remaining, l.requests_reset_at, l.tokens_limit, l.tokens_remaining, l.tokens_reset_at
     FROM connection c LEFT JOIN connection_limit l ON l.connection = c.id AND l.model = ?2
     WHERE c.provider = ?1 AND c.disabled = 0 ORDER BY c.priority, c.created_at`,
  )
    .bind(provider, model ?? "")
    .all<
      { id: string; secret: string; auth_type: string; account: string | null; proxy_pool: string | null; expires_at: number | null; cooldown_until: number; backoff_level: number; rr_at: number; strategy: string | null } & Limits
    >();
  // No row in connection_limit: every column is null, which reads as "never heard from".
  const limitsOf = (x: (typeof r.results)[number]): Limits | null => (x.requests_limit === null && x.tokens_limit === null ? null : x);
  /** Back at this time (unix seconds); at or before `now`: available. */
  const asideUntil = (x: (typeof r.results)[number]) => Math.max(x.cooldown_until, exhaustedUntil(limitsOf(x), now));
  const account = (row: (typeof r.results)[number]): Candidate => ({
    connection: row.id,
    backoffLevel: row.backoff_level,
    account: row.account,
    proxyPool: row.proxy_pool,
    key: async (force = false) => {
      if (row.auth_type !== "oauth") return apiKeyOf(env, row.secret);
      if (!upstream) return null;
      const t = await oauthToken(env, upstream, { id: row.id, provider, secret: row.secret, expires_at: row.expires_at }, now, force);
      return t === null ? null : "token" in t ? t.token : t;
    },
    settings: async () => (row.auth_type === "oauth" ? {} : ((await secretOf(env, row.secret))?.settings ?? {})),
  });
  const free = r.results.filter((x) => asideUntil(x) <= now);
  // Array.sort is stable: connections that tie keep their priority order.
  const strategy = r.results[0]?.strategy;
  if (strategy === "round-robin") free.sort((a, b) => a.rr_at - b.rr_at);
  else if (strategy === "quota-left") free.sort((a, b) => shareLeft(limitsOf(b), now) - shareLeft(limitsOf(a), now));
  const cooling = r.results.filter((x) => asideUntil(x) > now).sort((a, b) => asideUntil(a) - asideUntil(b));
  // A subscription provider is reached through its sign-ins only: a key in the environment is not one of them.
  // A media-only provider (media-providers/registry.ts) is not in PROVIDERS: its key in the environment is read the same way.
  const envKey = isProvider(provider) && providerDef(provider).auth === "oauth" ? null : providerKey(env, provider, systemId);
  const fromEnv: Candidate[] = envKey ? [{ connection: null, backoffLevel: 0, account: null, proxyPool: null, key: () => Promise.resolve(envKey) }] : [];
  return [...free.map(account), ...fromEnv, ...cooling.map(account)];
}

/** A failure another account may not share: rate limit, provider trouble, or this account's key being refused. */
export const accountFailure = (status: number) => status === 401 || status === 403 || status === 429 || status >= 500;

const BASE_COOLDOWN_S = 30;
const MAX_COOLDOWN_S = 600;

/** The provider's retry-after when it gave one, else 30 s doubling with each failure in a row; at most 10 min. */
export function cooldownSeconds(backoffLevel: number, retryAfter: number | null): number {
  return Math.min(MAX_COOLDOWN_S, retryAfter ?? BASE_COOLDOWN_S * 2 ** Math.min(backoffLevel, 10));
}

/** Sets an account aside after a failure. The key in the environment (`connection` null) keeps no state. */
export async function noteFailure(db: D1Database, cand: Candidate, status: number, message: string, retryAfter: number | null, now: number): Promise<void> {
  if (cand.connection === null) return;
  await db
    .prepare("UPDATE connection SET cooldown_until = ?, backoff_level = backoff_level + 1, last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?")
    .bind(now + cooldownSeconds(cand.backoffLevel, retryAfter), `${status} ${message}`.slice(0, 300), now, now, cand.connection)
    .run();
}

export async function noteSuccess(db: D1Database, cand: Candidate, now: number): Promise<void> {
  if (cand.connection === null) return;
  await db
    .prepare("UPDATE connection SET cooldown_until = 0, backoff_level = 0, last_error = NULL, last_error_at = NULL, last_used_at = ?, rr_at = ? WHERE id = ?")
    .bind(now, Date.now(), cand.connection)
    .run();
}

export type TestResult = { ok: true } | { ok: false; status: number; message: string };

/**
 * Checks a connection's key by asking the provider for its model list (no tokens spent). A good answer clears
 * the connection's failure state; a bad one is written as its last error, without setting the connection aside.
 * Null: no such connection.
 */
export async function testConnection(env: Env, upstream: (req: Request) => Promise<Response>, id: string): Promise<TestResult | null> {
  const row = await env.DB.prepare("SELECT provider, secret, auth_type, expires_at FROM connection WHERE id = ?")
    .bind(id)
    .first<{ provider: string; secret: string; auth_type: string; expires_at: number | null }>();
  if (!row || !isProvider(row.provider)) return null;
  const now = Math.floor(Date.now() / 1000);
  const fail = async (status: number, message: string): Promise<TestResult> => {
    await env.DB.prepare("UPDATE connection SET last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?")
      .bind(`${status} ${message}`.slice(0, 300), now, now, id)
      .run();
    return { ok: false, status, message };
  };
  if (row.auth_type === "oauth") {
    // A subscription login is usable when the provider renews its token: always renewed here, no model call.
    const t = await oauthToken(env, upstream, { id, provider: row.provider, secret: row.secret, expires_at: row.expires_at }, now, true);
    if (t === null) return fail(0, "the stored tokens cannot be opened (CONNECTIONS_KEY changed)");
    if (!("token" in t)) return fail(t.status, t.error);
    // Only a renewal clears the failure; the old token still working says nothing about the account.
    if (t.unavailable !== undefined) return fail(502, `the sign-in service is unavailable: ${t.unavailable}`);
    await env.DB.prepare("UPDATE connection SET cooldown_until = 0, backoff_level = 0, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ?").bind(now, id).run();
    return { ok: true };
  }
  const stored = await secretOf(env, row.secret);
  if (!stored) return fail(0, "the stored key cannot be opened (CONNECTIONS_KEY changed)");
  const r = await checkKey(env, upstream, row.provider, stored.apiKey, stored.settings);
  if (!r.ok) return fail(r.status, r.message);
  await env.DB.prepare("UPDATE connection SET cooldown_until = 0, backoff_level = 0, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
  return { ok: true };
}

/** Asks the provider for its model list with `key` (no tokens spent). Stores nothing; the console's Check button. */
export async function checkKey(env: Env, upstream: (req: Request) => Promise<Response>, provider: ProviderId, key: string, settings: Record<string, string> = {}): Promise<TestResult> {
  const def = providerDef(provider);
  let up: Response;
  try {
    // Providers reached through worker/wire.ts check with their own request (or, for Vertex, a token exchange).
    const own = await checkRequest(upstream, provider, key, settings);
    if (own && !(own instanceof Request)) return own.ok ? { ok: true } : { ok: false, status: own.status, message: own.message.split(key).join("***") };
    const req =
      own ??
      (def.format === "anthropic"
        ? new Request(anthropicBase(env, provider) + "/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION } })
        : new Request(def.modelsUrl ?? `${def.baseUrl}/models`, { headers: { ...def.headers, authorization: `Bearer ${key}` } }));
    up = await upstream(req);
  } catch {
    return { ok: false, status: 502, message: `could not reach ${provider}` };
  }
  if (up.ok) return { ok: true };
  const body = errorBody(await up.json().catch(() => null)) as { error?: { message?: unknown } | string; message?: unknown } | null;
  const e = body?.error;
  const message = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : typeof body?.message === "string" ? body.message : `upstream error ${up.status}`;
  // A provider that echoes the key back in its error must not get it into an answer.
  return { ok: false, status: up.status, message: message.split(key).join("***") };
}

/** A console connection with a way to get its key or access token, for calls the gateway makes on its own (quota). */
export interface ConnectionAccess {
  id: string;
  provider: string;
  authType: AuthType;
  account: string | null;
  proxyPool: string | null;
  /** Same contract as Candidate.key. */
  key: (force?: boolean) => Promise<string | { error: string; status: number } | null>;
  /** An OAuth connection's long-lived token (GitHub's own token behind a Copilot one); null when there is none or it cannot be opened. */
  refreshToken: () => Promise<string | null>;
}

export async function connectionAccess(env: Env, upstream: (req: Request) => Promise<Response>, id: string): Promise<ConnectionAccess | null> {
  const row = await env.DB.prepare("SELECT id, provider, auth_type, account, proxy_pool, secret, expires_at FROM connection WHERE id = ?")
    .bind(id)
    .first<{ id: string; provider: string; auth_type: AuthType; account: string | null; proxy_pool: string | null; secret: string; expires_at: number | null }>();
  if (!row) return null;
  const key = async (force = false) => {
    if (row.auth_type !== "oauth") return apiKeyOf(env, row.secret);
    // Re-read: a renewal stores new tokens, and a second call must open those.
    const cur = await env.DB.prepare("SELECT secret, expires_at FROM connection WHERE id = ?").bind(id).first<{ secret: string; expires_at: number | null }>();
    if (!cur) return null;
    const t = await oauthToken(env, upstream, { id, provider: row.provider, secret: cur.secret, expires_at: cur.expires_at }, Math.floor(Date.now() / 1000), force);
    return t === null ? null : "token" in t ? t.token : t;
  };
  const refreshToken = async () => {
    const cur = await env.DB.prepare("SELECT secret FROM connection WHERE id = ?").bind(id).first<{ secret: string }>();
    const plain = cur ? await open(env, cur.secret) : null;
    if (plain === null) return null;
    try {
      const v = JSON.parse(plain) as { refresh_token?: unknown };
      return typeof v.refresh_token === "string" && v.refresh_token !== "" ? v.refresh_token : null;
    } catch {
      return null;
    }
  };
  return { id: row.id, provider: row.provider, authType: row.auth_type, account: row.account, proxyPool: row.proxy_pool, key, refreshToken };
}
