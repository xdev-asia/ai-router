import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, type FakeUpstream } from "./helpers";

/** The other search and fetch providers. Every key here is made up; none is ever echoed. */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const admin = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (token: string, body: unknown) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

const KEY = "fake-web-key-not-real-7777";
const CX = "017576662512468239146:omuauf_lfve";
const SEARX = "https://searx.example.org/";

beforeEach(reset);

type Sent = { req: Request; body: string };
interface SearchCase {
  id: string;
  put: Record<string, unknown>;
  url: string;
  reply: unknown;
  check: (s: Sent) => void;
  want: { title: string; url: string; snippet: string }[];
}

const bearer = (s: Sent) => expect(s.req.headers.get("authorization")).toBe(`Bearer ${KEY}`);
const xKey = (s: Sent) => expect(s.req.headers.get("x-api-key")).toBe(KEY);
const HONO = { title: "Hono", url: "https://hono.dev/", snippet: "Web framework" };

const SEARCH: SearchCase[] = [
  {
    id: "google-pse",
    put: { api_key: KEY, cx: CX },
    url: `https://www.googleapis.com/customsearch/v1?${new URLSearchParams({ key: KEY, cx: CX, q: "hono", num: "2" })}`,
    reply: { items: [{ title: "Hono", link: "https://hono.dev/", snippet: "Web framework" }] },
    check: (s) => expect(s.req.method).toBe("GET"),
    want: [HONO],
  },
  {
    id: "linkup",
    put: { api_key: KEY },
    url: "https://api.linkup.so/v1/search",
    reply: { results: [{ type: "text", name: "Hono", url: "https://hono.dev/", content: "Web framework" }] },
    check: (s) => {
      expect(s.req.method).toBe("POST");
      bearer(s);
      expect(JSON.parse(s.body)).toEqual({ q: "hono", depth: "standard", outputType: "searchResults", maxResults: 2 });
    },
    want: [HONO],
  },
  {
    id: "searchapi",
    put: { api_key: KEY },
    url: `https://www.searchapi.io/api/v1/search?${new URLSearchParams({ engine: "google", q: "hono", api_key: KEY })}`,
    reply: { organic_results: [{ title: "Hono", link: "https://hono.dev/", snippet: "Web framework" }, { title: "B", link: "https://b.example/", snippet: "b" }, { title: "C", link: "https://c.example/", snippet: "c" }] },
    check: (s) => expect(s.req.method).toBe("GET"),
    want: [HONO, { title: "B", url: "https://b.example/", snippet: "b" }],
  },
  {
    id: "youcom",
    put: { api_key: KEY },
    url: `https://ydc-index.io/v1/search?${new URLSearchParams({ query: "hono", count: "2" })}`,
    reply: { results: { web: [{ title: "Hono", url: "https://hono.dev/", description: "Ultrafast", snippets: ["Web framework"] }] } },
    check: xKey,
    want: [HONO],
  },
  {
    id: "xquik",
    put: { api_key: KEY },
    url: `https://xquik.com/api/v1/x/tweets/search?${new URLSearchParams({ q: "hono", limit: "2" })}`,
    reply: { tweets: [{ id: "1234", text: "Hono is fast", author: { username: "honojs", name: "Hono" } }] },
    check: xKey,
    want: [{ title: "@honojs on X", url: "https://x.com/honojs/status/1234", snippet: "Hono is fast" }],
  },
  {
    id: "tinyfish",
    put: { api_key: KEY },
    url: "https://api.search.tinyfish.ai/?query=hono",
    reply: { results: [{ title: "Hono", url: "https://hono.dev/", snippet: "Web framework" }, { title: "B", url: "https://b.example/", snippet: "b" }, { title: "C", url: "https://c.example/", snippet: "c" }] },
    check: xKey,
    want: [HONO, { title: "B", url: "https://b.example/", snippet: "b" }],
  },
  {
    id: "ollama",
    put: { api_key: KEY },
    url: "https://ollama.com/api/web_search",
    reply: { results: [{ title: "Hono", url: "https://hono.dev/", content: "Web framework" }] },
    check: (s) => {
      expect(s.req.method).toBe("POST");
      bearer(s);
      expect(JSON.parse(s.body)).toEqual({ query: "hono", max_results: 2 });
    },
    want: [HONO],
  },
  {
    id: "perplexity",
    put: { api_key: KEY },
    url: "https://api.perplexity.ai/search",
    reply: { id: "x", results: [{ title: "Hono", url: "https://hono.dev/", snippet: "Web framework", date: "2025-01-01" }] },
    check: (s) => {
      expect(s.req.method).toBe("POST");
      bearer(s);
      expect(JSON.parse(s.body)).toEqual({ query: "hono", max_results: 2 });
    },
    want: [HONO],
  },
  {
    id: "searxng",
    put: { base_url: SEARX },
    url: `https://searx.example.org/search?${new URLSearchParams({ q: "hono", format: "json", categories: "general" })}`,
    reply: { results: [{ title: "Hono", url: "https://hono.dev/", content: "Web framework", engine: "duckduckgo" }] },
    check: (s) => {
      expect(s.req.method).toBe("GET");
      expect(s.req.headers.get("authorization")).toBeNull();
    },
    want: [HONO],
  },
];

