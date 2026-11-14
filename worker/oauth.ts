import type { Env } from "./env";
import { open, seal } from "./secret-box";

/**
 * Subscription logins. Two kinds of flow:
 *
 * - `pkce`: authorization code with PKCE. The provider sends the browser back to a fixed local address of the
 *   vendor's CLI. That only reaches the gateway when it runs on the user's machine with the port mapped to it;
 *   anywhere else the browser ends on a page that does not load, and the user pastes its address (or the code the
 *   provider's page shows) into the console.
 * - `device`: device authorization (RFC 8628). The console shows a code, the user enters it on the provider's
 *   page, and the console polls until the provider hands the tokens over. No callback at all.
 *
 * Every provider here is signed in with the public client id of the vendor's own CLI or editor plugin. Using a
 * subscription outside the vendor's own apps may be against its terms; the account can be limited or closed.
 */

type Fetch = (req: Request) => Promise<Response>;

/** What is sealed in `connection.secret`. `refresh_token`: what renews the access token (for GitHub, the GitHub token). */
export interface Tokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

/** A sign-in's outcome before it is stored: the tokens and who signed in. */
export interface Grant {
  tokens: Tokens;
  /** Null: the provider gives no expiry (Kilo Code); the token is used until it is refused. */
  expiresAt: number | null;
  /** The account (organization, team) the person signed in to; with `subject`, what makes a connection the same one. */
  account: string | null;
  subject: string | null;
  name: string;
}

export type Renewal = { ok: true; tokens: Tokens; expiresAt: number | null } | { ok: false; refused: boolean; reason: string };

interface CommonDef {
  clientId: string;
  tokenUrl: string;
  /** Refresh when the access token has less than this many seconds left. */
  refreshLeadS: number;
  /** How a refresh-token grant is sent (when `renew` is not given). */
  refreshBody: "json" | "form";
  /** Who signed in, from the token answer. Default: no account, named "Account". */
  identity?: (answer: Record<string, unknown>) => Omit<Grant, "tokens" | "expiresAt">;
  /** Turns the token answer into a grant when it takes more than the answer (GitHub: a Copilot token, the user). */
  granted?: (answer: Record<string, unknown>, upstream: Fetch, now: number) => Promise<Grant | { error: string }>;
  /** Renews the access token when a refresh-token grant is not how this provider does it. */
  renew?: (tokens: Tokens, upstream: Fetch, now: number) => Promise<Renewal>;
  /**
   * Headers the provider wants on the sign-in's own calls (`account` null) and on chat requests (the connection's
   * account): Kimi its device headers, Kilo Code the organization.
   */
  headers?: (env: Env, account: string | null) => Promise<Record<string, string>>;
  /**
   * The client id and secret come from these variables, not from `clientId` (Google: no secret is kept in the
   * code). While either is unset the provider is unavailable: no sign-in starts and no token is renewed.
   */
  clientEnv?: readonly [id: keyof Env, secret: keyof Env];
}

export interface PkceDef extends CommonDef {
  flow: "pkce";
  authorizeUrl: string;
  scope: string;
  redirectUri: string;
  extra: Record<string, string>;
  /** How the code is traded: Codex a form, Claude JSON with the state. */
  exchange: "form" | "json";
}

/** What a device sign-in's start gives: the code the provider polls with, and what the user needs. */
export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  page: string;
  complete?: string;
  interval: number;
  expiresIn: number;
}

/** One poll's outcome. `final`: the sign-in is over (denied, expired); otherwise the user can poll again. */
export type DevicePoll = { pending: number } | { answer: Record<string, unknown> } | { refused: string; final: boolean };

export interface DeviceDef extends CommonDef {
  flow: "device";
  deviceUrl: string;
  /** Empty: no scope is sent (Kimi sends the client id only). */
  scope: string;
  /** The page to send the user to when the provider's answer names none; `?user_code=` is added for the direct link. */
  page?: string;
  /** Asks for the codes, when this provider does not do it the RFC 8628 way (a form POST to `deviceUrl`). */
  start?: (upstream: Fetch) => Promise<DeviceStart | { error: string }>;
  /** One poll, when this provider does not do it the RFC 8628 way (a form POST to `tokenUrl`). May throw when unreachable. */
  poll?: (upstream: Fetch, deviceCode: string) => Promise<DevicePoll>;
}

export type OAuthDef = PkceDef | DeviceDef;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

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

/** What a provider's error answer says, without anything it should not: its description, its code, or the status. */
async function refusal(res: Response): Promise<string> {
  const b = obj(await res.json().catch(() => null));
  const e = b.error;
  if (typeof b.error_description === "string") return b.error_description;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  if (typeof b.message === "string") return b.message;
  return `sign-in service answered ${res.status}`;
}

const expiry = (now: number, expiresIn: unknown) => now + (typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600);

// --- GitHub Copilot: a GitHub token (device flow) that buys short-lived Copilot tokens. ---

/** The headers Copilot's endpoints expect from VS Code's Copilot Chat; also sent with chat requests (providers.ts). */
export const COPILOT_HEADERS: Readonly<Record<string, string>> = {
  "copilot-integration-id": "vscode-chat",
  "editor-version": "vscode/1.110.0",
  "editor-plugin-version": "copilot-chat/0.38.0",
  "user-agent": "GitHubCopilotChat/0.38.0",
  "openai-intent": "conversation-panel",
  "x-github-api-version": "2025-04-01",
};

async function copilotToken(githubToken: string, upstream: Fetch): Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; refused: boolean; reason: string }> {
  let res: Response;
  try {
    res = await upstream(
      new Request("https://api.github.com/copilot_internal/v2/token", { headers: { authorization: `token ${githubToken}`, accept: "application/json", ...COPILOT_HEADERS } }),
    );
  } catch {
    return { ok: false, refused: false, reason: "could not reach it" };
  }
  // 401: the GitHub token no longer works. 403: the account has no Copilot.
  if (res.status === 401 || res.status === 403) return { ok: false, refused: true, reason: await refusal(res) };
  if (!res.ok) return { ok: false, refused: false, reason: `it answered ${res.status}` };
  const b = obj(await res.json().catch(() => null));
  const token = str(b.token);
  if (!token) return { ok: false, refused: false, reason: "it sent no token" };
  const now = Math.floor(Date.now() / 1000);
  const at = typeof b.expires_at === "number" && b.expires_at > now ? b.expires_at : now + 1500;
  return { ok: true, token, expiresAt: at };
}

