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

export const OAUTH: Readonly<Record<string, OAuthDef>> = {
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

/** The provider's login, only for its own names: never `constructor`, `toString` or another inherited property. */
export const oauthDef = (provider: string): OAuthDef | null => (Object.hasOwn(OAUTH, provider) ? OAUTH[provider]! : null);

/** Whether tokens can be sealed (CONNECTIONS_KEY set and usable): no login starts or finishes without it. */
const canSeal = async (env: Env): Promise<boolean> => (await seal(env, "probe")) !== null;

/** RFC 3986 form for the query: `%20` for a space, which some authorize pages need (URLSearchParams writes `+`). */
const query = (params: Record<string, string>) =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
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

export type StartResult = { ok: true; url: string } | { ok: false; error: "not_found" | "not_configured" };

/** The page to send the browser to. Stores the PKCE verifier until the provider sends the browser back. */
export async function startLogin(env: Env, provider: string): Promise<StartResult> {
  const def = oauthDef(provider);
  if (!def) return { ok: false, error: "not_found" };
  // A login whose tokens could not be stored is not started: the user would sign in for nothing.
  if (!(await canSeal(env))) return { ok: false, error: "not_configured" };
  const state = random(32);
  const verifier = random(64);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_pending WHERE created_at < ?").bind(now - PENDING_TTL_S),
    env.DB.prepare("INSERT INTO oauth_pending (state, provider, verifier, created_at) VALUES (?, ?, ?, ?)").bind(state, provider, verifier, now),
  ]);
  const params = { response_type: "code", client_id: def.clientId, redirect_uri: def.redirectUri, scope: def.scope, code_challenge: challenge, code_challenge_method: "S256", state, ...def.extra };
  return { ok: true, url: `${def.authorizeUrl}?${query(params)}` };
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

const NOT_CONFIGURED = { ok: false, status: 500, error: "not_configured", message: "set the CONNECTIONS_KEY secret: 32 random bytes, base64" } as const;

/** What a provider's error answer says, without anything it should not: its description, its code, or the status. */
async function refusal(res: Response): Promise<string> {
  const b = (await res.json().catch(() => null)) as { error?: unknown; error_description?: unknown } | null;
  const e = b?.error;
  if (typeof b?.error_description === "string") return b.error_description;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  return `sign-in service answered ${res.status}`;
}

const expiry = (now: number, expiresIn: unknown) => now + (typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600);

/**
 * Finishes a login: trades the code for tokens, seals them, and stores them as a connection named after the
 * account's email. Signing in again as the same person of the same account replaces that connection's tokens;
 * another person of a shared (team) account gets a connection of their own. `provider` null: the one the state
 * was issued for.
 */