describe("more web search providers", () => {
  for (const c of SEARCH) {
    it(`${c.id}: sends the query the way its API reads it and maps the answer`, async () => {
      const token = await addSystem("web");
      const up = fakeUpstream((req) => (req.url === c.url ? json(c.reply) : json({}, 404)));
      const put = await admin(up, "PUT", `/web-tools/${c.id}`, c.put);
      expect(put.res.status, put.text).toBe(200);
      expect(put.text).not.toContain(KEY);
      expect((await admin(up, "PUT", "/web-tools/order", { search: [c.id], fetch: [] })).res.status).toBe(200);
      const { res, text } = await call(up, "/v1/search", post(token, { query: "hono", max_results: 2 }));
      expect(res.status, text).toBe(200);
      expect(JSON.parse(text)).toEqual({ query: "hono", provider: c.id, results: c.want });
      expect(text).not.toContain(KEY);
      const i = up.calls.findIndex((r) => r.url === c.url);
      expect(i, up.calls.map((r) => r.url).join("\n")).toBeGreaterThanOrEqual(0);
      c.check({ req: up.calls[i]!, body: up.bodies[i]! });
    });
  }

  it("a failing provider's error names its status, never its key", async () => {
    const token = await addSystem("web");
    const up = fakeUpstream(() => json({ error: { message: `bad key ${KEY}` } }, 403));
    await admin(up, "PUT", "/web-tools/google-pse", { api_key: KEY, cx: CX });
    await admin(up, "PUT", "/web-tools/searchapi", { api_key: KEY });
    await admin(up, "PUT", "/web-tools/order", { search: ["google-pse", "searchapi"], fetch: [] });
    const { res, text } = await call(up, "/v1/search", post(token, { query: "hono" }));
    expect(res.status).toBe(502);
    expect(text).toContain("google-pse 403");
    expect(text).toContain("searchapi 403");
    expect(text).not.toContain(KEY);
  });

  it("Google PSE needs a search engine id beside the key; neither is answered", async () => {
    const up = fakeUpstream(() => json({}));
    expect((await admin(up, "PUT", "/web-tools/google-pse", { api_key: KEY })).res.status).toBe(400);
    expect((await admin(up, "PUT", "/web-tools/google-pse", { api_key: KEY, cx: "has space" })).res.status).toBe(400);
    const r = await admin(up, "PUT", "/web-tools/google-pse", { api_key: KEY, cx: CX });
    expect(r.res.status, r.text).toBe(200);
    expect(r.text).not.toContain(KEY);
    expect(r.text).not.toContain(CX);
    expect(JSON.parse(r.text).search.find((t: { id: string }) => t.id === "google-pse")).toMatchObject({ configured: true, hint: "7777", needs: "cx", needs_key: true });
    const row = await env.DB.prepare("SELECT * FROM web_tool WHERE id = 'google-pse'").first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(KEY);
  });

  it("SearXNG takes an instance address and no key", async () => {
    const up = fakeUpstream(() => json({}));
    const before = JSON.parse((await admin(up, "GET", "/web-tools")).text).search.find((t: { id: string }) => t.id === "searxng");
    expect(before).toMatchObject({ needs: "base_url", needs_key: false, keyless: false, configured: false });
    expect((await admin(up, "PUT", "/web-tools/searxng", {})).res.status).toBe(400);
    expect((await admin(up, "PUT", "/web-tools/searxng", { base_url: "ftp://searx.example.org" })).res.status).toBe(400);
    expect((await admin(up, "PUT", "/web-tools/searxng", { base_url: "https://user:pw@searx.example.org" })).res.status).toBe(400);
    const r = await admin(up, "PUT", "/web-tools/searxng", { base_url: "https://searx.example.org/search" });
    expect(r.res.status, r.text).toBe(200);
    expect(JSON.parse(r.text).search.find((t: { id: string }) => t.id === "searxng")).toMatchObject({ configured: true, hint: "searx.example.org" });
  });

  it("SearXNG's test button searches the owner's instance", async () => {
    const up = fakeUpstream((req) => (req.url.startsWith("https://searx.example.org/search?") ? json({ results: [] }) : json({}, 404)));
    await admin(up, "PUT", "/web-tools/searxng", { base_url: "https://searx.example.org/search" });
    const r = await admin(up, "POST", "/web-tools/searxng/test");
    expect(JSON.parse(r.text)).toMatchObject({ ok: true });
  });
});

