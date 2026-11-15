import { Hono } from "hono";
import { CODEX_URL, codexDestination } from "./codex";
import type { AppEnv, Env } from "./env";
import { open, seal } from "./secret-box";
import { ProxyError, socketFetch, type ProxyTarget } from "./socket-fetch";
import { withDeadlines } from "./timeouts";

/**
 * Proxy pools: a named set of exits a Codex account sends its upstream calls through, one
 * picked at random per request. An exit is one of:
 *  - `https://…` a relay (`relay/codex-relay.mjs`) that shares the pool's secret;
 *  - `http://[user:pass@]host[:port]` an HTTP proxy, reached with CONNECT;
 *  - `socks5://[user:pass@]host[:port]` a SOCKS5 proxy (no auth or user/password).
 * Proxies go over a raw socket (worker/socket-fetch.ts), so the request carries no Cf-Worker header. Their user
 * names and passwords are sealed; the API answers only host, port and whether a proxy has them.
 */

export type ProxyKind = "http" | "socks5";
type StoredProxy = { kind: ProxyKind; host: string; port: number; has_auth: boolean };
type Auth = Record<string, { u: string; p: string }>;
type Check = { url: string; ok: boolean; ms: number; status?: number; error?: string };

export interface ProxyPool {
  id: string;
  name: string;
  /** https relays. */
  relays: string[];
  /** HTTP and SOCKS5 proxies, with no credential in `url`. */
  proxies: { url: string; kind: ProxyKind; has_auth: boolean }[];
  /** Last 4 characters of the relays' secret; null when the pool has no relay secret. */
  hint: string | null;
  last_check: Check[] | null;
  checked_at: number | null;
  connections: number;
  created_at: number;
  updated_at: number;
}

type Row = {
  id: string;
  name: string;
  relays: string;
  proxies: string;
  hint: string;
  last_check: string | null;
  checked_at: number | null;
  connections: number;
  created_at: number;
  updated_at: number;
};

const MIN_SECRET = 32;
const MAX_ENTRIES = 10;
const DEFAULT_PORT: Record<ProxyKind, number> = { http: 80, socks5: 1080 };
/** What a proxy test asks for: any HTTP answer from chatgpt.com means the tunnel works. */
const PROBE_URL = "https://chatgpt.com/";
const TEST_MS = 10_000;
export const PROXY_ERROR_HEADER = "x-proxy-error";

