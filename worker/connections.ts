import type { Env } from "./env";
import { providerKey, type ProviderId } from "./providers";
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
  "id, provider, auth_type, name, hint, expires_at, priority, disabled, cooldown_until, last_error, last_error_at, last_used_at, created_at, updated_at";

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

/** One way to reach a provider: an account from the console, or the key in the environment (`connection` null). */
export interface Candidate {
  connection: string | null;
  backoffLevel: number;
  /** The key to send. Null when the account's secret cannot be opened (CONNECTIONS_KEY changed): skip it. */
  key: () => Promise<string | null>;
}

/**
 * The accounts to try for `provider`, in order: available ones by priority, then the key in the environment,
 * then the ones cooling down (soonest first), so a request is still attempted when nothing else is left.
 */
export async function candidatesFor(env: Env, provider: ProviderId, systemId: string, now: number): Promise<Candidate[]> {
  const r = await env.DB.prepare(
    "SELECT id, secret, cooldown_until, backoff_level FROM connection WHERE provider = ? AND disabled = 0 ORDER BY priority, created_at",
  )
    .bind(provider)
    .all<{ id: string; secret: string; cooldown_until: number; backoff_level: number }>();
  const account = (row: (typeof r.results)[number]): Candidate => ({
    connection: row.id,
    backoffLevel: row.backoff_level,
    key: async () => {
      const plain = await open(env, row.secret);
      if (plain === null) return null;
      try {
        const k = (JSON.parse(plain) as { api_key?: unknown }).api_key;
        return typeof k === "string" && k !== "" ? k : null;
      } catch {
        return null;
      }
    },
  });
  const available = r.results.filter((x) => x.cooldown_until <= now).map(account);
  const cooling = r.results
    .filter((x) => x.cooldown_until > now)
    .sort((a, b) => a.cooldown_until - b.cooldown_until)
    .map(account);
  const envKey = providerKey(env, provider, systemId);
  const fromEnv: Candidate[] = envKey ? [{ connection: null, backoffLevel: 0, key: () => Promise.resolve(envKey) }] : [];
  return [...available, ...fromEnv, ...cooling];
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
    .prepare("UPDATE connection SET cooldown_until = 0, backoff_level = 0, last_error = NULL, last_error_at = NULL, last_used_at = ? WHERE id = ?")
    .bind(now, cand.connection)
    .run();
}
