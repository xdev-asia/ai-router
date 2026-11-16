import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { makeApp } from "../app";
import { sha256hex } from "../auth";
import { LOGIN_COOKIE, SESSION_COOKIE } from "../console-auth";
import type { Env } from "../env";
import { ADMIN_TOKEN, BASE, fakeUpstream, reset } from "./helpers";

const ISSUER = "https://id.test/api/auth";
const CLIENT = "llm-client";
const SECRET = "test-oidc-secret";

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fakeJwt = (claims: Record<string, unknown>) => `${b64url('{"alg":"EdDSA"}')}.${b64url(JSON.stringify(claims))}.sig`;
const s256 = async (v: string) =>
  b64url(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))));

interface User {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}

interface Tweak {
  claims?: Record<string, unknown>;
  tokenStatus?: number;
  /** Claims xDev ID adds to userinfo, such as `xdev_role`. */
  info?: Record<string, unknown>;
  /** Another provider or client than the bindings' (a configuration saved in Settings). */
  issuer?: string;
  client?: string;
  secret?: string;
}

/** A fake xDev ID: remembers the authorize request, checks the token request like a real provider would. */
function fakeIdp(user: User, tweak: Tweak = {}) {
  const issuer = tweak.issuer ?? ISSUER;
  const client = tweak.client ?? CLIENT;
  const secret = tweak.secret ?? SECRET;
  const idp = {
    challenge: "",
    nonce: "",
    code: `code-${crypto.randomUUID()}`,
    calls: [] as string[],
    fn: async (req: Request): Promise<Response> => {
      idp.calls.push(new URL(req.url).pathname);
      if (req.url === `${issuer}/oauth2/token`) {
        if (req.headers.get("authorization") !== `Basic ${btoa(`${client}:${secret}`)}`) return new Response("{}", { status: 401 });
        const form = new URLSearchParams(await req.text());
        if (form.get("code") !== idp.code || (await s256(form.get("code_verifier") ?? "")) !== idp.challenge) {
          return new Response('{"error":"invalid_grant"}', { status: 400 });
        }
        if (form.get("redirect_uri") !== `${BASE}/auth/callback`) return new Response("{}", { status: 400 });
        if (tweak.tokenStatus) return new Response("{}", { status: tweak.tokenStatus });
        const claims = { iss: issuer, aud: client, sub: user.sub, nonce: idp.nonce, exp: Math.floor(Date.now() / 1000) + 600, ...tweak.claims };
        return Response.json({ access_token: "at-1", token_type: "Bearer", id_token: fakeJwt(claims) });
      }
      if (req.url === `${issuer}/oauth2/userinfo`) {
        if (req.headers.get("authorization") !== "Bearer at-1") return new Response("{}", { status: 401 });
        return Response.json({ ...user, ...tweak.info });
      }
      return new Response("not found", { status: 404 });
    },
  };
  return idp;
}

type Idp = ReturnType<typeof fakeIdp>;
const OWNER: User = { sub: "u-1", email: "Owner@Example.com", email_verified: true, name: "Owner" };

