import type { Hono } from "hono";
import type { AppEnv, Env } from "./env";
import { open, seal } from "./secret-box";

/** The xDev ID client the console signs in with. */
export interface SsoConfig {
  issuer: string;
  clientId: string;
  secret: string;
}

type Source = "settings" | "env" | "none";

/** The `setting` row `sso`: the client saved in Settings, its secret sealed with CONNECTIONS_KEY. */
interface Stored {
  issuer: string;
  client_id: string;
  secret: string;
}

const text = (v: string | undefined) => (typeof v === "string" ? v.trim() : "");

async function stored(db: D1Database): Promise<Stored | null> {
  const row = await db.prepare("SELECT value FROM setting WHERE key = 'sso'").first<{ value: string }>();
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<Stored>;
    return typeof v.issuer === "string" && typeof v.client_id === "string" && typeof v.secret === "string" ? (v as Stored) : null;
  } catch {
    return null;
  }
}

/** The client saved in Settings, else the OIDC_* bindings; with where it came from. Values may be empty. */
async function current(env: Env): Promise<{ source: Source; issuer: string; clientId: string; secret: string }> {
  const s = await stored(env.DB);
  if (s) return { source: "settings", issuer: s.issuer, clientId: s.client_id, secret: (await open(env, s.secret)) ?? "" };
  const issuer = text(env.OIDC_ISSUER);
  const clientId = text(env.OIDC_CLIENT_ID);
  const secret = text(env.OIDC_CLIENT_SECRET);
  return { source: issuer || clientId || secret ? "env" : "none", issuer, clientId, secret };
}

/** The client console sign-in uses, or null while issuer, client ID or secret is missing. */
export async function ssoConfig(env: Env): Promise<SsoConfig | null> {
  const c = await current(env);
  return c.issuer && c.clientId && c.secret ? { issuer: c.issuer, clientId: c.clientId, secret: c.secret } : null;
}

/** Which client granted a session: a sign-in through another issuer or client does not count. */
export const ssoKey = (c: SsoConfig) => `${c.issuer} ${c.clientId}`;

/** Where the console sends the browser, trades the code and asks who signed in. */
export interface SsoEndpoints {
  authorize: string;
  token: string;
  userinfo: string;
}

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const discovered = new Map<string, { at: number; endpoints: SsoEndpoints }>();

/** xDev ID's own paths, for an issuer without a discovery document. */
const xdevPaths = (issuer: string): SsoEndpoints => ({
  authorize: `${issuer}/oauth2/authorize`,
  token: `${issuer}/oauth2/token`,
  userinfo: `${issuer}/oauth2/userinfo`,
});

const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
};

/**
 * The provider's endpoints from its OpenID Connect Discovery document (`<issuer>/.well-known/openid-configuration`),
 * so any standard provider works (Keycloak: `/protocol/openid-connect/*`). A document is used only when its `issuer`
 * is the configured one and its three endpoints are https (Discovery 1.0, 4.3); otherwise, or with no document,
 * xDev ID's `/oauth2/*` paths. Kept per issuer for 10 minutes; a provider that cannot be reached is asked again.
 */
export async function ssoEndpoints(sso: SsoConfig, idp: (req: Request) => Promise<Response>): Promise<SsoEndpoints> {
  const hit = discovered.get(sso.issuer);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.endpoints;
  let endpoints = xdevPaths(sso.issuer);
  try {
    const res = await idp(new Request(`${sso.issuer}/.well-known/openid-configuration`, { headers: { accept: "application/json" } }));
    if (res.ok) {
      const doc = (await res.json()) as Record<string, unknown>;
      const authorize = httpsUrl(doc.authorization_endpoint);
      const token = httpsUrl(doc.token_endpoint);
      const userinfo = httpsUrl(doc.userinfo_endpoint);
      if (doc.issuer === sso.issuer && authorize && token && userinfo) endpoints = { authorize, token, userinfo };
    }
  } catch {
    return endpoints; // unreachable or not JSON: this request uses xDev ID's paths; the next one asks again
  }
  discovered.set(sso.issuer, { at: Date.now(), endpoints });
  return endpoints;
}

/** An https URL without query, fragment or credentials, without its trailing slashes; null otherwise. */
function issuerOf(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 500) return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.search || u.hash || u.username || u.password || v.includes("#") || v.includes("?")) return null;
  return u.href.replace(/\/+$/, "");
}

/**
 * `/admin/sso`: the xDev ID client in Settings (FR-SET-17 to FR-SET-20). The secret is write-only: answers say
 * only whether one is set.
 */
export function ssoRoutes(a: Hono<AppEnv>): void {
  const view = async (env: Env, req: Request) => {
    const c = await current(env);
    return { source: c.source, issuer: c.issuer, client_id: c.clientId, secret_set: c.secret !== "", redirect_uri: `${new URL(req.url).origin}/auth/callback` };
  };

  a.get("/sso", async (c) => c.json(await view(c.env, c.req.raw)));

  a.put("/sso", async (c) => {
    let b: Record<string, unknown>;
    try {
      const v: unknown = await c.req.json();
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
      b = v as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_input", hint: "a JSON object" }, 400);
    }
    const issuer = issuerOf(b.issuer);
    if (!issuer) return c.json({ error: "invalid_input", hint: "issuer: an https URL without ? or #" }, 400);
    const clientId = typeof b.client_id === "string" ? b.client_id.trim() : "";
    if (!clientId || clientId.length > 200) return c.json({ error: "invalid_input", hint: "client_id: 1 to 200 characters" }, 400);
    if (b.secret !== undefined && b.secret !== null && (typeof b.secret !== "string" || b.secret.length > 4096)) {
      return c.json({ error: "invalid_input", hint: "secret: at most 4096 characters" }, 400);
    }
    // Left empty: keeps the secret in use (saved here or from the environment).
    const secret = (typeof b.secret === "string" ? b.secret.trim() : "") || (await current(c.env)).secret;
    if (!secret) return c.json({ error: "invalid_input", hint: "secret: the client secret from xDev ID" }, 400);
    const sealed = await seal(c.env, secret);
    if (!sealed) return c.json({ error: "not_configured", hint: "set the CONNECTIONS_KEY secret: 32 random bytes, base64" }, 409);
    await c.env.DB.prepare(
      "INSERT INTO setting (key, value, updated_at) VALUES ('sso', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
      .bind(JSON.stringify({ issuer, client_id: clientId, secret: sealed } satisfies Stored), Math.floor(Date.now() / 1000))
      .run();
    return c.json(await view(c.env, c.req.raw));
  });

  a.delete("/sso", async (c) => {
    await c.env.DB.prepare("DELETE FROM setting WHERE key = 'sso'").run();
    return c.json(await view(c.env, c.req.raw));
  });
}
