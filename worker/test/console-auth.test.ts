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

/** A fake xDev ID: remembers the authorize request, checks the token request like a real provider would. */
function fakeIdp(user: User, tweak: { claims?: Record<string, unknown>; tokenStatus?: number } = {}) {
  const idp = {
    challenge: "",
    nonce: "",
    code: `code-${crypto.randomUUID()}`,
    calls: [] as string[],
    fn: async (req: Request): Promise<Response> => {
      idp.calls.push(new URL(req.url).pathname);
      if (req.url === `${ISSUER}/oauth2/token`) {
        if (req.headers.get("authorization") !== `Basic ${btoa(`${CLIENT}:${SECRET}`)}`) return new Response("{}", { status: 401 });
        const form = new URLSearchParams(await req.text());
        if (form.get("code") !== idp.code || (await s256(form.get("code_verifier") ?? "")) !== idp.challenge) {
          return new Response('{"error":"invalid_grant"}', { status: 400 });
        }
        if (form.get("redirect_uri") !== `${BASE}/auth/callback`) return new Response("{}", { status: 400 });
        if (tweak.tokenStatus) return new Response("{}", { status: tweak.tokenStatus });
        const claims = { iss: ISSUER, aud: CLIENT, sub: user.sub, nonce: idp.nonce, exp: Math.floor(Date.now() / 1000) + 600, ...tweak.claims };
        return Response.json({ access_token: "at-1", token_type: "Bearer", id_token: fakeJwt(claims) });
      }
      if (req.url === `${ISSUER}/oauth2/userinfo`) {
        if (req.headers.get("authorization") !== "Bearer at-1") return new Response("{}", { status: 401 });
        return Response.json(user);
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
async function login(idp: Idp) {
  const res = await send(idp, "/auth/login");
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  idp.challenge = loc.searchParams.get("code_challenge")!;
  idp.nonce = loc.searchParams.get("nonce")!;
  return { loc, state: loc.searchParams.get("state")!, loginCookie: cookieValue(res, LOGIN_COOKIE)! };
}

async function callback(idp: Idp, state: string, loginCookie: string | null, extra = "") {
  return send(idp, `/auth/callback?code=${idp.code}&state=${encodeURIComponent(state)}${extra}`, {
    headers: loginCookie === null ? {} : { cookie: `${LOGIN_COOKIE}=${loginCookie}` },
  });
}

/** Full sign-in; returns the console session cookie header. */
async function signIn(user = OWNER) {
  const idp = fakeIdp(user);
  const { state, loginCookie } = await login(idp);
  const res = await callback(idp, state, loginCookie);
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
    for (const b of [{ OIDC_CLIENT_SECRET: undefined }, { OIDC_CLIENT_ID: "" }, { CONSOLE_EMAILS: " , " }]) {
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
  });
});