const githubGranted: CommonDef["granted"] = async (answer, upstream) => {
  const github = str(answer.access_token);
  if (!github) return { error: "the sign-in service sent no token" };
  const copilot = await copilotToken(github, upstream);
  if (!copilot.ok) return { error: copilot.refused ? `GitHub refused a Copilot token: ${copilot.reason}` : `could not get a Copilot token: ${copilot.reason}` };
  let user: Record<string, unknown> = {};
  try {
    const res = await upstream(new Request("https://api.github.com/user", { headers: { authorization: `token ${github}`, accept: "application/json", "user-agent": COPILOT_HEADERS["user-agent"]! } }));
    if (res.ok) user = obj(await res.json().catch(() => null));
  } catch {
    // The connection is still good; it is named generically.
  }
  const id = typeof user.id === "number" || typeof user.id === "string" ? String(user.id) : null;
  const name = (str(user.email) ?? str(user.login) ?? "GitHub account").slice(0, 100);
  return { tokens: { access_token: copilot.token, refresh_token: github }, expiresAt: copilot.expiresAt, account: id, subject: id, name };
};

const githubRenew: CommonDef["renew"] = async (tokens, upstream) => {
  if (!tokens.refresh_token) return { ok: false, refused: true, reason: "no GitHub token is stored" };
  const copilot = await copilotToken(tokens.refresh_token, upstream);
  return copilot.ok ? { ok: true, tokens: { access_token: copilot.token, refresh_token: tokens.refresh_token }, expiresAt: copilot.expiresAt } : copilot;
};

// --- Kimi Code: device code at auth.kimi.com; every call names the device it comes from. ---

/**
 * One device id for this gateway, as the Kimi CLI keeps one per machine: an HMAC of a fixed label under
 * CONNECTIONS_KEY, so it needs no storage and stays the same for the sign-in, renewals and chat. It says nothing
 * about the key.
 */
async function kimiDeviceId(env: Env): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(env.CONNECTIONS_KEY || "unset"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode("ai-router kimi device id")));
  const hex = [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The `X-Msh-*` headers Kimi's sign-in and coding API read (names from an open-source client, not checked against the service; values are this gateway's). */
const kimiHeaders: CommonDef["headers"] = async (env) => ({
  "X-Msh-Platform": "ai-router",
  "X-Msh-Version": "1.0.0",
  "X-Msh-Device-Name": "ai-router",
  "X-Msh-Device-Model": "Cloudflare Worker",
  "X-Msh-Device-Id": await kimiDeviceId(env),
});

// --- Kilo Code: its own device flow (a code, then a GET per poll); one long-lived token, no refresh. ---

const KILO_API = "https://api.kilo.ai";
const KILO_CODES = `${KILO_API}/api/device-auth/codes`;

const kiloStart: DeviceDef["start"] = async (upstream) => {
  let res: Response;
  try {
    res = await upstream(new Request(KILO_CODES, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" } }));
  } catch {
    return { error: "could not reach the sign-in service" };
  }
  if (res.status === 429) return { error: "too many sign-ins are waiting at Kilo Code; try again in a few minutes" };
  if (!res.ok) return { error: await refusal(res) };
  const b = obj(await res.json().catch(() => null));
  const code = str(b.code);
  const page = str(b.verificationUrl);
  if (!code || !page) return { error: "the sign-in service sent no code" };
  return { deviceCode: code, userCode: code, page, complete: page, interval: 3, expiresIn: typeof b.expiresIn === "number" && b.expiresIn > 0 ? b.expiresIn : 300 };
};

const kiloPoll: DeviceDef["poll"] = async (upstream, code) => {
  const res = await upstream(new Request(`${KILO_CODES}/${encodeURIComponent(code)}`, { headers: { accept: "application/json" } }));
  if (res.status === 202) return { pending: 3 };
  if (res.status === 403) return { refused: "the sign-in was denied", final: true };
  if (res.status === 410) return { refused: "the code expired; start again", final: true };
  if (res.status >= 500) return { refused: `the sign-in service answered ${res.status}`, final: false };
  if (!res.ok) return { refused: await refusal(res), final: true };
  const b = obj(await res.json().catch(() => null));
  return b.status === "approved" && str(b.token) ? { answer: b } : { pending: 3 };
};

/** The Kilo Code profile with `token`: its answer, or why not. */
async function kiloProfile(token: string, upstream: Fetch): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; refused: boolean; reason: string }> {
  let res: Response;
  try {
    res = await upstream(new Request(`${KILO_API}/api/profile`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } }));
  } catch {
    return { ok: false, refused: false, reason: "could not reach it" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, refused: true, reason: await refusal(res) };
  if (!res.ok) return { ok: false, refused: false, reason: `it answered ${res.status}` };
  return { ok: true, body: obj(await res.json().catch(() => null)) };
}

/** A JWT's `exp` when it is one and still ahead; Kilo Code's token may carry none. */
const jwtExpiry = (token: string, now: number): number | null => {
  const exp = claims(token).exp;
  return typeof exp === "number" && exp > now ? exp : null;
};

const kiloGranted: CommonDef["granted"] = async (answer, upstream, now) => {
  const token = str(answer.token);
  if (!token) return { error: "the sign-in service sent no token" };
  const profile = await kiloProfile(token, upstream);
  const body = profile.ok ? profile.body : {};
  const orgs = Array.isArray(body.organizations) ? body.organizations : [];
  const email = str(answer.userEmail) ?? str(body.email);
  // The organization is the account (it goes with every chat request); a personal account has none.
  return { tokens: { access_token: token }, expiresAt: jwtExpiry(token, now), account: str(obj(orgs[0]).id), subject: email, name: (email ?? "Kilo Code account").slice(0, 100) };
};

/** Kilo Code has no refresh: "renewing" checks the token against the profile, so a refused one says to sign in again. */
const kiloRenew: CommonDef["renew"] = async (tokens, upstream, now) => {
  const p = await kiloProfile(tokens.access_token, upstream);
  return p.ok ? { ok: true, tokens, expiresAt: jwtExpiry(tokens.access_token, now) } : p;
};

// --- Muse Code (Meta): a Meta device code that buys one Muse Code key; no refresh. ---

const MUSE_KEY_URL = "https://api.meta.ai/muse-code/key";
/** The API version Muse Code's sign-in, key and chat calls send (from an open-source client, not checked against the service). */
export const MUSE_HEADERS: Readonly<Record<string, string>> = { "x-api-version": "1.0.0" };

