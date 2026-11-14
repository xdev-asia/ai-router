import type { Context, Hono } from "hono";
import type { AppEnv, Env } from "./env";
import { checkSystem, type GateFailure, type Upstream } from "./proxy";
import { errorResponse } from "./route";
import { open, seal } from "./secret-box";

/**
 * Web search and fetch (web tools): `POST /v1/search {query}` and `POST /v1/fetch {url}` with the gateway
 * token. Each goes to the first provider in the owner's order that has a key (Jina Reader needs none) and falls back
 * to the next on a failure. The providers' request shapes follow their public API pages; only the test doubles
 * have called them here.
 *
 * Cloudflare Browser Rendering goes through its REST API, not a binding: `POST /client/v4/accounts/{account_id}/
 * browser-rendering/markdown` with `{url}` and an API token that has "Browser Rendering - Edit"; the answer is
 * `{success, result: "<markdown>", errors: [{code, message}], meta: {title, ...}}`.
 * https://developers.cloudflare.com/api/resources/browser_rendering/subresources/markdown/methods/create/
 * https://developers.cloudflare.com/browser-rendering/rest-api/markdown-endpoint/
 * Its account id is sealed with the token (`<account_id>:<token>`), so neither is ever answered.
 *
 * The rest follow the search callers/normalizers and fetch handler of an open-source gateway.
 * Google Programmable Search needs a search engine id (`cx`) beside its key; it is sealed with the key
 * (`<cx>\n<key>`; a legacy cx holds a colon). SearXNG has no key: the owner's instance address is sealed in its
 * place and only its host is answered. Tavily, Exa, TinyFish and Ollama serve both kinds with one key.
 */

type SearchResult = { title: string; url: string; snippet: string };
type FetchResult = { title: string | null; content: string };
type Kind = "search" | "fetch";

interface ToolDef {
  name: string;
  /** The lists it appears in; a tool in both uses one key for both. */
  kinds: readonly Kind[];
  keyUrl: string;
  /** Works without a key (rate-limited by the provider). */
  keyless?: boolean;
  /** A setting entered beside the key and sealed with it: a Cloudflare account id, a Google search engine id. */
  extra?: "account_id" | "cx";
  /** Has no key at all; the owner enters the address of their own instance instead. */
  instance?: boolean;
}

const S = ["search"] as const;
const F = ["fetch"] as const;
const SF = ["search", "fetch"] as const;

export const WEB_TOOLS = {
  tavily: { name: "Tavily", kinds: SF, keyUrl: "https://app.tavily.com/home" },
  brave: { name: "Brave Search", kinds: S, keyUrl: "https://api-dashboard.search.brave.com/app/keys" },
  exa: { name: "Exa", kinds: SF, keyUrl: "https://dashboard.exa.ai/api-keys" },
  serper: { name: "Serper", kinds: S, keyUrl: "https://serper.dev/api-key" },
  "google-pse": { name: "Google Programmable Search", kinds: S, keyUrl: "https://programmablesearchengine.google.com/controlpanel/create", extra: "cx" },
  linkup: { name: "Linkup", kinds: S, keyUrl: "https://app.linkup.so/api-keys" },
  searchapi: { name: "SearchAPI", kinds: S, keyUrl: "https://www.searchapi.io/dashboard" },
  youcom: { name: "You.com Search", kinds: S, keyUrl: "https://api.you.com" },
  perplexity: { name: "Perplexity Search", kinds: S, keyUrl: "https://www.perplexity.ai/settings/api" },
  tinyfish: { name: "TinyFish", kinds: SF, keyUrl: "https://agent.tinyfish.ai/api-keys" },
  ollama: { name: "Ollama", kinds: SF, keyUrl: "https://ollama.com/settings/keys" },
  searxng: { name: "SearXNG", kinds: S, keyUrl: "https://docs.searxng.org/", instance: true },
  xquik: { name: "Xquik (X posts)", kinds: S, keyUrl: "https://xquik.com" },
  jina: { name: "Jina Reader", kinds: F, keyUrl: "https://jina.ai/reader", keyless: true },
  firecrawl: { name: "Firecrawl", kinds: F, keyUrl: "https://www.firecrawl.dev/app/api-keys" },
  cloudflare: { name: "Cloudflare Browser Rendering", kinds: F, keyUrl: "https://dash.cloudflare.com/profile/api-tokens", extra: "account_id" },
} as const satisfies Record<string, ToolDef>;
const def = (id: WebToolId): ToolDef => WEB_TOOLS[id];
export type WebToolId = keyof typeof WEB_TOOLS;
const isTool = (v: unknown): v is WebToolId => typeof v === "string" && Object.hasOwn(WEB_TOOLS, v);
const serves = (id: WebToolId, kind: Kind) => def(id).kinds.includes(kind);
const toolsOf = (kind: Kind) => (Object.keys(WEB_TOOLS) as WebToolId[]).filter((t) => serves(t, kind));