interface FetchCase {
  id: string;
  url: string;
  reply: unknown;
  check: (s: Sent) => void;
  want: { title: string | null; content: string };
}

const PAGE = "https://example.com/";
const FETCH: FetchCase[] = [
  {
    id: "tavily",
    url: "https://api.tavily.com/extract",
    reply: { results: [{ url: PAGE, raw_content: "# Example Domain" }], failed_results: [] },
    check: (s) => {
      bearer(s);
      expect(JSON.parse(s.body)).toEqual({ urls: [PAGE], extract_depth: "basic", format: "markdown" });
    },
    want: { title: null, content: "# Example Domain" },
  },
  {
    id: "exa",
    url: "https://api.exa.ai/contents",
    reply: { results: [{ id: PAGE, url: PAGE, title: "Example Domain", text: "This domain is for examples." }] },
    check: (s) => {
      xKey(s);
      expect(JSON.parse(s.body)).toEqual({ ids: [PAGE], text: true });
    },
    want: { title: "Example Domain", content: "This domain is for examples." },
  },
  {
    id: "tinyfish",
    url: "https://api.fetch.tinyfish.ai/",
    reply: { results: [{ url: PAGE, title: "Example Domain", text: "# Example Domain" }], errors: [] },
    check: (s) => {
      xKey(s);
      expect(JSON.parse(s.body)).toEqual({ urls: [PAGE], format: "markdown" });
    },
    want: { title: "Example Domain", content: "# Example Domain" },
  },
  {
    id: "ollama",
    url: "https://ollama.com/api/web_fetch",
    reply: { title: "Example Domain", content: "This domain is for examples.", links: ["https://iana.org/"] },
    check: (s) => {
      bearer(s);
      expect(JSON.parse(s.body)).toEqual({ url: PAGE });
    },
    want: { title: "Example Domain", content: "This domain is for examples." },
  },
];