/** The Meta token buys the subscription's key (one call); only the key is kept. */
const museGranted: CommonDef["granted"] = async (answer, upstream) => {
  const access = str(answer.access_token);
  if (!access) return { error: "the sign-in service sent no token" };
  let res: Response;
  try {
    res = await upstream(
      new Request(MUSE_KEY_URL, {
        method: "POST",
        headers: { ...MUSE_HEADERS, authorization: `Bearer ${access}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ onboard: true }),
      }),
    );
  } catch {
    return { error: "could not reach Muse Code" };
  }
  const b = obj(await res.clone().json().catch(() => null));
  if (!res.ok) return { error: str(b.detail) ?? str(b.title) ?? (await refusal(res)) };
  if (b.is_subs_active === false) return { error: "the Muse subscription is inactive" };
  const key = str(b.api_key);
  if (!key) {
    const action = str(b.action_url);
    return { error: `a Muse subscription is required${action ? `: ${action}` : ""}` };
  }
  const email = str(b.user_email)?.trim().toLowerCase() || null;
  // No expiry and no refresh: the key is used until Muse refuses it, then the user signs in again.
  return { tokens: { access_token: key }, expiresAt: null, account: null, subject: email, name: (email ?? "Muse account").slice(0, 100) };
};

// --- Nous Portal: device code (Hermes CLI's client); the access token buys short-lived agent keys. ---

const NOUS_PORTAL = "https://portal.nousresearch.com";
const NOUS_TOKEN_URL = `${NOUS_PORTAL}/api/oauth/token`;

/** An agent key's end: `expires_at` (ISO date, or epoch seconds or milliseconds), else `expires_in`. */
function agentKeyExpiry(b: Record<string, unknown>, now: number): number | null {
  const at = b.expires_at;
  if (typeof at === "number" && at > 0) return at < 1e12 ? Math.floor(at) : Math.floor(at / 1000);
  if (typeof at === "string") {
    const ms = Date.parse(at);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return typeof b.expires_in === "number" && b.expires_in > 0 ? now + b.expires_in : null;
}

/** An agent key bought with `access`, or null when none could be (the access token is used instead, as Nous's own client does). */
async function nousAgentKey(access: string, upstream: Fetch, now: number): Promise<{ key: string; expiresAt: number | null } | null> {
  try {
    const res = await upstream(
      new Request(`${NOUS_PORTAL}/api/oauth/agent-key`, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ min_ttl_seconds: 7200 }),
      }),
    );
    if (!res.ok) return null;
    const b = obj(await res.json().catch(() => null));
    const key = str(b.api_key);
    return key ? { key, expiresAt: agentKeyExpiry(b, now) } : null;
  } catch {
    return null;
  }
}

/** The tokens to keep: the agent key (or the access token) to send, the refresh token to renew both. */
async function nousTokens(access: string, refresh: string, expiresIn: unknown, upstream: Fetch, now: number): Promise<{ tokens: Tokens; expiresAt: number }> {
  const agent = await nousAgentKey(access, upstream, now);
  return { tokens: { access_token: agent?.key ?? access, refresh_token: refresh }, expiresAt: agent?.expiresAt ?? expiry(now, expiresIn) };
}

const nousGranted: CommonDef["granted"] = async (answer, upstream, now) => {
  const access = str(answer.access_token);
  const refresh = str(answer.refresh_token);
  if (!access || !refresh) return { error: "the sign-in service sent no tokens" };
  return { ...(await nousTokens(access, refresh, answer.expires_in, upstream, now)), account: null, subject: str(claims(access).sub), name: "Nous account" };
};

/** A refresh grant (with the `x-nous-refresh-token` header Nous's client sends), then a new agent key. */
const nousRenew: CommonDef["renew"] = async (t, upstream, now) => {
  if (!t.refresh_token) return { ok: false, refused: true, reason: "no refresh token is stored" };
  let res: Response;
  try {
    res = await upstream(post(NOUS_TOKEN_URL, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: "hermes-cli" }, "form", { "x-nous-refresh-token": t.refresh_token }));
  } catch {
    return { ok: false, refused: false, reason: "could not reach it" };
  }
  if (res.status === 400 || res.status === 401) return { ok: false, refused: true, reason: await refusal(res) };
  if (!res.ok) return { ok: false, refused: false, reason: `it answered ${res.status}` };
  const b = obj(await res.json().catch(() => null));
  const access = str(b.access_token);
  if (!access) return { ok: false, refused: false, reason: "it sent no token" };
  return { ok: true, ...(await nousTokens(access, str(b.refresh_token) ?? t.refresh_token, b.expires_in, upstream, now)) };
};

// --- MiniMax Code: device code with PKCE at MiniMax's account host (China or international); single-use refresh tokens. ---

const MINIMAX_CLIENT = "mcode-public";
const MINIMAX_SCOPE = { scope: "agent.default", audience: "agent-backend" } as const;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/**
 * Asks for the codes with a PKCE challenge. What the poll needs (the code to poll with, whether it is the user
 * code, the verifier) is kept as one value, the one `pollLogin` hands back. MiniMax states times in odd units:
 * `expired_in` in seconds or as an epoch in milliseconds; `interval` in milliseconds when it sends no device code.
 */
const minimaxStart =
  (host: string): DeviceDef["start"] =>
  async (upstream) => {
    const verifier = random(64);
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    let res: Response;
    try {
      res = await upstream(post(`${host}/oauth2/device/code`, { client_id: MINIMAX_CLIENT, ...MINIMAX_SCOPE, code_challenge: challenge, code_challenge_method: "S256" }, "form"));
    } catch {
      return { error: "could not reach the sign-in service" };
    }
    if (!res.ok) return { error: await refusal(res) };
    const b = obj(await res.json().catch(() => null));
    const userCode = str(b.user_code);
    const deviceCode = str(b.device_code);
    const page = str(b.verification_uri_complete) ?? str(b.verification_uri) ?? str(b.verification_url);
    if (!userCode || !page) return { error: "the sign-in service sent no code" };
    // No device code: MiniMax's variant, polled with the user code.
    const byUser = !deviceCode;
    const expiredIn = num(b.expired_in);
    const expiresIn = num(b.expires_in) ?? (expiredIn === null ? PENDING_TTL_S : expiredIn < 1e12 ? expiredIn : Math.max(1, Math.ceil((expiredIn - Date.now()) / 1000)));
    const every = num(b.interval);
    const interval = every === null ? 5 : byUser && every >= 60 ? Math.round(every / 1000) : every;
    const complete = str(b.verification_uri_complete);
    return { deviceCode: JSON.stringify({ c: deviceCode ?? userCode, u: byUser, v: verifier }), userCode, page, ...(complete ? { complete } : {}), interval, expiresIn };
  };

/** One poll: MiniMax answers 200 with `status` (pending, slow_down, denied, expired), or a standard OAuth `error`. */
const minimaxPoll =
  (host: string): DeviceDef["poll"] =>
  async (upstream, kept) => {
    let k: Record<string, unknown>;
    try {
      k = obj(JSON.parse(kept));
    } catch {
      k = {};
    }
    const code = str(k.c);
    const verifier = str(k.v);
    if (!code || !verifier) return { refused: "this sign-in cannot go on; start again", final: true };
    const res = await upstream(
      post(`${host}/oauth2/token`, { grant_type: DEVICE_GRANT, ...(k.u === true ? { user_code: code } : { device_code: code }), client_id: MINIMAX_CLIENT, code_verifier: verifier }, "form"),
    );
    const b = obj(await res.clone().json().catch(() => null));
    const status = str(b.status);
    if (status === "pending") return { pending: 5 };
    if (status === "slow_down") return { pending: 10 };
    if (status === "denied" || status === "access_denied") return { refused: "the sign-in was denied", final: true };
    if (status === "expired" || status === "expired_token") return { refused: "the code expired; start again", final: true };
    if (status) return { refused: "the sign-in service answered an unknown status", final: true };
    const error = str(b.error);
    if (error === "authorization_pending") return { pending: 5 };
    if (error === "slow_down") return { pending: 10 };
    if (res.status >= 500) return { refused: `the sign-in service answered ${res.status}`, final: false };
    if (error || !res.ok) return { refused: await refusal(res), final: true };
    return str(b.access_token) ? { answer: b } : { refused: "the sign-in service sent no token", final: true };
  };

const minimaxGranted: CommonDef["granted"] = async (answer, _upstream, now) => {
  const access = str(answer.access_token);
  if (!access) return { error: "the sign-in service sent no token" };
  const refresh = str(answer.refresh_token);
  return {
    tokens: { access_token: access, ...(refresh ? { refresh_token: refresh } : {}) },
    expiresAt: expiry(now, answer.expires_in),
    account: null,
    // Not a JWT: no subject, and each sign-in is a connection of its own.
    subject: str(claims(access).sub),
    name: "MiniMax Code account",
  };
};

/** MiniMax's refresh grant: a form with the scope and audience. Its refresh tokens are single use. */
const minimaxRenew =
  (host: string): CommonDef["renew"] =>
  async (t, upstream, now) => {
    if (!t.refresh_token) return { ok: false, refused: true, reason: "no refresh token is stored" };
    let res: Response;
    try {
      res = await upstream(post(`${host}/oauth2/token`, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: MINIMAX_CLIENT, ...MINIMAX_SCOPE }, "form"));
    } catch {
      return { ok: false, refused: false, reason: "could not reach it" };
    }
    if (res.status === 400 || res.status === 401) return { ok: false, refused: true, reason: await refusal(res) };
    const b = obj(await res.clone().json().catch(() => null));
    if (!res.ok || str(b.error)) return { ok: false, refused: false, reason: res.ok ? await refusal(res) : `it answered ${res.status}` };
    const access = str(b.access_token);
    if (!access) return { ok: false, refused: false, reason: "it sent no token" };
    return { ok: true, tokens: { access_token: access, refresh_token: str(b.refresh_token) ?? t.refresh_token }, expiresAt: expiry(now, b.expires_in) };
  };

/** The headers MiniMax Code's agent gateway reads (from an open-source client, not checked against the service; `x-api-key` is its fixed placeholder). */
const minimaxHeaders: CommonDef["headers"] = async (): Promise<Record<string, string>> => ({
  "user-agent": "MiniMaxAgent",
  "x-mavis-agent-id": "main",
  "x-api-key": "sk-xxx",
  "x-mavis-timezone-offset": "0",
  "x-mavis-session-id": crypto.randomUUID(),
});

/**
 * MiniMax Code at `host` (account.minimax.cn, account.minimax.io): the MiniMax Code CLI's device sign-in (values
 * from an open-source client, not checked against the service). MiniMax's terms may not allow the subscription to be used outside its own tools.
 */
const minimaxCode = (host: string): DeviceDef => ({
  flow: "device",
  clientId: MINIMAX_CLIENT,
  deviceUrl: `${host}/oauth2/device/code`,
  tokenUrl: `${host}/oauth2/token`,
  scope: MINIMAX_SCOPE.scope,
  refreshBody: "form",
  refreshLeadS: 600,
  start: minimaxStart(host),
  poll: minimaxPoll(host),
  granted: minimaxGranted,
  renew: minimaxRenew(host),
  headers: minimaxHeaders,
});

// --- Google (Gemini CLI, Antigravity): Google sign-in, then the account's Gemini Code Assist project. ---

const CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal";
/** What the Code Assist calls say about the client (IDE type, platform unspecified, plugin type; values from an open-source client). */
export const CODE_ASSIST_METADATA = { ideType: 9, platform: 0, pluginType: 2 } as const;
/** Antigravity's own headers on its Code Assist calls (values from an open-source client, not checked against the service). */
export const ANTIGRAVITY_HEADERS: Readonly<Record<string, string>> = { "user-agent": "antigravity/hub/2.24.0 darwin/arm64", "x-request-source": "local" };
const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"];

/**
 * After Google's token answer: who signed in (userinfo) and the Code Assist project (loadCodeAssist), which is the
 * connection's account and goes with every request. Antigravity also asks once to be onboarded to its default tier.
 */
const googleGranted =
  (antigravity: boolean): CommonDef["granted"] =>
  async (answer, upstream, now) => {
    const access = str(answer.access_token);
    const refresh = str(answer.refresh_token);
    if (!access || !refresh) return { error: "the sign-in service sent no tokens" };
    const own = antigravity ? ANTIGRAVITY_HEADERS : {};
    const auth = { authorization: `Bearer ${access}` };
    let user: Record<string, unknown> = {};
    try {
      const r = await upstream(new Request("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", { headers: { ...auth, ...(antigravity ? { "x-request-source": "local" } : {}) } }));
      if (r.ok) user = obj(await r.json().catch(() => null));
    } catch {
      // The name is only a label: the project is what matters.
    }
    const json = { ...own, ...auth, "content-type": "application/json" };
    let load: Record<string, unknown>;
    try {
      const r = await upstream(
        new Request(`${CODE_ASSIST}:loadCodeAssist`, { method: "POST", headers: json, body: JSON.stringify(antigravity ? { metadata: CODE_ASSIST_METADATA } : { metadata: CODE_ASSIST_METADATA, mode: 1 }) }),
      );
      if (!r.ok) return { error: `Gemini Code Assist answered ${r.status}: ${await refusal(r)}` };
      load = obj(await r.json().catch(() => null));
    } catch {
      return { error: "could not reach Gemini Code Assist" };
    }
    const p = load.cloudaicompanionProject;
    const project = str(obj(p).id) ?? str(p);
    if (!project) return { error: "this Google account has no Gemini Code Assist project: set one up in Gemini CLI or Antigravity first" };
    if (antigravity) {
      const tiers = Array.isArray(load.allowedTiers) ? load.allowedTiers.map(obj) : [];
      const tierId = str(tiers.find((t) => t.isDefault === true)?.id)?.trim() ?? "legacy-tier";
      // Other clients retry this until it reports done; one call here, its answer not needed for the sign-in.
      await upstream(new Request(`${CODE_ASSIST}:onboardUser`, { method: "POST", headers: json, body: JSON.stringify({ tierId, metadata: CODE_ASSIST_METADATA }) })).catch(() => null);
    }
    const email = str(user.email);
    const idToken = str(answer.id_token);
    return {
      tokens: { access_token: access, refresh_token: refresh, ...(idToken ? { id_token: idToken } : {}) },
      expiresAt: expiry(now, answer.expires_in),
      account: project,
      subject: str(user.id) ?? email,
      name: (email ?? "Google account").slice(0, 100),
    };
  };

const google = (antigravity: boolean, scopes: string[], clientEnv: readonly [keyof Env, keyof Env]): PkceDef => ({
  flow: "pkce",
  clientId: "",
  clientEnv,
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scope: scopes.join(" "),
  // [Unverified] The local address Gemini CLI listens on; the user pastes the address the browser ends on.
  redirectUri: "http://localhost:8085/oauth2callback",
  extra: { access_type: "offline", prompt: "consent" },
  exchange: "form",
  refreshBody: "form",
  refreshLeadS: 300,
  granted: googleGranted(antigravity),
});

export const OAUTH: Readonly<Record<string, OAuthDef>> = {
  /**
   * Antigravity: Google sign-in with Antigravity's client (GOOGLE_ANTIGRAVITY_CLIENT_ID and _SECRET), chat through
   * Cloud Code (cloudcode.ts). Google's terms may not allow the account to be used outside Antigravity.
   */
  antigravity: google(true, [...GOOGLE_SCOPES, "https://www.googleapis.com/auth/cclog", "https://www.googleapis.com/auth/experimentsandconfigs"], [
    "GOOGLE_ANTIGRAVITY_CLIENT_ID",
    "GOOGLE_ANTIGRAVITY_CLIENT_SECRET",
  ]),
  /**
   * Gemini CLI: Google sign-in with Gemini CLI's client (GOOGLE_GEMINI_CLI_CLIENT_ID and _SECRET), chat through
   * Cloud Code (cloudcode.ts). Google's terms may not allow the account to be used outside Gemini CLI.
   */
  "gemini-cli": google(false, GOOGLE_SCOPES, ["GOOGLE_GEMINI_CLI_CLIENT_ID", "GOOGLE_GEMINI_CLI_CLIENT_SECRET"]),
  /** Codex CLI: ChatGPT account at auth.openai.com; redirect http://localhost:1455/auth/callback. */
  codex: {
    flow: "pkce",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    redirectUri: "http://localhost:1455/auth/callback",
    extra: { id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs" },
    exchange: "form",
    refreshBody: "json",
    refreshLeadS: 600,
    identity: (answer) => {
      const id = claims(answer.id_token);
      const email = str(id.email);
      return {
        account: str(obj(id["https://api.openai.com/auth"]).chatgpt_account_id),
        // The person who signed in: one ChatGPT team account has many.
        subject: str(id.sub) ?? email,
        name: email ? email.slice(0, 100) : "Account",
      };
    },
  },
  /**
   * Claude Code: a Claude Pro/Max account at claude.ai, with Claude Code's client id. The page ends on a local
   * address (or shows `code#state` to copy); the user pastes either. Anthropic's terms may not allow a Claude
   * subscription to be used outside Claude Code; the account can be limited.
   */
  claude: {
    flow: "pkce",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    scope: "org:create_api_key user:profile user:inference",
    redirectUri: "http://localhost:54545/callback",
    extra: { code: "true" },
    exchange: "json",
    refreshBody: "json",
    refreshLeadS: 3600,
    identity: (answer) => {
      const account = obj(answer.account);
      const email = str(account.email_address);
      return { account: str(obj(answer.organization).uuid), subject: str(account.uuid) ?? email, name: email ? email.slice(0, 100) : "Claude account" };
    },
  },
  /**
   * GitHub Copilot: device code with the Copilot editor plugin's client id; the GitHub token buys Copilot tokens
   * (about 25 minutes each). GitHub's terms may not allow Copilot to be used outside supported editors.
   */
  github: {
    flow: "device",
    clientId: "Iv1.b507a08c87ecfe98",
    deviceUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user",
    refreshBody: "form",
    refreshLeadS: 300,
    granted: githubGranted,
    renew: githubRenew,
  },
  /**
   * Kilo Code: the Kilo Code extension's device sign-in at api.kilo.ai (values from an open-source client, not checked against the service). Its terms
   * may not allow the account to be used outside Kilo Code.
   */
  kilocode: {
    flow: "device",
    clientId: "",
    deviceUrl: KILO_CODES,
    tokenUrl: KILO_CODES,
    scope: "",
    refreshBody: "json",
    refreshLeadS: 0,
    start: kiloStart,
    poll: kiloPoll,
    granted: kiloGranted,
    renew: kiloRenew,
    headers: async (_env, account): Promise<Record<string, string>> => (account ? { "X-Kilocode-OrganizationID": account } : {}),
  },
  /**
   * Kimi Code: device code with the Kimi CLI's client id at auth.kimi.com (values from an open-source client, not checked against the service). Kimi's
   * terms may not allow the subscription to be used outside its own tools.
   */
  kimi: {
    flow: "device",
    clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
    deviceUrl: "https://auth.kimi.com/api/oauth/device_authorization",
    tokenUrl: "https://auth.kimi.com/api/oauth/token",
    scope: "",
    page: "https://www.kimi.com/code/authorize_device",
    refreshBody: "form",
    refreshLeadS: 300,
    headers: kimiHeaders,
    identity: (answer) => {
      const c = claims(answer.access_token);
      return { account: null, subject: str(c.user_id) ?? str(c.sub), name: "Kimi account" };
    },
  },
  /** MiniMax Code (China): see minimaxCode. Chat through MiniMax's agent gateway as Anthropic messages. */
  "minimax-code": minimaxCode("https://account.minimax.cn"),
  /** MiniMax Code (international): see minimaxCode. */
  "minimax-code-global": minimaxCode("https://account.minimax.io"),
  /**
   * Muse Code (Meta): device code with Muse Code's client id at auth.meta.com, then one Muse Code key (values from
   * an open-source client, not checked against the service). Meta's terms may not allow the subscription to be used outside Muse Code.
   */
  muse: {
    flow: "device",
    clientId: "1031625952748946",
    deviceUrl: "https://auth.meta.com/oidc/device/authorization/",
    tokenUrl: "https://auth.meta.com/oidc/device/token/",
    scope: "",
    refreshBody: "form",
    refreshLeadS: 0,
    headers: async (): Promise<Record<string, string>> => ({ ...MUSE_HEADERS }),
    granted: museGranted,
  },
  /**
   * Nous Portal: device code with the Hermes CLI's client id; chat with an agent key the access token buys (values
   * from an open-source client, not checked against the service). Nous's terms may not allow the account to be used outside its own tools.
   */
  nous: {
    flow: "device",
    clientId: "hermes-cli",
    deviceUrl: `${NOUS_PORTAL}/api/oauth/device/code`,
    tokenUrl: NOUS_TOKEN_URL,
    scope: "inference:invoke inference:mint_agent_key",
    refreshBody: "form",
    refreshLeadS: 300,
    granted: nousGranted,
    renew: nousRenew,
  },
};

/** The provider's own headers for a chat request through the connection whose account is `account`. */
export async function oauthRequestHeaders(env: Env, provider: string, account: string | null): Promise<Record<string, string>> {
  const def = oauthDef(provider);
  return def?.headers ? def.headers(env, account) : {};
}

const PENDING_TTL_S = 600;

/** The provider's login, only for its own names: never `constructor`, `toString` or another inherited property. */
export const oauthDef = (provider: string): OAuthDef | null => (Object.hasOwn(OAUTH, provider) ? OAUTH[provider]! : null);

/** The variables a provider's client comes from that are unset (empty: none needed, or all set). Names only, never values. */
export function oauthMissingEnv(env: Env, provider: string): string[] {
  const def = oauthDef(provider);
  return def?.clientEnv ? def.clientEnv.filter((k) => !str(env[k])) : [];
}

const setVars = (missing: string[]) => `set ${missing.join(" and ")}`;

/** The client to sign in and renew with: `clientId`, or the id and secret from `clientEnv`. */
function clientOf(env: Env, def: OAuthDef): { id: string; secret?: string } | { missing: string[] } {
  if (!def.clientEnv) return { id: def.clientId };
  const [idVar, secretVar] = def.clientEnv;
  const id = str(env[idVar]);
  const secret = str(env[secretVar]);
  return id && secret ? { id, secret } : { missing: def.clientEnv.filter((k) => !str(env[k])) };
}

/** Whether tokens can be sealed (CONNECTIONS_KEY set and usable): no login starts or finishes without it. */
const canSeal = async (env: Env): Promise<boolean> => (await seal(env, "probe")) !== null;

/** RFC 3986 form for the query: `%20` for a space, which some authorize pages need (URLSearchParams writes `+`). */
const query = (params: Record<string, string>) =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const random = (n: number) => base64Url(crypto.getRandomValues(new Uint8Array(n)));

/** A POST of `body` as the provider wants it. */
const post = (url: string, body: Record<string, string>, as: "json" | "form", extra: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { ...extra, "content-type": as === "json" ? "application/json" : "application/x-www-form-urlencoded", accept: "application/json" },
    body: as === "json" ? JSON.stringify(body) : new URLSearchParams(body).toString(),
  });

/** The provider's sign-in headers (`account` null: no connection yet). */
const signInHeaders = async (env: Env, def: OAuthDef): Promise<Record<string, string>> => (def.headers ? def.headers(env, null) : {});

/** RFC 8628 device authorization: a form POST of the client id (and scope, when there is one). */
async function rfcDeviceStart(env: Env, def: DeviceDef, upstream: Fetch): Promise<DeviceStart | { error: string }> {
  let res: Response;
  try {
    const body: Record<string, string> = { client_id: def.clientId, ...(def.scope ? { scope: def.scope } : {}) };
    res = await upstream(post(def.deviceUrl, body, "form", await signInHeaders(env, def)));
  } catch {
    return { error: "could not reach the sign-in service" };
  }
  if (!res.ok) return { error: await refusal(res) };
  const b = obj(await res.json().catch(() => null));
  const deviceCode = str(b.device_code);
  const userCode = str(b.user_code);
  const page = str(b.verification_uri) ?? def.page ?? null;
  if (!deviceCode || !userCode || !page) return { error: "the sign-in service sent no code" };
  const complete = str(b.verification_uri_complete) ?? (def.page && page === def.page ? `${def.page}?user_code=${encodeURIComponent(userCode)}` : null);
  return {
    deviceCode,
    userCode,
    page,
    ...(complete ? { complete } : {}),
    interval: typeof b.interval === "number" && b.interval > 0 ? b.interval : 5,
    expiresIn: typeof b.expires_in === "number" ? b.expires_in : PENDING_TTL_S,
  };
}

/** RFC 8628 poll: a form POST of the device code. GitHub and Kimi answer 200 with `error`; the RFC says 400. Both read the same. */
async function rfcDevicePoll(env: Env, def: DeviceDef, upstream: Fetch, deviceCode: string): Promise<DevicePoll> {
  const res = await upstream(
    post(def.tokenUrl, { client_id: def.clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }, "form", await signInHeaders(env, def)),
  );
  const b = obj(await res.clone().json().catch(() => null));
  const error = str(b.error);
  if (error === "authorization_pending") return { pending: 5 };
  if (error === "slow_down") return { pending: typeof b.interval === "number" && b.interval > 0 ? b.interval : 10 };
  if (error || !res.ok) {
    // A 5xx is the service's trouble, not the sign-in's: the user can poll again.
    if (res.status >= 500) return { refused: `the sign-in service answered ${res.status}`, final: false };
    return { refused: await refusal(res), final: true };
  }
  return { answer: b };
}

export type StartResult =
  | { ok: true; flow: "pkce"; url: string }
  | { ok: true; flow: "device"; id: string; user_code: string; verification_uri: string; verification_uri_complete?: string; interval: number; expires_in: number }
  | { ok: false; error: "not_found" | "not_configured" }
  | { ok: false; error: "provider_refused"; message: string }
  /** The provider's client is to come from variables that are unset; `message` names them. */
  | { ok: false; error: "unavailable"; message: string };

/**
 * Starts a login. PKCE: the page to send the browser to; the verifier waits for the provider to send it back.
 * Device: asks the provider for a code and answers what the user needs (never the device code, which stays here).
 */
export async function startLogin(env: Env, upstream: Fetch, provider: string): Promise<StartResult> {
  const def = oauthDef(provider);
  if (!def) return { ok: false, error: "not_found" };
  const client = clientOf(env, def);
  if ("missing" in client) return { ok: false, error: "unavailable", message: setVars(client.missing) };
  // A login whose tokens could not be stored is not started: the user would sign in for nothing.
  if (!(await canSeal(env))) return { ok: false, error: "not_configured" };
  const now = Math.floor(Date.now() / 1000);
  const remember = (state: string, verifier: string) =>
    env.DB.batch([
      env.DB.prepare("DELETE FROM oauth_pending WHERE created_at < ?").bind(now - PENDING_TTL_S),
      env.DB.prepare("INSERT INTO oauth_pending (state, provider, verifier, created_at) VALUES (?, ?, ?, ?)").bind(state, provider, verifier, now),
    ]);

  if (def.flow === "device") {
    const s = def.start ? await def.start(upstream) : await rfcDeviceStart(env, def, upstream);
    if ("error" in s) return { ok: false, error: "provider_refused", message: s.error };
    const id = random(32);
    await remember(id, s.deviceCode);
    return {
      ok: true,
      flow: "device",
      id,
      user_code: s.userCode,
      verification_uri: s.page,
      ...(s.complete ? { verification_uri_complete: s.complete } : {}),
      interval: s.interval,
      // The sign-in is kept here no longer than PENDING_TTL_S, whatever the provider allows.
      expires_in: Math.min(s.expiresIn, PENDING_TTL_S),
    };
  }

  const state = random(32);
  const verifier = random(64);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await remember(state, verifier);
  const params = { response_type: "code", client_id: client.id, redirect_uri: def.redirectUri, scope: def.scope, code_challenge: challenge, code_challenge_method: "S256", state, ...def.extra };
  return { ok: true, flow: "pkce", url: `${def.authorizeUrl}?${query(params)}` };
}

export const isPendingState = async (db: D1Database, state: string): Promise<boolean> =>
  (await db.prepare("SELECT 1 AS x FROM oauth_pending WHERE state = ? AND created_at >= ?").bind(state, Math.floor(Date.now() / 1000) - PENDING_TTL_S).first()) !== null;

export type LoginResult =
  | { ok: true; id: string; name: string }
  | { ok: false; status: 400 | 500 | 502; error: "invalid_state" | "not_configured" | "provider_refused"; message: string };

const NOT_CONFIGURED = { ok: false, status: 500, error: "not_configured", message: "set the CONNECTIONS_KEY secret: 32 random bytes, base64" } as const;
const INVALID_STATE = { ok: false, status: 400, error: "invalid_state", message: "this sign-in was not started here, was already used, or is older than 10 minutes" } as const;
const refused = (message: string) => ({ ok: false, status: 502, error: "provider_refused", message }) as const;

/** The grant in a token answer: the provider's own `granted`, or the tokens and `identity`. */
async function grantOf(def: OAuthDef, answer: Record<string, unknown>, upstream: Fetch, now: number): Promise<Grant | { error: string }> {
  if (def.granted) return def.granted(answer, upstream, now);
  const access = str(answer.access_token);
  const refresh = str(answer.refresh_token);
  if (!access || !refresh) return { error: "the sign-in service sent no tokens" };
  const who = def.identity ? def.identity(answer) : { account: null, subject: null, name: "Account" };
  const idToken = str(answer.id_token);
  return { tokens: { access_token: access, refresh_token: refresh, ...(idToken ? { id_token: idToken } : {}) }, expiresAt: expiry(now, answer.expires_in), ...who };
}

/**
 * Stores a grant as a connection. Signing in again as the same person of the same account replaces that
 * connection's tokens; another person of a shared (team) account gets a connection of their own.
 */
async function store(env: Env, provider: string, g: Grant, now: number): Promise<LoginResult> {
  const secret = await seal(env, JSON.stringify(g.tokens));
  if (!secret) return NOT_CONFIGURED;
  // A connection stored before `subject` existed (NULL) is taken as this person's, and gets their subject.
  // No account (Kimi, a personal Kilo Code account): the same person is the same connection.
  const existing =
    g.subject
      ? await env.DB.prepare(
          "SELECT id FROM connection WHERE provider = ? AND auth_type = 'oauth' AND account IS ? AND (subject = ? OR subject IS NULL) ORDER BY subject IS NULL LIMIT 1",
        )
          .bind(provider, g.account, g.subject)
          .first<{ id: string }>()
      : null;
  if (existing) {
    await env.DB.prepare(
      "UPDATE connection SET secret = ?, name = ?, subject = ?, expires_at = ?, cooldown_until = 0, backoff_level = 0, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(secret, g.name, g.subject, g.expiresAt, now, existing.id)
      .run();
    return { ok: true, id: existing.id, name: g.name };
  }
  const connectionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO connection (id, provider, auth_type, name, secret, account, subject, expires_at, priority, created_at, updated_at)
     VALUES (?, ?, 'oauth', ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(priority), 0) + 1 FROM connection WHERE provider = ?), ?, ?)`,
  )
    .bind(connectionId, provider, g.name, secret, g.account, g.subject, g.expiresAt, provider, now, now)
    .run();
  return { ok: true, id: connectionId, name: g.name };
}

/**
 * Finishes a PKCE login: trades the code for tokens, seals them, and stores them as a connection named after the
 * account's email. `provider` null: the one the state was issued for.
 */
export async function finishLogin(env: Env, upstream: Fetch, provider: string | null, code: string, state: string): Promise<LoginResult> {
  // Checked before the state is used up and the code is spent, so the user can sign in again once it is set.
  if (!(await canSeal(env))) return NOT_CONFIGURED;
  const now = Math.floor(Date.now() / 1000);
  // Single use: the row is gone before the provider is asked, so a replay finds nothing. Only a PKCE login's row:
  // a device sign-in's id is not a state.
  const pkce = Object.keys(OAUTH).filter((p) => OAUTH[p]!.flow === "pkce");
  const pending = await env.DB.prepare(
    `DELETE FROM oauth_pending WHERE state = ? AND created_at >= ? AND provider IN (${pkce.map(() => "?").join(", ")}) RETURNING provider, verifier`,
  )
    .bind(state, now - PENDING_TTL_S, ...pkce)
    .first<{ provider: string; verifier: string }>();
  const def = pending ? oauthDef(pending.provider) : null;
  if (!pending || !def || def.flow !== "pkce" || (provider !== null && provider !== pending.provider)) return INVALID_STATE;
  const client = clientOf(env, def);
  if ("missing" in client) return { ...NOT_CONFIGURED, message: setVars(client.missing) };
  const body: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: def.redirectUri, client_id: client.id, code_verifier: pending.verifier };
  if (client.secret) body.client_secret = client.secret;
  if (def.exchange === "json") body.state = state;
  let res: Response;
  try {
    res = await upstream(post(def.tokenUrl, body, def.exchange));
  } catch {
    return refused("could not reach the sign-in service");
  }
  if (!res.ok) return refused(await refusal(res));
  const g = await grantOf(def, obj(await res.json().catch(() => null)), upstream, now);
  if ("error" in g) return refused(g.error);
  return store(env, pending.provider, g, now);
}

export type PollResult = LoginResult | { ok: "pending"; interval: number };

/**
 * One poll of a device sign-in: still waiting (`pending`), refused (the sign-in ends), or authorized (stored as
 * a connection, the sign-in used up).
 */
export async function pollLogin(env: Env, upstream: Fetch, provider: string, id: string): Promise<PollResult> {
  if (!(await canSeal(env))) return NOT_CONFIGURED;
  const def = oauthDef(provider);
  const now = Math.floor(Date.now() / 1000);
  const pending = await env.DB.prepare("SELECT verifier FROM oauth_pending WHERE state = ? AND provider = ? AND created_at >= ?")
    .bind(id, provider, now - PENDING_TTL_S)
    .first<{ verifier: string }>();
  if (!pending || !def || def.flow !== "device") return INVALID_STATE;
  let p: DevicePoll;
  try {
    p = def.poll ? await def.poll(upstream, pending.verifier) : await rfcDevicePoll(env, def, upstream, pending.verifier);
  } catch {
    return refused("could not reach the sign-in service");
  }
  if ("pending" in p) return { ok: "pending", interval: p.pending };
  if ("refused" in p) {
    if (p.final) await env.DB.prepare("DELETE FROM oauth_pending WHERE state = ?").bind(id).run();
    return refused(p.refused);
  }
  // Single use: whoever deletes the row stores the connection.
  const claimed = await env.DB.prepare("DELETE FROM oauth_pending WHERE state = ? RETURNING state").bind(id).first();
  if (!claimed) return INVALID_STATE;
  const g = await grantOf(def, p.answer, upstream, now);
  if ("error" in g) return refused(g.error);
  return store(env, provider, g, now);
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
    return typeof t.access_token === "string" ? (t as Tokens) : null;
  } catch {
    return null;
  }
}

/** The usual renewal: a refresh-token grant at the token endpoint. 400 and 401 are a refusal. */
async function refreshGrant(env: Env, def: OAuthDef, t: Tokens, upstream: Fetch, now: number): Promise<Renewal> {
  if (!t.refresh_token) return { ok: false, refused: true, reason: "no refresh token is stored" };
  const client = clientOf(env, def);
  if ("missing" in client) return { ok: false, refused: false, reason: setVars(client.missing) };
  const body: Record<string, string> = { client_id: client.id, grant_type: "refresh_token", refresh_token: t.refresh_token };
  if (client.secret) body.client_secret = client.secret;
  let res: Response;
  try {
    res = await upstream(post(def.tokenUrl, body, def.refreshBody, await signInHeaders(env, def)));
  } catch {
    return { ok: false, refused: false, reason: "could not reach it" };
  }
  if (res.status === 400 || res.status === 401) return { ok: false, refused: true, reason: await refusal(res) };
  if (!res.ok) return { ok: false, refused: false, reason: `it answered ${res.status}` };
  const fresh = obj(await res.json().catch(() => null));
  const access = str(fresh.access_token);
  if (!access) return { ok: false, refused: false, reason: "it sent no token" };
  const idToken = str(fresh.id_token) ?? t.id_token;
  return {
    ok: true,
    tokens: { access_token: access, refresh_token: str(fresh.refresh_token) ?? t.refresh_token, ...(idToken ? { id_token: idToken } : {}) },
    expiresAt: expiry(now, fresh.expires_in),
  };
}

/**
 * The access token of an OAuth connection, renewed first when it has little time left, or always with `force`
 * (the provider answered 401, or the console tests the connection).
 */
export async function oauthToken(env: Env, upstream: Fetch, row: OAuthRow, now: number, force = false): Promise<TokenResult> {
  const def = oauthDef(row.provider);
  const t = def ? await openTokens(env, row.secret) : null;
  if (!def || !t) return null;
  // No expiry (Kilo Code): used until the provider refuses it.
  if (!force && (row.expires_at === null || row.expires_at - now >= def.refreshLeadS)) return { token: t.access_token, renewed: false };

  const stillValid = row.expires_at === null || row.expires_at > now;
  const r = def.renew ? await def.renew(t, upstream, now) : await refreshGrant(env, def, t, upstream, now);
  if (!r.ok && !r.refused) return stillValid ? { token: t.access_token, renewed: false, unavailable: r.reason } : { error: `the sign-in service is unavailable: ${r.reason}`, status: 502 };
  if (!r.ok) {
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
    return { error: `sign in again: ${r.reason}`, status: 401 };
  }
  const secret = await seal(env, JSON.stringify(r.tokens));
  if (secret) {
    try {
      // Compare-and-swap: when another request stored newer tokens meanwhile, those are kept.
      await env.DB.prepare("UPDATE connection SET secret = ?, expires_at = ?, updated_at = ? WHERE id = ? AND secret = ?").bind(secret, r.expiresAt, now, row.id, row.secret).run();
    } catch {
      // The token is good for this request; the next one renews again.
    }
  }
  return { token: r.tokens.access_token, renewed: true };
}