type Order = { search: WebToolId[]; fetch: WebToolId[] };
// Fetch keeps Jina (no key) first, so a key set for search does not take over fetch until the owner says so.
const DEFAULT_ORDER: Order = { search: toolsOf("search"), fetch: ["jina", "firecrawl", "cloudflare", ...toolsOf("fetch").filter((t) => !["jina", "firecrawl", "cloudflare"].includes(t))] };
const ORDER_KEY = "web_order";
const MAX_RESULTS = 10;
const MAX_CONTENT = 200_000;

async function getOrder(db: D1Database): Promise<Order> {
  const r = await db.prepare("SELECT value FROM setting WHERE key = ?").bind(ORDER_KEY).first<{ value: string }>();
  if (!r) return DEFAULT_ORDER;
  try {
    const v = JSON.parse(r.value) as Partial<Order>;
    // A tool the order leaves out goes last, so a stored order never hides one.
    const fill = (kind: Kind) => {
      const got = (Array.isArray(v[kind]) ? v[kind] : []).filter((t) => isTool(t) && serves(t, kind));
      return [...new Set([...got, ...DEFAULT_ORDER[kind]])];
    };
    return { search: fill("search"), fetch: fill("fetch") };
  } catch {
    return DEFAULT_ORDER;
  }
}

async function keyOf(env: Env, id: WebToolId): Promise<string | null> {
  const r = await env.DB.prepare("SELECT secret FROM web_tool WHERE id = ?").bind(id).first<{ secret: string }>();
  return r ? open(env, r.secret) : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

type Row = Record<string, unknown>;
const list = (v: unknown): Row[] => (Array.isArray(v) ? (v as unknown[]).filter((r): r is Row => !!r && typeof r === "object") : []);
const obj = (v: unknown): Row => (v && typeof v === "object" ? (v as Row) : {});
const postJson = (url: string, headers: Record<string, string>, body: unknown) =>
  new Request(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
const getJson = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers: { ...headers, accept: "application/json" } });
const qs = (p: Record<string, string>) => new URLSearchParams(p).toString();

/** The two halves of a secret sealed with a setting beside it (`<setting>\n<key>`). */
function split(secret: string): [string, string] {
  const cut = secret.indexOf("\n");
  return [secret.slice(0, cut), secret.slice(cut + 1)];
}

/** An X post (Xquik) as a link to it. */
function xPost(r: Row): SearchResult {
  const author = obj(r.author);
  const user = str(author.username);
  const id = typeof r.id === "number" ? String(r.id) : str(r.id);
  const url = id ? (user ? `https://x.com/${encodeURIComponent(user)}/status/${encodeURIComponent(id)}` : `https://x.com/i/web/status/${encodeURIComponent(id)}`) : "";
  const who = user ? `@${user}` : str(author.name);
  return { title: who ? `${who} on X` : "X post", url, snippet: str(r.text) };
}