export async function finishLogin(env: Env, upstream: Fetch, provider: string | null, code: string, state: string): Promise<LoginResult> {
  // Checked before the state is used up and the code is spent, so the user can sign in again once it is set.
  if (!(await canSeal(env))) return NOT_CONFIGURED;
  const now = Math.floor(Date.now() / 1000);
  // Single use: the row is gone before the provider is asked, so a replay finds nothing.
  const pending = await env.DB.prepare("DELETE FROM oauth_pending WHERE state = ? AND created_at >= ? RETURNING provider, verifier")
    .bind(state, now - PENDING_TTL_S)
    .first<{ provider: string; verifier: string }>();
  const def = pending ? oauthDef(pending.provider) : null;
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
  const email = typeof id.email === "string" && id.email !== "" ? id.email : null;
  // The person who signed in: one ChatGPT team account has many.
  const subject = typeof id.sub === "string" && id.sub !== "" ? id.sub : email;
  const name = email ? email.slice(0, 100) : "Account";
  const secret = await seal(env, JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, id_token: t.id_token } satisfies Tokens));
  if (!secret) return NOT_CONFIGURED;
  const expiresAt = expiry(now, t.expires_in);

  // A connection stored before `subject` existed (NULL) is taken as this person's, and gets their subject.
  const existing =
    account && subject
      ? await env.DB.prepare("SELECT id FROM connection WHERE provider = ? AND account = ? AND (subject = ? OR subject IS NULL) ORDER BY subject IS NULL LIMIT 1")
          .bind(pending.provider, account, subject)
          .first<{ id: string }>()
      : null;
  if (existing) {
    await env.DB.prepare(
      "UPDATE connection SET secret = ?, name = ?, subject = ?, expires_at = ?, cooldown_until = 0, backoff_level = 0, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(secret, name, subject, expiresAt, now, existing.id)
      .run();
    return { ok: true, id: existing.id, name };
  }
  const connectionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO connection (id, provider, auth_type, name, secret, account, subject, expires_at, priority, created_at, updated_at)
     VALUES (?, ?, 'oauth', ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(priority), 0) + 1 FROM connection WHERE provider = ?), ?, ?)`,
  )
    .bind(connectionId, pending.provider, name, secret, account, subject, expiresAt, pending.provider, now, now)
    .run();
  return { ok: true, id: connectionId, name };
}

/**
 * An OAuth connection's access token.
 * - `token`: the one to send. `renewed`: the provider issued it just now (or another request had just stored a
 *   newer one). `unavailable`: a renewal was due but the sign-in service could not be used, so the old token,
 *   still valid, is sent; this is the reason.
 * - `error`: no usable token. Status 401: the provider refused the renewal, the user has to sign in again. 502:
 *   the sign-in service is unavailable and the old token has expired.
 * - null: the stored tokens cannot be opened (CONNECTIONS_KEY changed).
 */
export type TokenResult = { token: string; renewed: boolean; unavailable?: string } | { error: string; status: 401 | 502 } | null;

export interface OAuthRow {
  id: string;
  provider: string;
  secret: string;
  expires_at: number | null;
}

async function openTokens(env: Env, secret: string): Promise<Tokens | null> {
  const plain = await open(env, secret);
  if (plain === null) return null;
  try {
    const t = JSON.parse(plain) as Partial<Tokens>;
    return typeof t.access_token === "string" && typeof t.refresh_token === "string" ? (t as Tokens) : null;
  } catch {
    return null;
  }
}

/**
 * The access token of an OAuth connection, renewed first when it has little time left, or always with `force`
 * (Codex answered 401, or the console tests the connection).
 */
export async function oauthToken(env: Env, upstream: Fetch, row: OAuthRow, now: number, force = false): Promise<TokenResult> {
  const def = oauthDef(row.provider);
  const t = def ? await openTokens(env, row.secret) : null;
  if (!def || !t) return null;
  if (!force && row.expires_at !== null && row.expires_at - now >= def.refreshLeadS) return { token: t.access_token, renewed: false };

  const stillValid = row.expires_at !== null && row.expires_at > now;
  const unavailable = (reason: string): TokenResult =>
    stillValid ? { token: t.access_token, renewed: false, unavailable: reason } : { error: `the sign-in service is unavailable: ${reason}`, status: 502 };

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
    return unavailable("could not reach it");
  }
  if (res.status === 400 || res.status === 401) {
    const reason = await refusal(res);
    // A refresh token is single use: when another request renewed first, this one is refused. Its new tokens
    // are stored by then; use them.
    const current = await env.DB.prepare("SELECT secret, expires_at FROM connection WHERE id = ?")
      .bind(row.id)
      .first<{ secret: string; expires_at: number | null }>()
      .catch(() => null);
    if (current && current.secret !== row.secret && (current.expires_at === null || current.expires_at > Math.floor(Date.now() / 1000))) {
      const newer = await openTokens(env, current.secret);
      if (newer) return { token: newer.access_token, renewed: true };
    }
    return { error: `sign in again: ${reason}`, status: 401 };
  }
  if (!res.ok) return unavailable(`it answered ${res.status}`);
  const fresh = (await res.json().catch(() => null)) as (Partial<Tokens> & { expires_in?: unknown }) | null;
  if (!fresh || typeof fresh.access_token !== "string") return unavailable("it sent no token");
  const next: Tokens = {
    access_token: fresh.access_token,
    refresh_token: typeof fresh.refresh_token === "string" ? fresh.refresh_token : t.refresh_token,
    id_token: typeof fresh.id_token === "string" ? fresh.id_token : t.id_token,
  };
  const secret = await seal(env, JSON.stringify(next));
  if (secret) {
    try {
      // Compare-and-swap: when another request stored newer tokens meanwhile, those are kept.
      await env.DB.prepare("UPDATE connection SET secret = ?, expires_at = ?, updated_at = ? WHERE id = ? AND secret = ?")
        .bind(secret, expiry(now, fresh.expires_in), now, row.id, row.secret)
        .run();
    } catch {
      // The token is good for this request; the next one renews again.
    }
  }
  return { token: next.access_token, renewed: true };
}
