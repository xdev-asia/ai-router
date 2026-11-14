import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { Media, mediaExample, mediaTab, type WebTool } from "../pages/Media";
import { ProxyPools, parseRelays, validRelay, type ProxyPool } from "../pages/ProxyPools";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Made-up values: no real key or secret ever goes in a test. */
const FAKE_KEY = "fake-web-key-not-real-0042";
const FAKE_SECRET = "fake-relay-secret-not-real-000000000099";

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

describe("media page", () => {
  const PROVIDERS = [
    { id: "openai", name: "OpenAI", format: "openai", auth: "bearer", env_key: null, key_url: "", strategy: "fill-first", color: null, mark: "OA" },
    { id: "groq", name: "Groq", format: "openai", auth: "bearer", env_key: "GROQ_API_KEY", key_url: "", strategy: "fill-first", color: null, mark: "Gq" },
    { id: "mistral", name: "Mistral", format: "openai", auth: "bearer", env_key: null, key_url: "", strategy: "fill-first", color: null, mark: "Mi" },
    { id: "anthropic", name: "Anthropic", format: "anthropic", auth: "x-api-key", env_key: null, key_url: "", strategy: "fill-first", color: null, mark: "An" },
  ];
  beforeEach(() => {
    routes["GET /admin/media"] = () =>
      json({
        kinds: [
          { kind: "embeddings", path: "/v1/embeddings", body: "json" },
          { kind: "images", path: "/v1/images/generations", body: "json" },
          { kind: "video", path: "/v1/videos", body: "json" },
          { kind: "speech", path: "/v1/audio/speech", body: "json" },
          { kind: "transcription", path: "/v1/audio/transcriptions", body: "multipart" },
        ],
        providers: ["openai", "groq", "mistral"],
      });
    routes["GET /admin/providers"] = () => json(PROVIDERS);
    routes["GET /admin/connections"] = () =>
      json([
        { id: "c1", provider: "openai", auth_type: "api_key", name: "Main", hint: "abcd", disabled: false, cooldown_until: null },
        { id: "c2", provider: "anthropic", auth_type: "api_key", name: "Claude", hint: "efgh", disabled: false, cooldown_until: null },
      ]);
  });

  it("takes the tab from the hash and writes the clicked tab back to it", async () => {
    render(<Media tab="images" />);
    expect(screen.getByRole("tab", { name: t("media.tab.images") }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toContain("POST /v1/images/generations");
    expect(document.body.textContent).toContain(`${window.location.origin}/v1/images/generations`);
    expect(document.body.textContent).toContain("Bearer <your gateway token>");

    // Providers in /admin/media with a connection (OpenAI) or an env key (Groq); not Mistral (neither) nor Anthropic (not OpenAI-format).
    expect(await screen.findByText("OpenAI")).toBeTruthy();
    expect(screen.getByText("Groq")).toBeTruthy();
    expect(screen.queryByText("Mistral")).toBeNull();
    expect(screen.queryByText("Anthropic")).toBeNull();
    expect(screen.getByText("OpenAI").closest("a")?.getAttribute("href")).toBe("#/providers/openai");

    fireEvent.click(screen.getByRole("tab", { name: t("media.tab.video") }));
    expect(window.location.hash).toBe("#/media/video");
  });

  it("opens on embeddings for no tab or an unknown one, and shows an empty state with no provider", async () => {
    expect(mediaTab(null)).toBe("embeddings");
    expect(mediaTab("nope")).toBe("embeddings");
    expect(mediaTab("web")).toBe("web");
    expect(mediaExample("transcription", "https://gw.example")).toContain("-F file=@audio.mp3");

    routes["GET /admin/connections"] = () => json([]);
    routes["GET /admin/providers"] = () => json(PROVIDERS.map((p) => ({ ...p, env_key: null })));
    render(<Media tab={null} />);
    expect(screen.getByRole("tab", { name: t("media.tab.embeddings") }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText(t("media.none"))).toBeTruthy();
  });
});

describe("web tools", () => {
  let tavily: WebTool;
  const jina: WebTool = { id: "jina", name: "Jina Reader", kind: "fetch", key_url: "https://jina.ai/", keyless: true, configured: false, hint: null, updated_at: null };
  const list = () => ({ search: [tavily], fetch: [jina], order: { search: ["tavily"], fetch: ["jina"] } });

  beforeEach(() => {
    tavily = { id: "tavily", name: "Tavily", kind: "search", key_url: "https://tavily.com/", keyless: false, configured: false, hint: null, updated_at: null };
    routes["GET /admin/web-tools"] = () => json(list());
    routes["PUT /admin/web-tools/tavily"] = (body) => {
      const key = (body as { api_key: string }).api_key;
      tavily = { ...tavily, configured: true, hint: key.slice(-4), updated_at: 1 };
      return json(list());
    };
    routes["DELETE /admin/web-tools/tavily"] = () => {
      tavily = { ...tavily, configured: false, hint: null };
      return new Response(null, { status: 204 });
    };
  });

  it("sets and removes a key without ever rendering it", async () => {
    render(<Media tab="web" />);
    expect(await screen.findByText("Tavily")).toBeTruthy();
    expect(screen.getByText(t("web.keyless"))).toBeTruthy();
    expect(screen.getByRole("link", { name: t("web.getKeyAt", { name: "Tavily" }) }).getAttribute("href")).toBe("https://tavily.com/");

    fireEvent.click(screen.getByRole("button", { name: t("web.setKeyName", { name: "Tavily" }) }));
    fireEvent.change(screen.getByLabelText(t("web.apiKey")), { target: { value: FAKE_KEY } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: t("common.save") }));

    expect(await screen.findByText(t("web.keyHint", { hint: "0042" }))).toBeTruthy();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ api_key: FAKE_KEY });
    expect(document.body.innerHTML).not.toContain(FAKE_KEY);
    expect([...document.querySelectorAll("input")].some((i) => i.value === FAKE_KEY)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: t("web.removeName", { name: "Tavily" }) }));
    fireEvent.click(screen.getByRole("button", { name: t("web.remove") }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/admin/web-tools/tavily")).toBe(true));
    expect(await screen.findByText(t("web.noKey"))).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(FAKE_KEY);
  });

  it("sends both lists when the order changes", async () => {
    const brave: WebTool = { id: "brave", name: "Brave Search", kind: "search", key_url: "https://brave.com/search/api/", keyless: false, configured: true, hint: "wxyz", updated_at: 1 };
    routes["GET /admin/web-tools"] = () => json({ search: [tavily, brave], fetch: [jina], order: { search: ["tavily", "brave"], fetch: ["jina"] } });
    routes["PUT /admin/web-tools/order"] = (body) => json({ search: [brave, tavily], fetch: [jina], order: body });
    render(<Media tab="web" />);
    const handle = await screen.findByRole("button", { name: t("web.move", { name: "Brave Search" }) });
    fireEvent.keyDown(handle, { key: " " });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: " " });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url === "/admin/web-tools/order")?.body).toEqual({ search: ["brave", "tavily"], fetch: ["jina"] }));
  });
});