async function send(idp: Idp | null, path: string, init: RequestInit = {}, bindings: Partial<Env> = {}) {
  const app = makeApp({ upstream: fakeUpstream(() => new Response("{}")).fn, idp: idp?.fn ?? (() => Promise.reject(new Error("no idp"))) });
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(BASE + path, { redirect: "manual", ...init }), { ...env, ...bindings }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const cookieValue = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/** Starts a sign-in; the fake provider records what the authorize request asked for. */
async function login(idp: Idp, bindings: Partial<Env> = {}) {
  const res = await send(idp, "/auth/login", {}, bindings);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  idp.challenge = loc.searchParams.get("code_challenge")!;
  idp.nonce = loc.searchParams.get("nonce")!;
  return { loc, state: loc.searchParams.get("state")!, loginCookie: cookieValue(res, LOGIN_COOKIE)! };
}

async function callback(idp: Idp, state: string, loginCookie: string | null, extra = "", bindings: Partial<Env> = {}) {
  return send(
    idp,
    `/auth/callback?code=${idp.code}&state=${encodeURIComponent(state)}${extra}`,
    { headers: loginCookie === null ? {} : { cookie: `${LOGIN_COOKIE}=${loginCookie}` } },
    bindings,
  );
}

/** Full sign-in; returns the console session cookie header. */
async function signIn(user = OWNER, tweak: Tweak = {}, bindings: Partial<Env> = {}) {
  const idp = fakeIdp(user, tweak);
  const { state, loginCookie } = await login(idp, bindings);
  const res = await callback(idp, state, loginCookie, "", bindings);
  expect(res.headers.get("location")).toBe("/#/systems");
  return `${SESSION_COOKIE}=${cookieValue(res, SESSION_COOKIE)}`;
}

beforeEach(reset);

describe("sign-in start", () => {
  it("redirects to xDev ID with PKCE, state and nonce, and binds the state to the browser", async () => {
    const idp = fakeIdp(OWNER);
    const { loc, state, loginCookie } = await login(idp);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${ISSUER}/oauth2/authorize`);
    expect(loc.searchParams.get("client_id")).toBe(CLIENT);
    expect(loc.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/callback`);
    expect(loc.searchParams.get("scope")).toBe("openid profile email");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loginCookie).toBe(state);
    const row = await env.DB.prepare("SELECT state_sha256 FROM console_login").first<{ state_sha256: string }>();
    expect(row?.state_sha256).toBe(await sha256hex(state));
  });

  it("goes back with not_configured while any OIDC value is missing", async () => {
    for (const b of [{ OIDC_CLIENT_SECRET: undefined }, { OIDC_CLIENT_ID: "" }, { OIDC_ISSUER: undefined }]) {
      const res = await send(null, "/auth/login", {}, b);
      expect(res.headers.get("location"), JSON.stringify(b)).toBe("/?signin_error=not_configured");
    }
  });
});

