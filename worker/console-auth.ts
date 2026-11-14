import { Hono, type Context } from "hono";
import { isAdmin, sha256hex } from "./auth";
import type { AppEnv, Env } from "./env";

/** Sends a request to the OpenID provider (xDev ID). `fetch` in production; a fake in tests. */
export type Idp = (req: Request) => Promise<Response>;

export const SESSION_COOKIE = "__Host-xllm_session";
export const LOGIN_COOKIE = "__Host-xllm_login";
const SESSION_TTL_S = 12 * 3600;
const LOGIN_TTL_S = 10 * 60;

/** Who holds a console session: an xDev ID user, or the owner who signed in with the admin token. */
export type ConsoleUser = { email: string; name: string } | { admin: true };

const now = () => Math.floor(Date.now() / 1000);

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const s256 = async (v: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

/** Lower-cased emails allowed into the console (CONSOLE_EMAILS, comma-separated). */
export function consoleEmails(env: Env): string[] {
  return (env.CONSOLE_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

const configured = (env: Env) => Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && consoleEmails(env).length);

/** The signed-in console user of this request, from the session cookie; null when absent or expired. */
export async function consoleUser(env: Env, req: Request): Promise<ConsoleUser | null> {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT email, name, admin_key FROM console_session WHERE token_sha256 = ? AND expires_at > ?")
    .bind(await sha256hex(token), now())
    .first<{ email: string; name: string; admin_key: string | null }>();
  if (!row) return null;
  if (row.admin_key !== null) {
    // Opened with the admin token: ends once that token is changed or removed.
    const key = await adminKey(env);
    return key !== null && key === row.admin_key ? { admin: true } : null;
  }
  // Removed from CONSOLE_EMAILS since signing in: no longer allowed.
  return consoleEmails(env).includes(row.email) ? { email: row.email, name: row.name } : null;
}

/** Fingerprint of the current admin token (a hash of its hash), or null while none is set. */
async function adminKey(env: Env): Promise<string | null> {
  const h = env.ADMIN_TOKEN_SHA256;
  return h !== undefined && /^[0-9a-f]{64}$/.test(h) ? sha256hex(h) : null;
}

/** Stores a new console session (only its SHA-256) and sets its cookie. */
async function openSession(c: Ctx, row: { email: string; name: string; adminKey: string | null }): Promise<void> {
  const env = c.env;
  const token = random();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM console_session WHERE expires_at <= ?").bind(now()),
    env.DB.prepare("INSERT INTO console_session (token_sha256, email, name, created_at, expires_at, admin_key) VALUES (?, ?, ?, ?, ?, ?)").bind(
      await sha256hex(token),
      row.email,
      row.name,
      now(),
      now() + SESSION_TTL_S,
      row.adminKey,
    ),
  ]);
  c.header("set-cookie", setCookie(SESSION_COOKIE, token, SESSION_TTL_S), { append: true });
}

/** A browser request from this site's own pages (cookie-authenticated writes must be). */
export function sameOrigin(req: Request): boolean {
  return req.headers.get("origin") === new URL(req.url).origin;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const v: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (ch) => ch.charCodeAt(0))));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Ctx = Context<AppEnv>;
const back = (c: Ctx, error?: string) => {
  c.header("set-cookie", setCookie(LOGIN_COOKIE, "", 0), { append: true });
  return c.redirect(error ? `/?signin_error=${error}` : "/#/systems", 302);
};

/**
 * Console sign-in with xDev ID over OpenID Connect (authorization code flow, PKCE, confidential client).
 * The ID token comes straight from the provider's token endpoint over TLS, so its signature is not
 * checked again (OpenID Connect Core 3.1.3.7); its issuer, audience, nonce and expiry are.
 */
