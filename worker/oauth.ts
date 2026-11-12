import type { Env } from "./env";
import { open, seal } from "./secret-box";

/**
 * Subscription logins (the idea of 9router's OAuth providers, written anew). So far: Codex, which signs in to a
 * ChatGPT account the way the Codex CLI does: authorization code with PKCE at auth.openai.com, with the CLI's own
 * public client id and its fixed redirect `http://localhost:1455/auth/callback`.
 *
 * That redirect only reaches the gateway when it runs on the user's machine with port 1455 mapped to it. Anywhere
 * else the browser ends on a page that does not load, and the user pastes its address into the console instead.
 *
 * Using a ChatGPT subscription outside OpenAI's own apps may be against its terms; the account can be limited.
 */
export interface OAuthDef {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  redirectUri: string;
  extra: Record<string, string>;
  /** Refresh when the access token has less than this many seconds left. */
  refreshLeadS: number;
}

export const OAUTH: Record<string, OAuthDef> = {
  codex: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    redirectUri: "http://localhost:1455/auth/callback",
    extra: { id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs" },
    refreshLeadS: 600,
  },
};

const PENDING_TTL_S = 600;
type Fetch = (req: Request) => Promise<Response>;

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const random = (n: number) => base64Url(crypto.getRandomValues(new Uint8Array(n)));

/** The claims of a JWT, unverified: used only on tokens the provider's token endpoint just handed over TLS. */
function claims(jwt: unknown): Record<string, unknown> {
  if (typeof jwt !== "string") return {};
  try {
    const part = jwt.split(".")[1] ?? "";
    const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The page to send the browser to. Stores the PKCE verifier until the provider sends the browser back. */
export async function startLogin(env: Env, provider: string): Promise<string | null> {
  const def = OAUTH[provider];
  if (!def) return null;
  const state = random(32);
  const verifier = random(64);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_pending WHERE created_at < ?").bind(now - PENDING_TTL_S),
    env.DB.prepare("INSERT INTO oauth_pending (state, provider, verifier, created_at) VALUES (?, ?, ?, ?)").bind(state, provider, verifier, now),
  ]);
  const u = new URL(def.authorizeUrl);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: def.clientId, redirect_uri: def.redirectUri, scope: def.scope, code_challenge: challenge, code_challenge_method: "S256", state, ...def.extra })) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

export const isPendingState = async (db: D1Database, state: string): Promise<boolean> =>
  (await db.prepare("SELECT 1 AS x FROM oauth_pending WHERE state = ? AND created_at >= ?").bind(state, Math.floor(Date.now() / 1000) - PENDING_TTL_S).first()) !== null;

export type LoginResult =
  | { ok: true; id: string; name: string }
  | { ok: false; status: 400 | 500 | 502; error: "invalid_state" | "not_configured" | "provider_refused"; message: string };

interface Tokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
}

/** What a provider's error answer says, without anything it should not: its description, its code, or the status. */
async function refusal(res: Response): Promise<string> {
  const b = (await res.json().catch(() => null)) as { error?: unknown; error_description?: unknown } | null;
  const e = b?.error;
  if (typeof b?.error_description === "string") return b.error_description;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  return `sign-in service answered ${res.status}`;
}

/**
 * Finishes a login: trades the code for tokens, seals them, and stores them as a connection named after the
 * account's email. Signing in again as the same account replaces that connection's tokens. `provider` null: the
 * one the state was issued for.
 */
