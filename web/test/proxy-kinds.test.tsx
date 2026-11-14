import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { Media, type WebTool } from "../pages/Media";
import { ProxyPools, batchName, entriesOf, hasRelay, poolCounts, validEntry, type ProxyPool } from "../pages/ProxyPools";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Made-up values: no real key, token or password ever goes in a test. */
const FAKE_PASS = "fake-proxy-pass-not-real-91";
const FAKE_TOKEN = "fake-cf-token-not-real-0042";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

let calls: { method: string; url: string; body: unknown }[];
let routes: Record<string, (body?: unknown) => Response>;

beforeEach(() => {
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  window.location.hash = "";
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${url.split("?")[0]}`];
    return route ? route(calls[calls.length - 1].body) : json({ error: "not_found" }, 404);
  });
});

afterEach(() => {
  cleanup();
  act(() => setAuth(null));
  vi.unstubAllGlobals();
});

describe("proxy pool entries", () => {
  it("accepts https relays and http or socks5 proxies, as the worker does", () => {
    expect(validEntry("https://relay.example.com")).toBe(true);
    expect(validEntry("http://198.51.100.4:3128")).toBe(true);
    expect(validEntry("socks5://user:pass@203.0.113.7:1080")).toBe(true);
    expect(validEntry("socks5h://203.0.113.7")).toBe(true);
    expect(validEntry("https://user:pw@relay.example.com")).toBe(false);
    expect(validEntry("socks4://203.0.113.7:1080")).toBe(false);
    expect(validEntry("http://198.51.100.4:3128/path")).toBe(false);
    expect(validEntry("http://198.51.100.4:25")).toBe(false);
    expect(validEntry("socks5://user@203.0.113.7:1080")).toBe(false);
    expect(hasRelay(["socks5://203.0.113.7:1080"])).toBe(false);
    expect(hasRelay(["socks5://203.0.113.7:1080", "https://relay.example.com"])).toBe(true);
  });
});

describe("proxy pools with proxies", () => {
  let pools: ProxyPool[];
  beforeEach(() => {
    pools = [];
    routes["GET /admin/proxy-pools"] = () => json(pools);
    routes["POST /admin/proxy-pools"] = () => {
      pools = [
        {
          id: "p1",
          name: "Socks",
          relays: [],
          proxies: [{ url: "socks5://203.0.113.7:1080", kind: "socks5", has_auth: true }],
          hint: null,
          last_check: null,
          checked_at: null,
          connections: 0,
          created_at: 1,
          updated_at: 1,
        },
      ];
      return json(pools[0], 201);
    };
  });

  it("adds a SOCKS5 proxy with no relay secret and never renders its password afterwards", async () => {
    render(<ProxyPools />);
    await screen.findByText(t("pools.empty"));
    expect(screen.getByText(t("pools.intro"))).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: t("pools.add") })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(t("pools.name")), { target: { value: "Socks" } });
    fireEvent.change(within(dialog).getByLabelText(t("pools.relays")), { target: { value: `socks5://user:${FAKE_PASS}@203.0.113.7:1080` } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("pools.add") }));

    expect(await screen.findByText("Socks")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Socks", relays: [`socks5://user:${FAKE_PASS}@203.0.113.7:1080`], secret: "" });
    expect(screen.getByText(t("pools.relayCount", { n: "1" }), { exact: false })).toBeTruthy();
    expect(document.body.textContent).toContain(t("pools.proxyAuth"));
    expect(document.body.innerHTML).not.toContain(FAKE_PASS);
  });

  it("still needs the secret when an https relay is in the list", async () => {
    render(<ProxyPools />);
    await screen.findByText(t("pools.empty"));
    fireEvent.click(screen.getAllByRole("button", { name: t("pools.add") })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(t("pools.name")), { target: { value: "Mixed" } });
    fireEvent.change(within(dialog).getByLabelText(t("pools.relays")), { target: { value: "socks5://203.0.113.7:1080\nhttps://relay-1.example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("pools.add") }));
    expect(await within(dialog).findByText(t("pools.secretBad", { n: "32" }))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("names a bad entry by its line, not its text", async () => {
    render(<ProxyPools />);
    await screen.findByText(t("pools.empty"));
    fireEvent.click(screen.getAllByRole("button", { name: t("pools.add") })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(t("pools.name")), { target: { value: "Bad" } });
    fireEvent.change(within(dialog).getByLabelText(t("pools.relays")), { target: { value: `http://198.51.100.4:3128\nsocks4://user:${FAKE_PASS}@203.0.113.7` } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("pools.add") }));
    expect(await within(dialog).findByText(t("pools.entryBad", { n: "2" }))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("shows a proxy's failure reason, and edits with the stored address and no password", async () => {
    pools = [
      {
        id: "p1",
        name: "Mixed",
        relays: ["https://relay-1.example.com"],
        proxies: [{ url: "http://198.51.100.4:3128", kind: "http", has_auth: true }],
        hint: "abcd",
        last_check: [
          { url: "https://relay-1.example.com", ok: true, ms: 40 },
          { url: "http://198.51.100.4:3128", ok: false, ms: 12, error: "the proxy refused the tunnel (407)" },
        ],
        checked_at: 1,
        connections: 1,
        created_at: 1,
        updated_at: 1,
      },
    ];
    routes["PATCH /admin/proxy-pools/p1"] = () => json(pools[0]);
    render(<ProxyPools />);
    expect(await screen.findByText("Mixed")).toBeTruthy();
    expect(screen.getByText(t("pools.relayError", { url: "http://198.51.100.4:3128", error: "the proxy refused the tunnel (407)" }))).toBeTruthy();
    expect(entriesOf(pools[0])).toEqual(["https://relay-1.example.com", "http://198.51.100.4:3128"]);

    fireEvent.click(screen.getByRole("button", { name: t("pools.editName", { name: "Mixed" }) }));
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText(t("pools.relays")) as HTMLTextAreaElement).value).toBe("https://relay-1.example.com\nhttp://198.51.100.4:3128");
    fireEvent.change(within(dialog).getByLabelText(t("pools.name")), { target: { value: "Mixed 2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.save") }));
    // The list is unchanged, so only the name goes: the stored proxy password stays where it is.
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Mixed 2" }));
  });
});

describe("Cloudflare Browser Rendering key", () => {
  let cf: WebTool;
  const list = () => ({ search: [], fetch: [cf], order: { search: [], fetch: ["cloudflare"] } });
  beforeEach(() => {
    cf = { id: "cloudflare", name: "Cloudflare Browser Rendering", kind: "fetch", key_url: "https://dash.cloudflare.com/profile/api-tokens", keyless: false, needs_account: true, configured: false, hint: null, updated_at: null };
    routes["GET /admin/web-tools"] = () => json(list());
    routes["PUT /admin/web-tools/cloudflare"] = (body) => {
      cf = { ...cf, configured: true, hint: (body as { api_key: string }).api_key.slice(-4), updated_at: 1 };
      return json(list());
    };
  });

  it("asks for the account id beside the token and renders neither afterwards", async () => {
    render(<Media tab="web" />);
    expect(await screen.findByText("Cloudflare Browser Rendering")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("web.setKeyName", { name: "Cloudflare Browser Rendering" }) }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(t("web.apiKey")), { target: { value: FAKE_TOKEN } });
    fireEvent.change(within(dialog).getByLabelText(t("web.accountId")), { target: { value: "not-an-id" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.save") }));
    expect(await within(dialog).findByText(t("web.accountIdBad"))).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    fireEvent.change(within(dialog).getByLabelText(t("web.accountId")), { target: { value: ACCOUNT.toUpperCase() } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.save") }));
    expect(await screen.findByText(t("web.keyHint", { hint: "0042" }))).toBeTruthy();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ api_key: FAKE_TOKEN, account_id: ACCOUNT });
    expect(document.body.innerHTML).not.toContain(FAKE_TOKEN);
    expect(document.body.innerHTML).not.toContain(ACCOUNT);
  });
});

describe("proxy pool counts and batch import", () => {
  const pool = (id: string, ok: boolean | null): ProxyPool => ({
    id,
    name: id,
    relays: [],
    proxies: [{ url: "http://198.51.100.4:3128", kind: "http", has_auth: false }],
    hint: null,
    last_check: ok === null ? null : [{ url: "http://198.51.100.4:3128", ok, ms: 12 }],
    checked_at: ok === null ? null : 1,
    connections: 0,
    created_at: 1,
    updated_at: 1,
  });

  it("counts every pool, and as active those whose last test reached an exit", () => {
    expect(poolCounts([pool("a", true), pool("b", false), pool("c", null)])).toEqual({ total: 3, active: 1 });
  });

  it("names an imported proxy by its host and port, never its user name or password", () => {
    expect(batchName(`socks5://user:${FAKE_PASS}@203.0.113.7:1080`)).toBe("203.0.113.7:1080");
    expect(batchName("http://198.51.100.4")).toBe("198.51.100.4");
  });

  it("shows the counts, imports one pool per proxy line, and refuses relays and bad lines by line number", async () => {
    let pools: ProxyPool[] = [pool("old", true)];
    routes["GET /admin/proxy-pools"] = () => json(pools);
    routes["POST /admin/proxy-pools"] = (body) => {
      const b = body as { name: string };
      if (b.name === "198.51.100.9:3128") return json({ error: "bad_request", message: "refused" }, 400);
      pools = [...pools, { ...pool(b.name, null), name: b.name }];
      return json(pools[pools.length - 1], 201);
    };
    render(<ProxyPools />);
    expect(await screen.findByText(t("pools.total", { n: "1" }))).toBeTruthy();
    expect(screen.getByText(t("pools.active", { n: "1" }))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t("pools.batch") }));
    let dialog = screen.getByRole("dialog");
    const box = within(dialog).getByLabelText(t("pools.batchField"));
    fireEvent.change(box, { target: { value: "http://198.51.100.4:3128\nhttps://relay-1.example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("pools.batchSubmit") }));
    expect(await within(dialog).findByText(t("pools.batchBad", { n: "2" }))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.change(box, { target: { value: `socks5://user:${FAKE_PASS}@203.0.113.7:1080\n\nhttp://198.51.100.9:3128\nsocks5://user:${FAKE_PASS}@203.0.113.7:1080` } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("pools.batchSubmit") }));
    await waitFor(() => expect(screen.getByText(t("pools.total", { n: "2" }))).toBeTruthy());
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.body);
    expect(posts).toEqual([
      { name: "203.0.113.7:1080", relays: [`socks5://user:${FAKE_PASS}@203.0.113.7:1080`], secret: "" },
      { name: "198.51.100.9:3128", relays: ["http://198.51.100.9:3128"], secret: "" },
    ]);
    expect(await screen.findByText(t("pools.batchSome", { failed: "1", total: "2", lines: "3" }))).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(FAKE_PASS);
  });
});
