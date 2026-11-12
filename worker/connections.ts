import type { Env } from "./env";
import { ANTHROPIC_VERSION, isProvider, providerDef, providerKey, type ProviderId } from "./providers";
import { oauthToken } from "./oauth";
import { open, seal } from "./secret-box";

/**
 * Provider accounts managed from the console (the idea of 9router's provider connections, written anew):
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
  "id, provider, auth_type, name, hint, account, expires_at, priority, disabled, cooldown_until, last_error, last_error_at, last_used_at, created_at, updated_at";

export const toConnection = (r: ConnectionRow): Connection => ({ ...r, disabled: r.disabled === 1 });

export async function listConnections(db: D1Database): Promise<Connection[]> {
  const r = await db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM connection ORDER BY provider, priority, created_at`).all<ConnectionRow>();
  return r.results.map(toConnection);
}

export async function getConnection(db: D1Database, id: string): Promise<Connection | null> {
  const row = await db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM connection WHERE id = ?`).bind(id).first<ConnectionRow>();
  return row ? toConnection(row) : null;
}

/** The last 4 characters, only for keys long enough that this gives nothing away. */
const hintOf = (apiKey: string) => (apiKey.length >= 12 ? apiKey.slice(-4) : null);

/** Sealed `{"api_key": ...}` and its hint; null while CONNECTIONS_KEY is unset. */
export async function sealApiKey(env: Env, apiKey: string): Promise<{ secret: string; hint: string | null } | null> {
  const secret = await seal(env, JSON.stringify({ api_key: apiKey }));
  return secret ? { secret, hint: hintOf(apiKey) } : null;
}

export async function createApiKeyConnection(env: Env, provider: ProviderId, name: string, apiKey: string): Promise<Connection | null> {
  const sealed = await sealApiKey(env, apiKey);
  if (!sealed) return null;
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO connection (id, provider, auth_type, name, secret, hint, priority, created_at, updated_at)
     VALUES (?, ?, 'api_key', ?, ?, ?, (SELECT COALESCE(MAX(priority), 0) + 1 FROM connection WHERE provider = ?), ?, ?)`,
  )
    .bind(id, provider, name, sealed.secret, sealed.hint, provider, now, now)
    .run();
  return getConnection(env.DB, id);
}

/** The API key inside a sealed secret; null when it cannot be opened (CONNECTIONS_KEY changed) or holds none. */
async function apiKeyOf(env: Env, secret: string): Promise<string | null> {
  const plain = await open(env, secret);
  if (plain === null) return null;
  try {
    const k = (JSON.parse(plain) as { api_key?: unknown }).api_key;
    return typeof k === "string" && k !== "" ? k : null;
  } catch {
    return null;
  }
}

export type Strategy = "fill-first" | "round-robin";
export const isStrategy = (v: unknown): v is Strategy => v === "fill-first" || v === "round-robin";

/** One way to reach a provider: an account from the console, or the key in the environment (`connection` null). */
export interface Candidate {
  connection: string | null;
  backoffLevel: number;
  /** The provider's account id of an OAuth connection (Codex sends it as a header). */
  account: string | null;
  /**
   * The key or access token to send. Null: the secret cannot be opened (CONNECTIONS_KEY changed), skip it.
   * `{error}`: an OAuth connection with no usable token: 401, the provider refused to renew it (the user has to
   * sign in again); 502, the sign-in service is unavailable. `force`: renew an OAuth token even when it looks
   * valid (the provider just refused it).
   */
  key: (force?: boolean) => Promise<string | { error: string; status: number } | null>;
}

/**
 * The accounts to try for `provider`, in order: available ones, then the key in the environment, then the ones
 * cooling down (soonest first), so a request is still attempted when nothing else is left. Available ones go by
 * priority ("fill-first", the default) or, with "round-robin", the one that answered longest ago first.
 */
export async function candidatesFor(env: Env, provider: ProviderId, systemId: string, now: number, upstream?: (req: Request) => Promise<Response>): Promise<Candidate[]> {
  const r = await env.DB.prepare(
    `SELECT id, secret, auth_type, account, expires_at, cooldown_until, backoff_level, rr_at,
            (SELECT strategy FROM provider_setting WHERE provider = ?1) AS strategy
     FROM connection WHERE provider = ?1 AND disabled = 0 ORDER BY priority, created_at`,
  )
    .bind(provider)
    .all<{ id: string; secret: string; auth_type: string; account: string | null; expires_at: number | null; cooldown_until: number; backoff_level: number; rr_at: number; strategy: string | null }>();
  const account = (row: (typeof r.results)[number]): Candidate => ({
    connection: row.id,
    backoffLevel: row.backoff_level,
    account: row.account,
    key: async (force = false) => {
      if (row.auth_type !== "oauth") return apiKeyOf(env, row.secret);
      if (!upstream) return null;
      const t = await oauthToken(env, upstream, { id: row.id, provider, secret: row.secret, expires_at: row.expires_at }, now, force);
      return t === null ? null : "token" in t ? t.token : t;
    },
  });
  const free = r.results.filter((x) => x.cooldown_until <= now);
  // Array.sort is stable: connections that answered at the same time keep their priority order.
  if (r.results[0]?.strategy === "round-robin") free.sort((a, b) => a.rr_at - b.rr_at);
  const cooling = r.results.filter((x) => x.cooldown_until > now).sort((a, b) => a.cooldown_until - b.cooldown_until);
  // A subscription provider is reached through its sign-ins only: a key in the environment is not one of them.
  const envKey = providerDef(provider).auth === "oauth" ? null : providerKey(env, provider, systemId);
  const fromEnv: Candidate[] = envKey ? [{ connection: null, backoffLevel: 0, account: null, key: () => Promise.resolve(envKey) }] : [];
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
  const key = await apiKeyOf(env, row.secret);
  if (!key) return fail(0, "the stored key cannot be opened (CONNECTIONS_KEY changed)");
  const def = providerDef(row.provider);
  const req =
    def.format === "anthropic"
      ? new Request(env.ANTHROPIC_BASE_URL.replace(/\/+$/, "") + "/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION } })
      : new Request(def.modelsUrl ?? `${def.baseUrl}/models`, { headers: { authorization: `Bearer ${key}` } });
  let up: Response;
  try {
    up = await upstream(req);
  } catch {
    return fail(502, `could not reach ${row.provider}`);
  }
  if (up.ok) {
    await env.DB.prepare("UPDATE connection SET cooldown_until = 0, backoff_level = 0, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ?")
      .bind(now, id)
      .run();
    return { ok: true };
  }
  const body = (await up.json().catch(() => null)) as { error?: { message?: unknown } | string; message?: unknown } | null;
  const e = body?.error;
  const message = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : typeof body?.message === "string" ? body.message : `upstream error ${up.status}`;
  return fail(up.status, message);
}