const parse = <T>(s: string | null, fallback: T): T => {
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const proxyUrl = (p: { kind: ProxyKind; host: string; port: number }) => `${p.kind}://${p.host}:${p.port}`;

const toPool = (r: Row): ProxyPool => ({
  ...r,
  relays: parse<string[]>(r.relays, []),
  proxies: parse<StoredProxy[]>(r.proxies, []).map((p) => ({ url: proxyUrl(p), kind: p.kind, has_auth: p.has_auth })),
  hint: r.hint || null,
  last_check: parse(r.last_check, null),
});

const SELECT = `SELECT p.id, p.name, p.relays, p.proxies, p.hint, p.last_check, p.checked_at, p.created_at, p.updated_at,
  (SELECT COUNT(*) FROM connection c WHERE c.proxy_pool = p.id) AS connections FROM proxy_pool p`;

export async function listPools(db: D1Database): Promise<ProxyPool[]> {
  return (await db.prepare(`${SELECT} ORDER BY p.created_at`).all<Row>()).results.map(toPool);
}

async function getPool(db: D1Database, id: string): Promise<ProxyPool | null> {
  const r = await db.prepare(`${SELECT} WHERE p.id = ?`).bind(id).first<Row>();
  return r ? toPool(r) : null;
}

export async function poolExists(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM proxy_pool WHERE id = ?").bind(id).first()) !== null;
}

type Entries = { relays: string[]; proxies: (StoredProxy & { u?: string; p?: string })[] };

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * The pool's exits from the typed list; a string is the reason it is refused. A reason names the entry by its place
 * in the list, never by its text, which may hold a password.
 */
function entryList(v: unknown): Entries | string {
  const usage = `relays: 1 to ${MAX_ENTRIES} entries, each https://relay, http://[user:pass@]host:port or socks5://[user:pass@]host:port`;
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_ENTRIES) return usage;
  const out: Entries = { relays: [], proxies: [] };
  for (const [i, x] of v.entries()) {
    const at = `relays: entry ${i + 1}`;
    if (typeof x !== "string") return usage;
    let u: URL;
    try {
      u = new URL(x.trim());
    } catch {
      return `${at} is not a URL`;
    }
    if (u.search || u.hash) return `${at} has a query or fragment`;
    if (u.protocol === "https:") {
      if (u.username || u.password) return `${at}: a relay takes no user name; it uses the pool secret`;
      const base = (u.origin + u.pathname).replace(/\/+$/, "");
      if (!out.relays.includes(base)) out.relays.push(base);
      continue;
    }
    const kind: ProxyKind | null = u.protocol === "http:" ? "http" : u.protocol === "socks5:" || u.protocol === "socks5h:" ? "socks5" : null;
    if (!kind) return `${at}: the scheme must be https, http or socks5`;
    if (u.pathname !== "" && u.pathname !== "/") return `${at}: a proxy address has no path`;
    const host = u.hostname;
    if (!host) return `${at} has no host`;
    const port = u.port ? Number(u.port) : DEFAULT_PORT[kind];
    if (!Number.isInteger(port) || port < 1 || port > 65535) return `${at} has a bad port`;
    if (port === 25) return `${at}: a Cloudflare Worker cannot open sockets to port 25`;
    const user = decode(u.username);
    const pass = decode(u.password);
    if (user === null || pass === null) return `${at} has a badly encoded user name or password`;
    if ((user || pass) && (!user || !pass || utf8Len(user) > 255 || utf8Len(pass) > 255))
      return `${at}: the user name and password must each be 1 to 255 bytes`;
    const entry = { kind, host, port, has_auth: Boolean(user), ...(user ? { u: user, p: pass } : {}) };
    if (!out.proxies.some((p) => proxyUrl(p) === proxyUrl(entry))) out.proxies.push(entry);
  }
  return out;
}

const isName = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.trim().length <= 100;
const isSecret = (v: unknown): v is string => typeof v === "string" && v.trim().length >= MIN_SECRET && v.length <= 512;

/** The sealed credentials for `proxies`: those typed now, else the stored ones for the same address. */
async function authFor(env: Env, entries: Entries["proxies"], stored: Auth): Promise<{ proxies: StoredProxy[]; sealed: string | null } | "not_configured"> {
  const auth: Auth = {};
  const proxies: StoredProxy[] = [];
  for (const e of entries) {
    const key = proxyUrl(e);
    const cred = e.u !== undefined ? { u: e.u, p: e.p ?? "" } : stored[key];
    if (cred) auth[key] = cred;
    proxies.push({ kind: e.kind, host: e.host, port: e.port, has_auth: Boolean(cred) });
  }
  if (Object.keys(auth).length === 0) return { proxies, sealed: null };
  const sealed = await seal(env, JSON.stringify(auth));
  return sealed ? { proxies, sealed } : "not_configured";
}

async function openAuth(env: Env, sealed: string | null): Promise<Auth | null> {
  if (!sealed) return {};
  const plain = await open(env, sealed);
  return plain === null ? null : parse<Auth>(plain, {});
}

const target = (p: StoredProxy, auth: Auth): ProxyTarget | null => {
  const cred = auth[proxyUrl(p)];
  if (p.has_auth && !cred) return null;
  return { kind: p.kind, host: p.host.replace(/^\[|\]$/g, ""), port: p.port, ...(cred ? { username: cred.u, password: cred.p } : {}) };
};

/** A fetch through one proxy; a proxy failure is a 502 answer with its reason, as an upstream's would be. */
export function viaProxy(t: ProxyTarget): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await socketFetch(req, t);
    } catch (e) {
      const message = e instanceof ProxyError ? e.message : `${t.kind === "http" ? "HTTP" : "SOCKS5"} proxy ${t.host}:${t.port}: the request failed`;
      return Response.json({ error: { type: "proxy_error", message } }, { status: 502, headers: { [PROXY_ERROR_HEADER]: "1" } });
    }
  };
}

