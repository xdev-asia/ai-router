import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, type FakeUpstream } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const admin = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (token: string, body: unknown) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "fake-cf-token-not-real-0042";
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-rendering/markdown`;

beforeEach(reset);

describe("Cloudflare Browser Rendering as a fetch provider", () => {
  it("needs an account id beside the token, and answers neither", async () => {
    const up = fakeUpstream(() => json({}));
    expect((await admin(up, "PUT", "/web-tools/cloudflare", { api_key: TOKEN })).res.status).toBe(400);
    expect((await admin(up, "PUT", "/web-tools/cloudflare", { api_key: TOKEN, account_id: "not-hex" })).res.status).toBe(400);
    const r = await admin(up, "PUT", "/web-tools/cloudflare", { api_key: TOKEN, account_id: ACCOUNT });
    expect(r.res.status, r.text).toBe(200);
    expect(r.text).not.toContain(TOKEN);
    expect(r.text).not.toContain(ACCOUNT);
    const tool = JSON.parse(r.text).fetch.find((t: { id: string }) => t.id === "cloudflare");
    expect(tool).toMatchObject({ name: "Cloudflare Browser Rendering", kind: "fetch", configured: true, hint: "0042", needs_account: true });
    const row = await env.DB.prepare("SELECT * FROM web_tool WHERE id = 'cloudflare'").first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain(ACCOUNT);
  });

  it("fetches a page as Markdown from the account's /browser-rendering/markdown with the token", async () => {
    const token = await addSystem("web");
    const up = fakeUpstream((req) =>
      req.url === ENDPOINT ? json({ success: true, result: "# Example Domain\n\nThis domain is for examples.", meta: { title: "Example Domain", status: 200 } }) : json({}, 404),
    );
    await admin(up, "PUT", "/web-tools/cloudflare", { api_key: TOKEN, account_id: ACCOUNT });
    await admin(up, "PUT", "/web-tools/order", { search: ["tavily", "brave", "exa", "serper"], fetch: ["cloudflare", "jina", "firecrawl"] });
    const { res, text } = await call(up, "/v1/fetch", post(token, { url: "https://example.com/" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({ url: "https://example.com/", provider: "cloudflare", title: "Example Domain", content: "# Example Domain\n\nThis domain is for examples." });
    const sent = up.calls.find((r) => r.url === ENDPOINT)!;
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(up.bodies[up.calls.indexOf(sent)]!)).toEqual({ url: "https://example.com/" });
    expect(text).not.toContain(TOKEN);
  });

  it("falls back to the next provider when Cloudflare answers success: false", async () => {
    const token = await addSystem("web");
    const up = fakeUpstream((req) =>
      req.url === ENDPOINT
        ? json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] })
        : json({ data: { title: "Example", content: "Example Domain" } }),
    );
    await admin(up, "PUT", "/web-tools/cloudflare", { api_key: TOKEN, account_id: ACCOUNT });
    await admin(up, "PUT", "/web-tools/order", { search: ["tavily", "brave", "exa", "serper"], fetch: ["cloudflare", "jina", "firecrawl"] });
    const { res, text } = await call(up, "/v1/fetch", post(token, { url: "https://example.com/" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text).provider).toBe("jina");
  });

  it("the test button reports Cloudflare's own error message", async () => {
    const up = fakeUpstream(() => json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403));
    await admin(up, "PUT", "/web-tools/cloudflare", { api_key: TOKEN, account_id: ACCOUNT });
    const r = await admin(up, "POST", "/web-tools/cloudflare/test");
    expect(JSON.parse(r.text)).toMatchObject({ ok: false, status: 403, message: "cloudflare answered 403: Authentication error" });
    expect(r.text).not.toContain(ACCOUNT);
    expect(r.text).not.toContain(TOKEN);
  });
});