/** One provider's request, and how its answer reads. Throws { status, message } on a failure. */
async function searchWith(up: Upstream, id: WebToolId, key: string, query: string, n: number): Promise<SearchResult[]> {
  const bearer = { authorization: `Bearer ${key}` };
  let req: Request;
  let read: (j: Row) => SearchResult[];
  switch (id) {
    case "tavily":
      req = postJson("https://api.tavily.com/search", bearer, { query, max_results: n });
      read = (j) => list(j.results).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content) }));
      break;
    case "brave":
      req = new Request(`https://api.search.brave.com/res/v1/web/search?${qs({ q: query, count: String(n) })}`, { headers: { "x-subscription-token": key, accept: "application/json" } });
      read = (j) => list(obj(j.web).results).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.description) }));
      break;
    case "exa":
      req = postJson("https://api.exa.ai/search", { "x-api-key": key }, { query, numResults: n });
      read = (j) => list(j.results).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.text ?? r.summary) }));
      break;
    case "serper":
      req = postJson("https://google.serper.dev/search", { "x-api-key": key }, { q: query, num: n });
      read = (j) => list(j.organic).map((r) => ({ title: str(r.title), url: str(r.link), snippet: str(r.snippet) }));
      break;
    case "google-pse": {
      // Google takes the key in the query string, not a header.
      const [cx, apiKey] = split(key);
      req = getJson(`https://www.googleapis.com/customsearch/v1?${qs({ key: apiKey, cx, q: query, num: String(Math.min(n, 10)) })}`);
      read = (j) => list(j.items).map((r) => ({ title: str(r.title), url: str(r.link), snippet: str(r.snippet) }));
      break;
    }
    case "linkup":
      req = postJson("https://api.linkup.so/v1/search", bearer, { q: query, depth: "standard", outputType: "searchResults", maxResults: n });
      read = (j) => list(j.results).map((r) => ({ title: str(r.name) || str(r.title), url: str(r.url), snippet: str(r.content) || str(r.snippet) }));
      break;
    case "searchapi":
      req = getJson(`https://www.searchapi.io/api/v1/search?${qs({ engine: "google", q: query, api_key: key })}`);
      read = (j) => list(j.organic_results).map((r) => ({ title: str(r.title), url: str(r.link), snippet: str(r.snippet) || str(r.description) }));
      break;
    case "youcom":
      req = getJson(`https://ydc-index.io/v1/search?${qs({ query, count: String(n) })}`, { "x-api-key": key });
      read = (j) =>
        list(obj(j.results).web).map((r) => {
          const first = Array.isArray(r.snippets) ? r.snippets.find((s) => typeof s === "string") : undefined;
          return { title: str(r.title), url: str(r.url), snippet: str(first) || str(r.description) };
        });
      break;
    case "perplexity":
      req = postJson("https://api.perplexity.ai/search", bearer, { query, max_results: n });
      read = (j) => list(j.results).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.snippet) }));
      break;
    case "tinyfish":
      // No count parameter; the answer is cut to n below.
      req = getJson(`https://api.search.tinyfish.ai?${qs({ query })}`, { "x-api-key": key });
      read = (j) => list(j.results).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.snippet) }));
      break;
    case "ollama":
      req = postJson("https://ollama.com/api/web_search", bearer, { query, max_results: n });
      read = (j) => list(j.results).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content) || str(r.snippet) }));
      break;
    case "searxng": {
      // `key` is the owner's instance address; SearXNG answers JSON only when the instance allows `format=json`.
      const base = key.replace(/\/+$/, "");
      req = getJson(`${base.endsWith("/search") ? base : `${base}/search`}?${qs({ q: query, format: "json", categories: "general" })}`);
      read = (j) => list(j.results).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content) || str(r.snippet) }));
      break;
    }
    case "xquik":
      req = getJson(`https://xquik.com/api/v1/x/tweets/search?${qs({ q: query, limit: String(n) })}`, { "x-api-key": key });
      read = (j) => list(j.tweets).map(xPost);
      break;
    default:
      throw { status: 400, message: `${id} is not a search provider` };
  }
  return read(await call(up, req, id))
    .filter((r) => r.url)
    .slice(0, n);
}