describe("proxy pools", () => {
  let pools: ProxyPool[];
  beforeEach(() => {
    pools = [];
    routes["GET /admin/proxy-pools"] = () => json(pools);
    routes["POST /admin/proxy-pools"] = (body) => {
      const b = body as { name: string; relays: string[]; secret: string };
      const pool: ProxyPool = {
        id: "p1",
        name: b.name,
        relays: b.relays,
        hint: b.secret.slice(-4),
        last_check: null,
        checked_at: null,
        connections: 0,
        created_at: 1,
        updated_at: 1,
      };
      pools = [pool];
      return json(pool, 201);
    };
  });

  it("parses relays one per line and checks them", () => {
    expect(parseRelays(" https://a.example.com/ \n\nhttps://b.example.com\r\nhttps://a.example.com")).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(validRelay("https://relay.example.com")).toBe(true);
    expect(validRelay("socks5://relay.example.com")).toBe(false);
    expect(validRelay("https://user:pw@relay.example.com")).toBe(false);
    expect(validRelay("https://relay.example.com/?a=1")).toBe(false);
  });

  it("creates a pool with the relays as a list and never renders the secret", async () => {
    render(<ProxyPools />);
    expect(await screen.findByText(t("pools.empty"))).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: t("pools.add") })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(t("pools.name")), { target: { value: "Tokyo" } });
    fireEvent.change(within(dialog).getByLabelText(t("pools.relays")), {
      target: { value: "https://relay-1.example.com\n\nhttps://relay-2.example.com/\nhttps://relay-1.example.com" },
    });
    fireEvent.change(within(dialog).getByLabelText(t("pools.secret")), { target: { value: FAKE_SECRET } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("pools.add") }));

    expect(await screen.findByText("Tokyo")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "Tokyo",
      relays: ["https://relay-1.example.com", "https://relay-2.example.com"],
      secret: FAKE_SECRET,
    });
    expect(document.body.textContent).toContain(t("pools.secretHint", { hint: "0099" }));
    expect(document.body.innerHTML).not.toContain(FAKE_SECRET);
    expect([...document.querySelectorAll("input")].some((i) => i.value === FAKE_SECRET)).toBe(false);
  });

  it("refuses a short secret before calling the API", async () => {
    render(<ProxyPools />);
    await screen.findByText(t("pools.empty"));
    fireEvent.click(screen.getAllByRole("button", { name: t("pools.add") })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(t("pools.name")), { target: { value: "Tokyo" } });
    fireEvent.change(within(dialog).getByLabelText(t("pools.relays")), { target: { value: "https://relay-1.example.com" } });
    fireEvent.change(within(dialog).getByLabelText(t("pools.secret")), { target: { value: "short" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("pools.add") }));
    expect(await within(dialog).findByText(t("pools.secretBad", { n: "32" }))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("says a deleted pool is detached from its connections", async () => {
    pools = [{ id: "p1", name: "Tokyo", relays: ["https://relay-1.example.com"], hint: "abcd", last_check: [{ url: "https://relay-1.example.com", ok: true, ms: 41 }], checked_at: 1, connections: 2, created_at: 1, updated_at: 1 }];
    routes["DELETE /admin/proxy-pools/p1"] = () => {
      pools = [];
      return new Response(null, { status: 204 });
    };
    render(<ProxyPools />);
    expect(await screen.findByText("Tokyo")).toBeTruthy();
    expect(screen.getByText(t("pools.relayOk", { url: "https://relay-1.example.com", ms: "41" }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("pools.deleteName", { name: "Tokyo" }) }));
    expect(screen.getByText(t("pools.deleteBodyUsed", { n: "2" }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("pools.delete") }));
    expect(await screen.findByText(t("pools.empty"))).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/admin/proxy-pools/p1")).toBe(true);
  });
});