describe("more web fetch providers", () => {
  for (const c of FETCH) {
    it(`${c.id}: fetches a page through its API and maps the answer`, async () => {
      const token = await addSystem("web");
      const up = fakeUpstream((req) => (req.url === c.url ? json(c.reply) : json({}, 404)));
      expect((await admin(up, "PUT", `/web-tools/${c.id}`, { api_key: KEY })).res.status).toBe(200);
      expect((await admin(up, "PUT", "/web-tools/order", { search: [], fetch: [c.id] })).res.status).toBe(200);
      const { res, text } = await call(up, "/v1/fetch", post(token, { url: PAGE }));
      expect(res.status, text).toBe(200);
      expect(JSON.parse(text)).toEqual({ url: PAGE, provider: c.id, ...c.want });
      expect(text).not.toContain(KEY);
      const i = up.calls.findIndex((r) => r.url === c.url);
      expect(i, up.calls.map((r) => r.url).join("\n")).toBeGreaterThanOrEqual(0);
      expect(up.calls[i]!.method).toBe("POST");
      c.check({ req: up.calls[i]!, body: up.bodies[i]! });
    });
  }

  it("falls back to the next provider when TinyFish reports a per-page error", async () => {
    const token = await addSystem("web");
    const up = fakeUpstream((req) =>
      req.url === "https://api.fetch.tinyfish.ai/" ? json({ results: [], errors: [{ url: PAGE, status: 403, error: "blocked" }] }) : json({ data: { title: "Example", content: "Example Domain" } }),
    );
    await admin(up, "PUT", "/web-tools/tinyfish", { api_key: KEY });
    await admin(up, "PUT", "/web-tools/order", { search: [], fetch: ["tinyfish", "jina"] });
    const { res, text } = await call(up, "/v1/fetch", post(token, { url: PAGE }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text).provider).toBe("jina");
  });

  it("falls back when Tavily extracts nothing from the page", async () => {
    const token = await addSystem("web");
    const up = fakeUpstream((req) => (req.url === "https://api.tavily.com/extract" ? json({ results: [], failed_results: [{ url: PAGE, error: "x" }] }) : json({ data: { title: "Example", content: "Example Domain" } })));
    await admin(up, "PUT", "/web-tools/tavily", { api_key: KEY });
    await admin(up, "PUT", "/web-tools/order", { search: [], fetch: ["tavily", "jina"] });
    const { res, text } = await call(up, "/v1/fetch", post(token, { url: PAGE }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text).provider).toBe("jina");
  });
});

describe("a tool that serves both kinds", () => {
  it("is listed under search and fetch with one key, and either order may hold it", async () => {
    const up = fakeUpstream(() => json({}));
    await admin(up, "PUT", "/web-tools/tavily", { api_key: KEY });
    const r = await admin(up, "PUT", "/web-tools/order", { search: ["tavily"], fetch: ["tavily", "jina"] });
    expect(r.res.status, r.text).toBe(200);
    const tools = JSON.parse(r.text) as { search: { id: string; kind: string; configured: boolean }[]; fetch: { id: string; kind: string; configured: boolean }[] };
    expect(tools.search[0]).toMatchObject({ id: "tavily", kind: "search", configured: true });
    expect(tools.fetch[0]).toMatchObject({ id: "tavily", kind: "fetch", configured: true });
    for (const id of ["tavily", "exa", "tinyfish", "ollama"]) {
      expect(tools.search.some((t) => t.id === id), id).toBe(true);
      expect(tools.fetch.some((t) => t.id === id), id).toBe(true);
    }
    // A search-only tool still cannot sit in the fetch order.
    expect((await admin(up, "PUT", "/web-tools/order", { search: [], fetch: ["serper"] })).res.status).toBe(400);
  });

  it("keeps Jina first in the fetch order when the owner never set one", async () => {
    const up = fakeUpstream(() => json({}));
    const tools = JSON.parse((await admin(up, "GET", "/web-tools")).text) as { order: { search: string[]; fetch: string[] } };
    expect(tools.order.fetch.slice(0, 3)).toEqual(["jina", "firecrawl", "cloudflare"]);
    expect(tools.order.search.slice(0, 4)).toEqual(["tavily", "brave", "exa", "serper"]);
  });

  it("the test button tries the kind it is asked for", async () => {
    const up = fakeUpstream((req) => (req.url === "https://api.tavily.com/extract" ? json({ results: [{ url: PAGE, raw_content: "x" }] }) : json({}, 500)));
    await admin(up, "PUT", "/web-tools/tavily", { api_key: KEY });
    expect(JSON.parse((await admin(up, "POST", "/web-tools/tavily/test?kind=fetch")).text)).toMatchObject({ ok: true });
    expect(JSON.parse((await admin(up, "POST", "/web-tools/tavily/test")).text)).toMatchObject({ ok: false, status: 500 });
  });
});