export function consoleAuthRoutes(idp: Idp): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });

  a.get("/login", async (c) => {
    const env = c.env;
    if (!configured(env)) return back(c, "not_configured");
    const state = random();
    const nonce = random();
    const verifier = random();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM console_login WHERE expires_at <= ?").bind(now()),
      env.DB.prepare("INSERT INTO console_login (state_sha256, verifier, nonce, expires_at) VALUES (?, ?, ?, ?)").bind(
        await sha256hex(state),
        verifier,
        nonce,
        now() + LOGIN_TTL_S,
      ),
    ]);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: env.OIDC_CLIENT_ID!,
      redirect_uri: `${new URL(c.req.url).origin}/auth/callback`,
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: await s256(verifier),
      code_challenge_method: "S256",
    });
    // Binds the sign-in to this browser: a callback link sent from elsewhere does not match.
    c.header("set-cookie", setCookie(LOGIN_COOKIE, state, LOGIN_TTL_S));
    return c.redirect(`${env.OIDC_ISSUER}/oauth2/authorize?${q}`, 302);
  });

  a.get("/callback", async (c) => {
    const env = c.env;
    if (!configured(env)) return back(c, "not_configured");
    const state = c.req.query("state") ?? "";
    const browserState = cookie(c.req.raw, LOGIN_COOKIE);
    if (!state || state !== browserState) return back(c, "expired");
    const row = await env.DB.prepare("DELETE FROM console_login WHERE state_sha256 = ? RETURNING verifier, nonce, expires_at")
      .bind(await sha256hex(state))
      .first<{ verifier: string; nonce: string; expires_at: number }>();
    if (!row || row.expires_at <= now()) return back(c, "expired");
    if (c.req.query("error")) return back(c, "cancelled");
    const code = c.req.query("code");
    if (!code) return back(c, "failed");

    let tokens: { access_token?: unknown; id_token?: unknown };
    try {
      const res = await idp(
        new Request(`${env.OIDC_ISSUER}/oauth2/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${btoa(`${encodeURIComponent(env.OIDC_CLIENT_ID!)}:${encodeURIComponent(env.OIDC_CLIENT_SECRET!)}`)}`,
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: `${new URL(c.req.url).origin}/auth/callback`,
            code_verifier: row.verifier,
          }),
        }),
      );
      if (!res.ok) return back(c, "failed");
      tokens = (await res.json()) as typeof tokens;
    } catch {
      return back(c, "failed");
    }
    const claims = typeof tokens.id_token === "string" ? decodeJwtPayload(tokens.id_token) : null;
    const aud = claims?.aud;
    const audOk = aud === env.OIDC_CLIENT_ID || (Array.isArray(aud) && aud.includes(env.OIDC_CLIENT_ID));
    if (
      !claims ||
      claims.iss !== env.OIDC_ISSUER ||
      !audOk ||
      claims.nonce !== row.nonce ||
      typeof claims.exp !== "number" ||
      claims.exp <= now() ||
      typeof claims.sub !== "string" ||
      typeof tokens.access_token !== "string"
    ) {
      return back(c, "failed");
    }

    let info: Record<string, unknown>;
    try {
      const res = await idp(new Request(`${env.OIDC_ISSUER}/oauth2/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } }));
      if (!res.ok) return back(c, "failed");
      info = (await res.json()) as Record<string, unknown>;
    } catch {
      return back(c, "failed");
    }
    if (info.sub !== claims.sub || typeof info.email !== "string") return back(c, "failed");
    const email = info.email.toLowerCase();
    if (info.email_verified !== true || !consoleEmails(env).includes(email)) return back(c, "not_allowed");

    const name = typeof info.name === "string" && info.name.trim() ? info.name.trim().slice(0, 100) : email;
    await openSession(c, { email, name, adminKey: null });
    return back(c);
  });

  /**
   * The admin token sign-in: `Authorization: Bearer <admin token>` from the console's own page buys a
   * session cookie, so the page never keeps the token and a reload stays signed in.
   */
  a.post("/token", async (c) => {
    if (!sameOrigin(c.req.raw)) return c.json({ error: "forbidden" }, 403);
    const key = await adminKey(c.env);
    if (key === null || !(await isAdmin(c.env, c.req.raw))) return c.json({ error: "unauthorized" }, 401);
    await openSession(c, { email: "", name: "", adminKey: key });
    return c.json({ admin: true });
  });

  /** Who is signed in (with xDev ID), for the console; 401 otherwise. Also says whether sign-in is set up. */
  a.get("/me", async (c) => {
    const user = await consoleUser(c.env, c.req.raw);
    if (!user) return c.json({ error: "unauthorized", sso: configured(c.env) }, 401);
    return c.json(user);
  });

  a.post("/logout", async (c) => {
    if (!sameOrigin(c.req.raw)) return c.json({ error: "forbidden" }, 403);
    const token = cookie(c.req.raw, SESSION_COOKIE);
    if (token) await c.env.DB.prepare("DELETE FROM console_session WHERE token_sha256 = ?").bind(await sha256hex(token)).run();
    c.header("set-cookie", setCookie(SESSION_COOKIE, "", 0));
    return c.body(null, 204);
  });

  return a;
}