describe("callback", () => {
  it("signs an allowed, verified user in and the console session reaches /admin", async () => {
    const cookie = await signIn();
    const me = await send(null, "/auth/me", { headers: { cookie } });
    expect(await me.json()).toEqual({ email: "owner@example.com", name: "Owner" });
    expect((await send(null, "/admin/systems", { headers: { cookie } })).status).toBe(200);
    // Only the hash of the session token is stored.
    const token = cookie.split("=")[1]!;
    expect(await env.DB.prepare("SELECT count(*) AS n FROM console_session WHERE token_sha256 = ?").bind(await sha256hex(token)).first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM console_login").first("n")).toBe(0);
  });

  it("sets Secure, HttpOnly, SameSite=Lax host-only cookies", async () => {
    const idp = fakeIdp(OWNER);
    const { state, loginCookie } = await login(idp);
    const res = await callback(idp, state, loginCookie);
    const session = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(session).toContain("Path=/");
    expect(session).toContain("Secure");
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Lax");
    expect(session).not.toContain("Domain=");
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${LOGIN_COOKIE}=;`) && c.includes("Max-Age=0"))).toBe(true);
  });

  it("refuses a callback from another browser, a reused state and a provider error", async () => {
    const idp = fakeIdp(OWNER);
    const first = await login(idp);
    expect((await callback(idp, first.state, null)).headers.get("location")).toBe("/?signin_error=expired");
    expect((await callback(idp, first.state, "other")).headers.get("location")).toBe("/?signin_error=expired");

    const second = await login(idp);
    expect((await callback(idp, second.state, second.loginCookie, "&error=access_denied")).headers.get("location")).toBe("/?signin_error=cancelled");
    // The state was used up by the cancelled attempt.
    expect((await callback(idp, second.state, second.loginCookie)).headers.get("location")).toBe("/?signin_error=expired");
  });

  it("refuses an expired sign-in", async () => {
    const idp = fakeIdp(OWNER);
    const { state, loginCookie } = await login(idp);
    await env.DB.prepare("UPDATE console_login SET expires_at = 1").run();
    expect((await callback(idp, state, loginCookie)).headers.get("location")).toBe("/?signin_error=expired");
  });

  it("refuses emails that are not allowed or not verified", async () => {
    for (const user of [
      { ...OWNER, email: "stranger@example.com" },
      { ...OWNER, email_verified: false },
    ]) {
      const idp = fakeIdp(user);
      const { state, loginCookie } = await login(idp);
      const res = await callback(idp, state, loginCookie);
      expect(res.headers.get("location")).toBe("/?signin_error=not_allowed");
      expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
    }
  });

  it("refuses an ID token for another client, issuer or nonce, or an expired one", async () => {
    for (const claims of [{ aud: "other-client" }, { iss: "https://evil.test/api/auth" }, { nonce: "other" }, { exp: 1 }]) {
      const idp = fakeIdp(OWNER, { claims });
      const { state, loginCookie } = await login(idp);
      expect((await callback(idp, state, loginCookie)).headers.get("location"), JSON.stringify(claims)).toBe("/?signin_error=failed");
    }
  });

  it("refuses when userinfo is for another subject or the token request fails", async () => {
    const other = fakeIdp(OWNER, { claims: { sub: "someone-else" } });
    const a = await login(other);
    expect((await callback(other, a.state, a.loginCookie)).headers.get("location")).toBe("/?signin_error=failed");

    const broken = fakeIdp(OWNER, { tokenStatus: 500 });
    const b = await login(broken);
    expect((await callback(broken, b.state, b.loginCookie)).headers.get("location")).toBe("/?signin_error=failed");
  });
});

describe("console session", () => {
  it("writes need a same-origin request", async () => {
    const cookie = await signIn();
    const body = JSON.stringify({ id: "chat", name: "Chat", monthly_token_cap: null });
    const headers = { cookie, "content-type": "application/json" };
    expect((await send(null, "/admin/systems", { method: "POST", headers, body })).status).toBe(403);
    expect((await send(null, "/admin/systems", { method: "POST", headers: { ...headers, origin: "https://evil.test" }, body })).status).toBe(403);
    expect((await send(null, "/admin/systems", { method: "POST", headers: { ...headers, origin: BASE }, body })).status).toBe(201);
  });

  it("a wrong bearer token is refused even with a valid cookie", async () => {
    const cookie = await signIn();
    expect((await send(null, "/admin/systems", { headers: { cookie, authorization: "Bearer nope" } })).status).toBe(401);
    expect((await send(null, "/admin/systems", { headers: { cookie, authorization: `Bearer ${ADMIN_TOKEN}` } })).status).toBe(200);
  });

  it("ends when the email leaves CONSOLE_EMAILS or the session expires", async () => {
    const cookie = await signIn();
    expect((await send(null, "/admin/systems", { headers: { cookie } }, { CONSOLE_EMAILS: "second@example.com" })).status).toBe(401);
    await env.DB.prepare("UPDATE console_session SET expires_at = 1").run();
    expect((await send(null, "/admin/systems", { headers: { cookie } })).status).toBe(401);
  });

  it("sign-out removes the session, only from the console's own pages", async () => {
    const cookie = await signIn();
    expect((await send(null, "/auth/logout", { method: "POST", headers: { cookie } })).status).toBe(403);
    const out = await send(null, "/auth/logout", { method: "POST", headers: { cookie, origin: BASE } });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect((await send(null, "/auth/me", { headers: { cookie } })).status).toBe(401);
  });

  it("/auth/me says whether xDev ID sign-in is set up", async () => {
    expect(await (await send(null, "/auth/me")).json()).toEqual({ error: "unauthorized", sso: true });
    expect(await (await send(null, "/auth/me", {}, { OIDC_CLIENT_ID: "" })).json()).toEqual({ error: "unauthorized", sso: false });
    // The access list is optional: xDev ID can grant access itself.
    expect(await (await send(null, "/auth/me", {}, { CONSOLE_EMAILS: "" })).json()).toEqual({ error: "unauthorized", sso: true });
  });
});

describe("admin token session", () => {
  const tokenSignIn = (token: string, headers: Record<string, string> = { origin: BASE }, bindings: Partial<Env> = {}) =>
    send(null, "/auth/token", { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers } }, bindings);

  it("trades the admin token for a session cookie that survives a reload", async () => {
    const res = await tokenSignIn(ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ admin: true });
    const set = res.headers.getSetCookie()[0]!;
    expect(set).toMatch(/^__Host-xllm_session=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    const cookie = `${SESSION_COOKIE}=${cookieValue(res, SESSION_COOKIE)}`;
    // A reload: the page has only the cookie, not the token.
    expect(await (await send(null, "/auth/me", { headers: { cookie } })).json()).toEqual({ admin: true });
    expect((await send(null, "/admin/systems", { headers: { cookie } })).status).toBe(200);
    // Works without xDev ID set up.
    expect((await send(null, "/admin/systems", { headers: { cookie } }, { CONSOLE_EMAILS: "", OIDC_CLIENT_ID: "" })).status).toBe(200);
  });

  it("stores neither the admin token nor the session token", async () => {
    const res = await tokenSignIn(ADMIN_TOKEN);
    const session = cookieValue(res, SESSION_COOKIE)!;
    const rows = JSON.stringify((await env.DB.prepare("SELECT * FROM console_session").all()).results);
    expect(rows).not.toContain(ADMIN_TOKEN);
    expect(rows).not.toContain(session);
    expect(rows).not.toContain(env.ADMIN_TOKEN_SHA256!);
    expect(rows).toContain(await sha256hex(session));
  });

  it("refuses a wrong token, a missing token and a cross-site request", async () => {
    const wrong = await tokenSignIn("nope");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.getSetCookie()).toEqual([]);
    expect((await send(null, "/auth/token", { method: "POST", headers: { origin: BASE } })).status).toBe(401);
    expect((await tokenSignIn(ADMIN_TOKEN, {})).status).toBe(403);
    expect((await tokenSignIn(ADMIN_TOKEN, { origin: "https://evil.test" })).status).toBe(403);
    expect((await tokenSignIn(ADMIN_TOKEN, { origin: BASE }, { ADMIN_TOKEN_SHA256: undefined })).status).toBe(401);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM console_session").first<{ n: number }>())?.n).toBe(0);
  });

  it("ends when the admin token changes or is removed, or the session expires", async () => {
    const cookie = `${SESSION_COOKIE}=${cookieValue(await tokenSignIn(ADMIN_TOKEN), SESSION_COOKIE)}`;
    const other = await sha256hex("another-admin-token");
    expect((await send(null, "/admin/systems", { headers: { cookie } }, { ADMIN_TOKEN_SHA256: other })).status).toBe(401);
    expect((await send(null, "/auth/me", { headers: { cookie } }, { ADMIN_TOKEN_SHA256: undefined })).status).toBe(401);
    await env.DB.prepare("UPDATE console_session SET expires_at = 1").run();
    expect((await send(null, "/admin/systems", { headers: { cookie } })).status).toBe(401);
  });

  it("sign-out ends it like an xDev ID session", async () => {
    const cookie = `${SESSION_COOKIE}=${cookieValue(await tokenSignIn(ADMIN_TOKEN), SESSION_COOKIE)}`;
    expect((await send(null, "/auth/logout", { method: "POST", headers: { cookie, origin: BASE } })).status).toBe(204);
    expect((await send(null, "/admin/systems", { headers: { cookie } })).status).toBe(401);
  });
});

describe("access granted by xDev ID", () => {
  const MEMBER: User = { sub: "u-2", email: "member@example.com", email_verified: true, name: "Member" };

  it("lets in a user xDev ID gives a role for this client, with no access list at all", async () => {
    const cookie = await signIn(MEMBER, { info: { xdev_role: "member" } }, { CONSOLE_EMAILS: "" });
    expect(await (await send(null, "/auth/me", { headers: { cookie } }, { CONSOLE_EMAILS: "" })).json()).toEqual({ email: "member@example.com", name: "Member" });
    expect((await send(null, "/admin/systems", { headers: { cookie } }, { CONSOLE_EMAILS: "" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT access FROM console_session").first("access")).toBe("id");
  });

  it("refuses an empty or non-text role, and a role without a verified email", async () => {
    for (const [user, info] of [
      [MEMBER, { xdev_role: "" }],
      [MEMBER, { xdev_role: true }],
      [MEMBER, { xdev_role: ["member"] }],
      [{ ...MEMBER, email_verified: false }, { xdev_role: "member" }],
    ] as const) {
      const idp = fakeIdp(user, { info });
      const { state, loginCookie } = await login(idp);
      expect((await callback(idp, state, loginCookie)).headers.get("location"), JSON.stringify(info)).toBe("/?signin_error=not_allowed");
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM console_session").first("n")).toBe(0);
  });

  it("an email on the list still gets in without a role, and its session follows the list", async () => {
    const cookie = await signIn();
    expect(await env.DB.prepare("SELECT access FROM console_session").first("access")).toBe("list");
    expect((await send(null, "/admin/systems", { headers: { cookie } }, { CONSOLE_EMAILS: "" })).status).toBe(401);
  });

  it("a session xDev ID granted ends when sign-in moves to another client", async () => {
    const cookie = await signIn(MEMBER, { info: { xdev_role: "admin" } });
    expect((await send(null, "/admin/systems", { headers: { cookie } })).status).toBe(200);
    expect((await send(null, "/admin/systems", { headers: { cookie } }, { OIDC_CLIENT_ID: "another-client" })).status).toBe(401);
  });
});

describe("xDev ID sign-in set in Settings", () => {
  const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const json = { ...admin, "content-type": "application/json" };
  const put = (body: unknown, bindings: Partial<Env> = {}) => send(null, "/admin/sso", { method: "PUT", headers: json, body: JSON.stringify(body) }, bindings);
  const get = async (bindings: Partial<Env> = {}) => (await send(null, "/admin/sso", { headers: admin }, bindings)).json();
  const NEW = { issuer: "https://id2.test/api/auth", client_id: "router-2", secret: "saved-secret-value" };
  const NO_ENV = { OIDC_ISSUER: undefined, OIDC_CLIENT_ID: undefined, OIDC_CLIENT_SECRET: undefined };
  const NEW_USER: User = { sub: "u-3", email: "new@example.com", email_verified: true, name: "New" };

  it("shows the environment's configuration without its secret", async () => {
    const res = await send(null, "/admin/sso", { headers: admin });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toEqual({ source: "env", issuer: ISSUER, client_id: CLIENT, secret_set: true, redirect_uri: `${BASE}/auth/callback` });
    expect(await get(NO_ENV)).toEqual({ source: "none", issuer: "", client_id: "", secret_set: false, redirect_uri: `${BASE}/auth/callback` });
  });

  it("saves a configuration with its secret sealed, and sign-in uses it over the environment", async () => {
    const res = await put({ ...NEW, issuer: `${NEW.issuer}/` });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(NEW.secret);
    expect(JSON.parse(text)).toEqual({ source: "settings", issuer: NEW.issuer, client_id: NEW.client_id, secret_set: true, redirect_uri: `${BASE}/auth/callback` });
    const stored = await env.DB.prepare("SELECT value FROM setting WHERE key = 'sso'").first<{ value: string }>();
    expect(stored?.value).not.toContain(NEW.secret);
    expect(JSON.parse(stored!.value).secret).toMatch(/^v1\./);

    const idp = fakeIdp(NEW_USER, { issuer: NEW.issuer, client: NEW.client_id, secret: NEW.secret, info: { xdev_role: "member" } });
    const { loc, state, loginCookie } = await login(idp, NO_ENV);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${NEW.issuer}/oauth2/authorize`);
    expect(loc.searchParams.get("client_id")).toBe(NEW.client_id);
    expect((await callback(idp, state, loginCookie, "", NO_ENV)).headers.get("location")).toBe("/#/systems");
    expect(await (await send(null, "/auth/me", {}, NO_ENV)).json()).toEqual({ error: "unauthorized", sso: true });
    expect((await (await send(null, "/admin/settings/info", { headers: admin }, NO_ENV)).json<{ oidc: boolean }>()).oidc).toBe(true);
  });

  it("keeps the current secret when none is sent, and needs one when there is none", async () => {
    expect((await put({ issuer: NEW.issuer, client_id: NEW.client_id })).status).toBe(200);
    // The environment's secret was kept.
    const idp = fakeIdp(OWNER, { issuer: NEW.issuer, client: NEW.client_id });
    const { state, loginCookie } = await login(idp, NO_ENV);
    expect((await callback(idp, state, loginCookie, "", NO_ENV)).headers.get("location")).toBe("/#/systems");

    await send(null, "/admin/sso", { method: "DELETE", headers: admin });
    const res = await put({ issuer: NEW.issuer, client_id: NEW.client_id, secret: "  " }, NO_ENV);
    expect(res.status).toBe(400);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM setting WHERE key = 'sso'").first("n")).toBe(0);
  });

  it("refuses an issuer that is not plain https, an empty client ID and a bad secret", async () => {
    for (const body of [
      { ...NEW, issuer: "http://id2.test/api/auth" },
      { ...NEW, issuer: "https://id2.test/api/auth?x=1" },
      { ...NEW, issuer: "https://id2.test/api/auth#x" },
      { ...NEW, issuer: "not a url" },
      { ...NEW, client_id: " " },
      { ...NEW, client_id: "x".repeat(201) },
      { ...NEW, secret: "x".repeat(4097) },
      { ...NEW, secret: 5 },
    ]) {
      expect((await put(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM setting WHERE key = 'sso'").first("n")).toBe(0);
  });

  it("cannot store a secret without CONNECTIONS_KEY", async () => {
    expect((await put(NEW, { CONNECTIONS_KEY: undefined })).status).toBe(409);
  });

  it("removing the saved configuration goes back to the environment", async () => {
    await put(NEW);
    const res = await send(null, "/admin/sso", { method: "DELETE", headers: admin });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { source: string }).source).toBe("env");
    const { loc } = await login(fakeIdp(OWNER));
    expect(loc.searchParams.get("client_id")).toBe(CLIENT);
  });

  it("is for signed-in owners only, and writes need the console's own pages", async () => {
    expect((await send(null, "/admin/sso")).status).toBe(401);
    expect((await send(null, "/admin/sso", { method: "PUT", body: JSON.stringify(NEW) })).status).toBe(401);
    const cookie = await signIn();
    const headers = { cookie, "content-type": "application/json" };
    expect((await send(null, "/admin/sso", { method: "PUT", headers, body: JSON.stringify(NEW) })).status).toBe(403);
    expect((await send(null, "/admin/sso", { method: "PUT", headers: { ...headers, origin: BASE }, body: JSON.stringify(NEW) })).status).toBe(200);
  });

  it("ends sessions xDev ID granted when the client changes", async () => {
    const cookie = await signIn({ ...OWNER, email: "member@example.com" }, { info: { xdev_role: "member" } });
    expect((await send(null, "/admin/systems", { headers: { cookie } })).status).toBe(200);
    await put(NEW);
    expect((await send(null, "/admin/systems", { headers: { cookie } })).status).toBe(401);
  });
});