export type Destination = { ok: true; url: string; secret: string | null; fetch?: (req: Request) => Promise<Response> } | { ok: false; message: string };

/**
 * Where a Codex account's request goes: an exit of its pool, or CODEX_RELAY_URL when it has none. A pool whose
 * secrets cannot be opened (CONNECTIONS_KEY changed) or that was deleted is not configured: no fallback, so a
 * request meant for a relay or proxy never goes out another way. A proxy exit comes with the `fetch` to send by.
 */
export async function codexDestinationFor(env: Env, poolId: string | null): Promise<Destination> {
  if (!poolId) return codexDestination(env);
  const row = await env.DB.prepare("SELECT relays, secret, proxies, proxy_auth FROM proxy_pool WHERE id = ?")
    .bind(poolId)
    .first<{ relays: string; secret: string; proxies: string; proxy_auth: string | null }>();
  if (!row) return { ok: false, message: "not_configured: the account's proxy pool no longer exists" };
  const relays = parse<string[]>(row.relays, []);
  const proxies = parse<StoredProxy[]>(row.proxies, []);
  if (relays.length + proxies.length === 0) return { ok: false, message: "not_configured: the account's proxy pool is empty" };
  const i = Math.floor(Math.random() * (relays.length + proxies.length));
  if (i < relays.length) {
    const secret = row.secret ? await open(env, row.secret) : null;
    if (!secret) return { ok: false, message: "not_configured: the proxy pool's relay secret cannot be opened (CONNECTIONS_KEY changed)" };
    return { ok: true, url: `${relays[i]}/codex/responses`, secret };
  }
  const auth = await openAuth(env, row.proxy_auth);
  const t = auth && target(proxies[i - relays.length]!, auth);
  if (!t) return { ok: false, message: "not_configured: the proxy pool's proxy passwords cannot be opened (CONNECTIONS_KEY changed)" };
  return { ok: true, url: CODEX_URL, secret: null, fetch: withDeadlines(viaProxy(t)) };
}

const bad = (message: string) => Response.json({ error: "invalid_request", message }, { status: 400 });
const notConfigured = () => Response.json({ error: "not_configured", message: "CONNECTIONS_KEY is not set" }, { status: 500 });
const SECRET_NEEDED = `secret: at least ${MIN_SECRET} characters, the relays' RELAY_SECRET (needed when the pool has an https relay)`;