async function fetchWith(up: Upstream, id: WebToolId, key: string | null, url: string): Promise<FetchResult> {
  if (id === "jina") {
    const headers: Record<string, string> = { accept: "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const j = await call(up, new Request(`https://r.jina.ai/${url}`, { headers }), id);
    const d = (j.data ?? {}) as Record<string, unknown>;
    return { title: str(d.title) || null, content: str(d.content).slice(0, MAX_CONTENT) };
  }
  if (id === "firecrawl" && key) {
    const j = await call(
      up,
      new Request("https://api.firecrawl.dev/v1/scrape", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ url, formats: ["markdown"] }) }),
      id,
    );
    const d = (j.data ?? {}) as Record<string, unknown>;
    const meta = (d.metadata ?? {}) as Record<string, unknown>;
    return { title: str(meta.title) || null, content: str(d.markdown).slice(0, MAX_CONTENT) };
  }
  if (id === "cloudflare" && key) {
    const cut = key.indexOf(":");
    const account = key.slice(0, cut);
    const token = key.slice(cut + 1);
    const j = await call(
      up,
      new Request(`https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/markdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      id,
    );
    if (j.success !== true || typeof j.result !== "string") throw { status: 502, message: `${id} answered: ${cfError(j) ?? "no result"}` };
    const meta = (j.meta ?? {}) as Record<string, unknown>;
    return { title: str(meta.title) || null, content: j.result.slice(0, MAX_CONTENT) };
  }
  if (!key) throw { status: 400, message: `${id} is not a fetch provider` };
  // A provider that answers 200 without the page counts as a failure, so the next one is tried.
  const none = () => ({ status: 502, message: `${id} returned no content for the page` });
  if (id === "tavily") {
    const j = await call(up, postJson("https://api.tavily.com/extract", { authorization: `Bearer ${key}` }, { urls: [url], extract_depth: "basic", format: "markdown" }), id);
    const first = list(j.results)[0];
    if (!first || typeof first.raw_content !== "string") throw none();
    return { title: str(first.title) || null, content: first.raw_content.slice(0, MAX_CONTENT) };
  }
  if (id === "exa") {
    const j = await call(up, postJson("https://api.exa.ai/contents", { "x-api-key": key }, { ids: [url], text: true }), id);
    const first = list(j.results)[0];
    if (!first || typeof first.text !== "string") throw none();
    return { title: str(first.title) || null, content: first.text.slice(0, MAX_CONTENT) };
  }
  if (id === "tinyfish") {
    const j = await call(up, postJson("https://api.fetch.tinyfish.ai", { "x-api-key": key }, { urls: [url], format: "markdown" }), id);
    const failed = list(j.errors)[0];
    if (failed) throw { status: typeof failed.status === "number" && failed.status >= 400 && failed.status < 600 ? failed.status : 502, message: `${id} could not fetch the page` };
    const first = list(j.results)[0];
    if (!first || typeof first.text !== "string") throw none();
    return { title: str(first.title) || null, content: first.text.slice(0, MAX_CONTENT) };
  }
  if (id === "ollama") {
    const j = await call(up, postJson("https://ollama.com/api/web_fetch", { authorization: `Bearer ${key}` }, { url }), id);
    if (typeof j.content !== "string") throw none();
    return { title: str(j.title) || null, content: j.content.slice(0, MAX_CONTENT) };
  }
  throw { status: 400, message: `${id} is not a fetch provider` };
}

async function call(up: Upstream, req: Request, id: WebToolId): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await up(new Request(req, { signal: AbortSignal.timeout(20_000) }));
  } catch {
    throw { status: 502, message: `could not reach ${id}` };
  }
  if (!res.ok) {
    // Cloudflare's API says why in `errors`; the other providers' bodies are not read.
    const why = id === "cloudflare" ? cfError(await res.json().catch(() => null)) : (await res.body?.cancel(), null);
    throw { status: res.status, message: `${id} answered ${res.status}${why ? `: ${why}` : ""}` };
  }
  const j = (await res.json().catch(() => null)) as unknown;
  if (!j || typeof j !== "object") throw { status: 502, message: `${id} answered something that is not JSON` };
  return j as Record<string, unknown>;
}

/** The first message of a Cloudflare API `errors` list, kept short. */
function cfError(j: unknown): string | null {
  const errors = j && typeof j === "object" ? (j as { errors?: unknown }).errors : null;
  const first = Array.isArray(errors) ? (errors[0] as { message?: unknown } | undefined) : undefined;
  return typeof first?.message === "string" && first.message ? first.message.slice(0, 200) : null;
}

const failOf = (e: unknown) => (e && typeof e === "object" && "status" in e ? (e as { status: number; message: string }) : { status: 502, message: "error" });

function isWebUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 2000) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Registers /v1/search and /v1/fetch on the OpenAI surface (openai.ts), before its 404. */
export function webToolRoutes(r: Hono<AppEnv>, upstream: Upstream, gateError: (g: GateFailure) => Response): void {
  const body = async (c: Context<AppEnv>) => (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  r.post("/v1/search", async (c) => {
    const g = await checkSystem(c.env, c.req.raw, false);
    if (!g.ok) return gateError(g);
    const b = await body(c);
    const query = typeof b?.query === "string" ? b.query.trim() : "";
    if (!query || query.length > 500) return errorResponse(400, "query: 1 to 500 characters", "invalid_request_error");
    const n = typeof b?.max_results === "number" && Number.isInteger(b.max_results) ? Math.min(Math.max(b.max_results, 1), MAX_RESULTS) : 5;
    const tried: string[] = [];
    for (const id of (await getOrder(c.env.DB)).search) {
      const key = await keyOf(c.env, id);
      if (!key) continue;
      try {
        return c.json({ query, provider: id, results: await searchWith(upstream, id, key, query, n) });
      } catch (e) {
        const f = failOf(e);
        tried.push(`${id} ${f.status}`);
      }
    }
    if (tried.length === 0) return errorResponse(500, "not_configured: no web search provider has a key", "server_error", "not_configured", { "x-should-retry": "false" });
    return errorResponse(502, `every search provider failed: ${tried.join(", ")}`, "api_error");
  });

  r.post("/v1/fetch", async (c) => {
    const g = await checkSystem(c.env, c.req.raw, false);
    if (!g.ok) return gateError(g);
    const b = await body(c);
    if (!isWebUrl(b?.url)) return errorResponse(400, "url: an http(s) address", "invalid_request_error");
    const url = b.url as string;
    const tried: string[] = [];
    for (const id of (await getOrder(c.env.DB)).fetch) {
      const key = await keyOf(c.env, id);
      if (!key && !def(id).keyless) continue;
      try {
        return c.json({ url, provider: id, ...(await fetchWith(upstream, id, key, url)) });
      } catch (e) {
        tried.push(`${id} ${failOf(e).status}`);
      }
    }
    return errorResponse(502, `every fetch provider failed: ${tried.join(", ") || "none available"}`, "api_error");
  });
}

/** The console's Web tools page. A key is never answered: only whether one is set and its last 4 characters. */
export function webToolAdminRoutes(a: Hono<AppEnv>, upstream: Upstream): void {
  const list = async (db: D1Database) => {
    const rows = (await db.prepare("SELECT id, hint, updated_at FROM web_tool").all<{ id: string; hint: string; updated_at: number }>()).results;
    const order = await getOrder(db);
    const view = (kind: Kind) => (id: WebToolId) => {
      const r = rows.find((x) => x.id === id);
      const d = def(id);
      return {
        id,
        name: d.name,
        kind,
        kinds: d.kinds,
        key_url: d.keyUrl,
        keyless: d.keyless === true,
        needs_account: d.extra === "account_id",
        /** The setting asked for beside the key ("account_id" | "cx"), or "base_url" for an instance with no key. */
        needs: d.instance ? "base_url" : (d.extra ?? null),
        needs_key: d.instance !== true,
        configured: r !== undefined,
        hint: r?.hint ?? null,
        updated_at: r?.updated_at ?? null,
      };
    };
    return { search: order.search.map(view("search")), fetch: order.fetch.map(view("fetch")), order };
  };

  a.get("/web-tools", async (c) => c.json(await list(c.env.DB)));

  a.put("/web-tools/order", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const ok = (kind: Kind) => {
      const v = b?.[kind];
      return Array.isArray(v) && v.every((t) => isTool(t) && serves(t, kind)) && new Set(v).size === v.length;
    };
    if (!b || !ok("search") || !ok("fetch")) return c.json({ error: "invalid_input", hint: "search and fetch: lists of that kind's tool ids" }, 400);
    await c.env.DB.prepare("INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(ORDER_KEY, JSON.stringify({ search: b.search, fetch: b.fetch }), Math.floor(Date.now() / 1000))
      .run();
    return c.json(await list(c.env.DB));
  });

  a.put("/web-tools/:id", async (c) => {
    const id = c.req.param("id");
    if (!isTool(id)) return c.json({ error: "not_found" }, 404);
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const d = def(id);
    let secret: string;
    let hint: string;
    if (d.instance) {
      const raw = typeof b?.base_url === "string" ? b.base_url.trim() : "";
      if (raw.length > 500 || !isWebUrl(raw)) return c.json({ error: "invalid_input", field: "base_url" }, 400);
      const u = new URL(raw);
      u.hash = "";
      secret = u.toString();
      hint = u.host;
    } else {
      const key = typeof b?.api_key === "string" ? b.api_key.trim() : "";
      if (key.length < 8 || key.length > 512 || /\s/.test(key)) return c.json({ error: "invalid_input", field: "api_key" }, 400);
      secret = key;
      hint = key.slice(-4);
      if (d.extra === "account_id") {
        const account = typeof b?.account_id === "string" ? b.account_id.trim().toLowerCase() : "";
        if (!/^[0-9a-f]{32}$/.test(account)) return c.json({ error: "invalid_input", field: "account_id" }, 400);
        secret = `${account}:${key}`;
      } else if (d.extra === "cx") {
        const cx = typeof b?.cx === "string" ? b.cx.trim() : "";
        if (!/^[A-Za-z0-9:_-]{5,100}$/.test(cx)) return c.json({ error: "invalid_input", field: "cx" }, 400);
        secret = `${cx}\n${key}`;
      }
    }
    const sealed = await seal(c.env, secret);
    if (!sealed) return c.json({ error: "not_configured", message: "CONNECTIONS_KEY is not set" }, 500);
    await c.env.DB.prepare("INSERT INTO web_tool (id, secret, hint, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, hint = excluded.hint, updated_at = excluded.updated_at")
      .bind(id, sealed, hint, Math.floor(Date.now() / 1000))
      .run();
    return c.json(await list(c.env.DB));
  });

  a.delete("/web-tools/:id", async (c) => {
    const id = c.req.param("id");
    if (!isTool(id)) return c.json({ error: "not_found" }, 404);
    await c.env.DB.prepare("DELETE FROM web_tool WHERE id = ?").bind(id).run();
    return c.body(null, 204);
  });

  /** One small search or fetch with this tool alone; `?kind=fetch` picks the kind of a tool that serves both. */
  a.post("/web-tools/:id/test", async (c) => {
    const id = c.req.param("id");
    if (!isTool(id)) return c.json({ error: "not_found" }, 404);
    const asked = c.req.query("kind");
    const kind: Kind = asked === "search" || asked === "fetch" ? asked : def(id).kinds[0]!;
    if (!serves(id, kind)) return c.json({ error: "invalid_input", field: "kind" }, 400);
    const key = await keyOf(c.env, id);
    if (!key && !def(id).keyless) return c.json({ ok: false, status: 0, message: "no key set" });
    const t0 = Date.now();
    try {
      if (kind === "search") await searchWith(upstream, id, key!, "ai-router", 1);
      else await fetchWith(upstream, id, key, "https://example.com/");
      return c.json({ ok: true, ms: Date.now() - t0 });
    } catch (e) {
      const f = failOf(e);
      return c.json({ ok: false, status: f.status, message: f.message, ms: Date.now() - t0 });
    }
  });
}