export async function finishLogin(env: Env, upstream: Fetch, provider: string | null, code: string, state: string): Promise<LoginResult> {
  const now = Math.floor(Date.now() / 1000);
  // Single use: the row is gone before the provider is asked, so a replay finds nothing.
  const pending = await env.DB.prepare("DELETE FROM oauth_pending WHERE state = ? AND created_at >= ? RETURNING provider, verifier")
    .bind(state, now - PENDING_TTL_S)
    .first<{ provider: string; verifier: string }>();
  const def = pending ? OAUTH[pending.provider] : undefined;
  if (!pending || !def || (provider !== null && provider !== pending.provider)) {
    return { ok: false, status: 400, error: "invalid_state", message: "this sign-in was not started here, was already used, or is older than 10 minutes" };
  }
  let res: Response;
  try {
    res = await upstream(
      new Request(def.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: def.redirectUri, client_id: def.clientId, code_verifier: pending.verifier }).toString(),
      }),
    );
  } catch {
    return { ok: false, status: 502, error: "provider_refused", message: "could not reach the sign-in service" };
  }
  if (!res.ok) return { ok: false, status: 502, error: "provider_refused", message: await refusal(res) };
  const t = (await res.json().catch(() => null)) as (Partial<Tokens> & { expires_in?: unknown }) | null;
  if (!t || typeof t.access_token !== "string" || typeof t.refresh_token !== "string") {
    return { ok: false, status: 502, error: "provider_refused", message: "the sign-in service sent no tokens" };
  }
  const id = claims(t.id_token);
  const auth = (id["https://api.openai.com/auth"] ?? {}) as { chatgpt_account_id?: unknown };
  const account = typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null;
  const name = typeof id.email === "string" && id.email !== "" ? id.email.slice(0, 100) : "Account";
  const secret = await seal(env, JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, id_token: t.id_token } satisfies Tokens));
  if (!secret) return { ok: false, status: 500, error: "not_configured", message: "set the CONNECTIONS_KEY secret: 32 random bytes, base64" };
  const expiresAt = now + (typeof t.expires_in === "number" && t.expires_in > 0 ? t.expires_in : 3600);

  const existing = account
    ? await env.DB.prepare("SELECT id FROM connection WHERE provider = ? AND account = ?").bind(pending.provider, account).first<{ id: string }>()
    : null;
  if (existing) {
    await env.DB.prepare(
      "UPDATE connection SET secret = ?, name = ?, expires_at = ?, cooldown_until = 0, backoff_level = 0, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(secret, name, expiresAt, now, existing.id)
      .run();
    return { ok: true, id: existing.id, name };
  }
  const connectionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO connection (id, provider, auth_type, name, secret, account, expires_at, priority, created_at, updated_at)
     VALUES (?, ?, 'oauth', ?, ?, ?, ?, (SELECT COALESCE(MAX(priority), 0) + 1 FROM connection WHERE provider = ?), ?, ?)`,
  )
    .bind(connectionId, pending.provider, name, secret, account, expiresAt, pending.provider, now, now)
    .run();
  return { ok: true, id: connectionId, name };
}

/**
 * The access token of an OAuth connection, refreshed first when it has little time left. `{error}`: the provider
 * refused the refresh (the user has to sign in again). Null: the stored tokens cannot be opened.
 */
export async function accessToken(
  env: Env,
  upstream: Fetch,
  row: { id: string; provider: string; secret: string; expires_at: number | null },
  now: number,
): Promise<string | { error: string } | null> {
  const def = OAUTH[row.provider];
  const plain = await open(env, row.secret);
  if (!def || plain === null) return null;
  let t: Tokens;
  try {
    t = JSON.parse(plain) as Tokens;
  } catch {
    return null;
  }
  if (row.expires_at !== null && row.expires_at - now >= def.refreshLeadS) return t.access_token;
  let res: Response;
  try {
    res = await upstream(
      new Request(def.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ client_id: def.clientId, grant_type: "refresh_token", refresh_token: t.refresh_token }),
      }),
    );
  } catch {
    // The old token may still be good for the time it has left.
    return row.expires_at !== null && row.expires_at > now ? t.access_token : { error: "sign in again: could not reach the sign-in service" };
  }
  if (!res.ok) return { error: `sign in again: ${await refusal(res)}` };
  const fresh = (await res.json().catch(() => null)) as (Partial<Tokens> & { expires_in?: unknown }) | null;
  if (!fresh || typeof fresh.access_token !== "string") return { error: "sign in again: the sign-in service sent no token" };
  const next: Tokens = { access_token: fresh.access_token, refresh_token: typeof fresh.refresh_token === "string" ? fresh.refresh_token : t.refresh_token, id_token: fresh.id_token ?? t.id_token };
  const secret = await seal(env, JSON.stringify(next));
  if (secret) {
    await env.DB.prepare("UPDATE connection SET secret = ?, expires_at = ?, updated_at = ? WHERE id = ?")
      .bind(secret, now + (typeof fresh.expires_in === "number" && fresh.expires_in > 0 ? fresh.expires_in : 3600), now, row.id)
      .run();
  }
  return next.access_token;
}