export function proxyPoolRoutes(a: Hono<AppEnv>, upstream: (req: Request) => Promise<Response>): void {
  a.get("/proxy-pools", async (c) => c.json(await listPools(c.env.DB)));

  a.post("/proxy-pools", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || !isName(b.name)) return bad("name: 1 to 100 characters");
    const entries = entryList(b.relays);
    if (typeof entries === "string") return bad(entries);
    const given = b.secret !== undefined && b.secret !== "";
    if ((entries.relays.length > 0 || given) && !isSecret(b.secret)) return bad(SECRET_NEEDED);
    let sealedSecret = "";
    let hint = "";
    if (given) {
      const secret = (b.secret as string).trim();
      const s = await seal(c.env, secret);
      if (!s) return notConfigured();
      sealedSecret = s;
      hint = secret.slice(-4);
    }
    const auth = await authFor(c.env, entries.proxies, {});
    if (auth === "not_configured") return notConfigured();
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      "INSERT INTO proxy_pool (id, name, relays, secret, hint, proxies, proxy_auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, b.name.trim(), JSON.stringify(entries.relays), sealedSecret, hint, JSON.stringify(auth.proxies), auth.sealed, now, now)
      .run();
    return c.json(await getPool(c.env.DB, id), 201);
  });

  a.patch("/proxy-pools/:id", async (c) => {
    const id = c.req.param("id");
    const row = await c.env.DB.prepare("SELECT secret, proxies, proxy_auth FROM proxy_pool WHERE id = ?")
      .bind(id)
      .first<{ secret: string; proxies: string; proxy_auth: string | null }>();
    if (!row) return c.json({ error: "not_found" }, 404);
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) return bad("body must be a JSON object");
    const sets: string[] = [];
    const binds: unknown[] = [];
    if ("name" in b) {
      if (!isName(b.name)) return bad("name: 1 to 100 characters");
      sets.push("name = ?");
      binds.push(b.name.trim());
    }
    let hasSecret = row.secret !== "";
    if ("secret" in b) {
      if (!isSecret(b.secret)) return bad(SECRET_NEEDED);
      const secret = b.secret.trim();
      const sealed = await seal(c.env, secret);
      if (!sealed) return notConfigured();
      sets.push("secret = ?", "hint = ?");
      binds.push(sealed, secret.slice(-4));
      hasSecret = true;
    }
    if ("relays" in b) {
      const entries = entryList(b.relays);
      if (typeof entries === "string") return bad(entries);
      if (entries.relays.length > 0 && !hasSecret) return bad(SECRET_NEEDED);
      const stored = await openAuth(c.env, row.proxy_auth);
      const reuses = entries.proxies.some((e) => e.u === undefined && parse<StoredProxy[]>(row.proxies, []).some((p) => p.has_auth && proxyUrl(p) === proxyUrl(e)));
      if (stored === null && reuses) return bad("relays: the stored proxy passwords cannot be opened (CONNECTIONS_KEY changed); type them again");
      const auth = await authFor(c.env, entries.proxies, stored ?? {});
      if (auth === "not_configured") return notConfigured();
      sets.push("relays = ?", "proxies = ?", "proxy_auth = ?", "last_check = NULL", "checked_at = NULL");
      binds.push(JSON.stringify(entries.relays), JSON.stringify(auth.proxies), auth.sealed);
    }
    if (sets.length > 0) {
      await c.env.DB.prepare(`UPDATE proxy_pool SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...binds, Math.floor(Date.now() / 1000), id)
        .run();
    }
    return c.json(await getPool(c.env.DB, id));
  });

  a.delete("/proxy-pools/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await poolExists(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE connection SET proxy_pool = NULL WHERE proxy_pool = ?").bind(id),
      c.env.DB.prepare("DELETE FROM proxy_pool WHERE id = ?").bind(id),
    ]);
    return c.body(null, 204);
  });

  /**
   * Asks each relay's /health (no secret needed), and opens a tunnel through each proxy to chatgpt.com (any HTTP
   * answer counts), and keeps the answers and the time each took.
   */
  a.post("/proxy-pools/:id/test", async (c) => {
    const row = await c.env.DB.prepare("SELECT relays, proxies, proxy_auth FROM proxy_pool WHERE id = ?")
      .bind(c.req.param("id"))
      .first<{ relays: string; proxies: string; proxy_auth: string | null }>();
    if (!row) return c.json({ error: "not_found" }, 404);
    const checks: Check[] = [];
    for (const url of parse<string[]>(row.relays, [])) {
      const t0 = Date.now();
      try {
        const res = await upstream(new Request(`${url}/health`, { signal: AbortSignal.timeout(TEST_MS) }));
        await res.body?.cancel();
        checks.push({ url, ok: res.ok, ms: Date.now() - t0, status: res.status });
      } catch {
        checks.push({ url, ok: false, ms: Date.now() - t0 });
      }
    }
    const auth = await openAuth(c.env, row.proxy_auth);
    for (const p of parse<StoredProxy[]>(row.proxies, [])) {
      const url = proxyUrl(p);
      const t0 = Date.now();
      const t = auth && target(p, auth);
      if (!t) {
        checks.push({ url, ok: false, ms: 0, error: "the stored password cannot be opened (CONNECTIONS_KEY changed)" });
        continue;
      }
      try {
        const res = await socketFetch(new Request(PROBE_URL, { signal: AbortSignal.timeout(TEST_MS) }), t, { handshakeMs: TEST_MS });
        await res.body?.cancel();
        checks.push({ url, ok: true, ms: Date.now() - t0, status: res.status });
      } catch (e) {
        checks.push({ url, ok: false, ms: Date.now() - t0, error: e instanceof ProxyError ? e.message : `${url}: the request failed` });
      }
    }
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare("UPDATE proxy_pool SET last_check = ?, checked_at = ? WHERE id = ?").bind(JSON.stringify(checks), now, c.req.param("id")).run();
    return c.json({ relays: checks, checked_at: now });
  });
}
