import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, pageFromHash, providerFromHash } from "../App";
import { setAuth, type Connection } from "../api";
import { resetLang, t } from "../i18n";
import { apiOf } from "../pages/Endpoint";
import { timeoutsBody, timeoutsDraft } from "../pages/Combos";
import { redirectOrigin } from "../pages/Providers";
import { parseCap } from "../pages/Systems";
import { attentionItems, capShare, monthUsed } from "../pages/Overview";
import { HOME, closeTabs, readTabs, tabPathOf, visitTab } from "../tabs";
import { clientLogo, providerLogo } from "../provider-logos";
import { ui } from "../ui-labels";
import { buildLabel } from "../version";
import styles from "../styles.css?raw";

const OPENAI_PATHS = [
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/models",
  "/v1/embeddings",
  "/v1/images/generations",
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
  "/v1/videos",
  "/v1/search",
  "/v1/fetch",
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SYSTEM = {
  id: "chat",
  name: "Chat",
  monthly_token_cap: 1000,
  disabled: false,
  created_at: 1_790_000_000,
  allowed_models: null,
  rtk: false,
  caveman: null,
  ponytail: null,
};
/** The month's usage per system, which the Systems page shows against each cap. */
const USAGE = {
  month: "2026-11",
  rows: [
    { system_id: "chat", provider: "anthropic", model: "claude-opus-5-5", requests: 3, input_tokens: 400, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ],
};
const TOKENS = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const SUMMARY = {
  period: "24h",
  from: 1_790_000_000,
  totals: { requests: 3, input_tokens: 4010, output_tokens: 620, cache_creation_input_tokens: 30, cache_read_input_tokens: 240, cost: 3.6, unpriced_requests: 1 },
  by_provider: [
    { provider: "openai", ...TOKENS, requests: 2, input_tokens: 4000, output_tokens: 600, cost: 3.6 },
    { provider: "groq", ...TOKENS, requests: 1, input_tokens: 10, output_tokens: 20, cost: null },
  ],
  by_model: [
    { provider: "openai", model: "gpt-5", ...TOKENS, requests: 2, input_tokens: 4000, output_tokens: 600, cost: 3.6 },
    { provider: "groq", model: "llama-4", ...TOKENS, requests: 1, input_tokens: 10, output_tokens: 20, cost: null },
  ],
  by_system: [{ system_id: "chat", ...TOKENS, requests: 3, input_tokens: 4010, output_tokens: 620, cost: 3.6 }],
  recent: [{ id: 9, at: 1_790_000_500, system_id: "chat", provider: "openai", model: "gpt-5", status: 429, streamed: false, ...TOKENS, input_tokens: 77, latency_ms: 812 }],
};
const CHART = {
  period: "24h",
  step: 3600,
  buckets: [
    { t: 1_789_996_400, requests: 0, tokens: 0, cost: 0 },
    { t: 1_790_000_000, requests: 3, tokens: 4900, cost: null },
  ],
};
const REQUESTS = {
  rows: [
    { id: 9, at: 1_790_000_500, system_id: "chat", provider: "openai", model: "gpt-5", status: 429, streamed: false, ...TOKENS, input_tokens: 77, latency_ms: 812 },
    { id: 8, at: 1_790_000_400, system_id: "chat", provider: "groq", model: "llama-4", status: 200, streamed: true, ...TOKENS, output_tokens: 55, latency_ms: null },
  ],
};

let calls: { method: string; url: string; auth: string | null; body: unknown }[];
// A route may answer later (a Promise) to hold a request in flight.
let routes: Record<string, (body?: unknown) => Response | Promise<Response>>;
/** The xDev ID session the fake gateway sees (the cookie itself is invisible to the page). */
let ssoUser: { email: string; name: string } | null;
let ssoConfigured: boolean;
/** Whether the fake gateway holds a session opened with the admin token (POST /auth/token). */
let tokenSession: boolean;

beforeEach(() => {
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  // The console opens on Overview; most tests here start on Endpoint & Key.
  window.location.hash = "";
  calls = [];
  ssoUser = null;
  ssoConfigured = false;
  tokenSession = false;
  window.history.replaceState({}, "", "/#/systems");
  routes = {
    "GET /admin/systems": () => json([SYSTEM]),
    "GET /admin/usage": () => json(USAGE),
    "GET /admin/usage/summary": () => json(SUMMARY),
    "GET /admin/usage/chart": () => json(CHART),
    "GET /admin/usage/requests": () => json(REQUESTS),
    "POST /admin/systems": () => json({ id: "xdevd", token: "xllm_new_token" }, 201),
    "PATCH /admin/systems/chat": () => json(SYSTEM),
    "GET /admin/combos": () => json([{ name: "fast", targets: ["groq/llama", "claude-haiku-5-5"], updated_at: 1 }]),
    "POST /admin/combos": (body) =>
      (body as { name?: string }).name === "taken" ? json({ error: "Combo name already exists" }, 400) : json({ ...(body as object), updated_at: 2 }, 201),
    "PUT /admin/combos/fast": () => json({ name: "quick", targets: [], updated_at: 2 }),
    "DELETE /admin/combos/fast": () => new Response(null, { status: 204 }),
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ method, url, auth, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/auth/token") {
      if (auth !== "Bearer good-admin-token") return json({ error: "unauthorized" }, 401);
      tokenSession = true;
      return json({ admin: true });
    }
    if (url === "/auth/me") {
      if (tokenSession) return json({ admin: true });
      return ssoUser ? json(ssoUser) : json({ error: "unauthorized", sso: ssoConfigured }, 401);
    }
    if (url === "/auth/logout") {
      ssoUser = null;
      tokenSession = false;
      return new Response(null, { status: 204 });
    }
    const signedIn = auth === null && (ssoUser !== null || tokenSession);
    if (!signedIn) return json({ error: "unauthorized" }, 401);
    const route = routes[`${method} ${url.split("?")[0]}`];
    return route ? route(calls[calls.length - 1].body) : json({ error: "not_found" }, 404);
  });
});

afterEach(() => {
  cleanup();
  act(() => setAuth(null));
  vi.unstubAllGlobals();
});

async function signIn(token = "good-admin-token") {
  render(<App />);
  fireEvent.change(await screen.findByLabelText(t("signin.token")), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: t("signin.submit") }));
}

describe("sign in", () => {
  it("shows an error for a wrong token and stays on the sign-in page", async () => {
    await signIn("bad");
    expect(await screen.findByText(t("signin.wrong"))).toBeTruthy();
    expect(screen.queryByText(t("systems.title"))).toBeNull();
  });

  it("opens the systems page with a good token, sent once to /auth/token", async () => {
    await signIn();
    expect(await screen.findByRole("heading", { name: t("systems.title") })).toBeTruthy();
    expect(await screen.findByText("Chat")).toBeTruthy();
    expect(screen.getByText(t("systems.used", { used: "500", cap: "1,000" }))).toBeTruthy();
    expect(screen.getByText("chat")).toBeTruthy();
    const adminCalls = calls.filter((c) => c.url.startsWith("/admin/"));
    expect(adminCalls.length).toBeGreaterThan(0);
    // The gateway's session cookie carries the rest; the page never sends the token again.
    expect(adminCalls.every((c) => c.auth === null)).toBe(true);
    expect(calls.filter((c) => c.auth === "Bearer good-admin-token").map((c) => `${c.method} ${c.url}`)).toEqual(["POST /auth/token"]);
  });

  it("stays signed in after a reload", async () => {
    await signIn();
    await screen.findByText("Chat");
    cleanup();
    act(() => setAuth(null)); // a reload starts with an empty page
    render(<App />);
    // Until /auth/me answers, the sign-in page is not drawn, so a reload never flashes it.
    expect(screen.queryByLabelText(t("signin.token"))).toBeNull();
    expect(await screen.findByText("Chat")).toBeTruthy();
    expect(screen.queryByLabelText(t("signin.token"))).toBeNull();
  });

  it("sign-out ends the admin token session on the gateway", async () => {
    await signIn();
    await screen.findByText("Chat");
    fireEvent.click(screen.getByRole("button", { name: t("shell.account") }));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("shell.signOut") }));
    expect(await screen.findByLabelText(t("signin.token"))).toBeTruthy();
    expect(tokenSession).toBe(false);
  });

  it("does not keep the token in web storage", async () => {
    await signIn();
    await screen.findByText("Chat");
    const stored = [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" ");
    expect(stored).not.toContain("good-admin-token");
  });

  it("signs out when the API answers 401", async () => {
    await signIn();
    await screen.findByText("Chat");
    // The session ended on the gateway (expired, or the admin token changed): /auth/me says so too.
    routes["GET /admin/usage/summary"] = () => {
      tokenSession = false;
      return json({ error: "unauthorized" }, 401);
    };
    window.location.hash = "#/usage";
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(await screen.findByLabelText(t("signin.token"))).toBeTruthy();
  });
});

describe("sign in with xDev ID", () => {
  it("offers xDev ID only when the gateway has it set up", async () => {
    render(<App />);
    await waitFor(() => expect(calls.some((c) => c.url === "/auth/me")).toBe(true));
    expect(screen.queryByRole("button", { name: t("signin.sso") })).toBeNull();
    cleanup();
    ssoConfigured = true;
    render(<App />);
    expect(await screen.findByRole("button", { name: t("signin.sso") })).toBeTruthy();
    expect(screen.getByText(t("signin.tokenTitle"))).toBeTruthy();
  });

  it("an xDev ID session opens the console without a token and shows the account", async () => {
    ssoUser = { email: "owner@example.com", name: "Owner" };
    render(<App />);
    expect(await screen.findByText("Chat")).toBeTruthy();
    expect(screen.getByText("owner@example.com")).toBeTruthy();
    expect(calls.filter((c) => c.url.startsWith("/admin/")).every((c) => c.auth === null)).toBe(true);
  });

  it("sign-out ends the xDev ID session on the gateway", async () => {
    ssoUser = { email: "owner@example.com", name: "Owner" };
    ssoConfigured = true;
    render(<App />);
    await screen.findByText("Chat");
    fireEvent.click(screen.getByRole("button", { name: t("shell.account") }));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("shell.signOut") }));
    expect(await screen.findByRole("button", { name: t("signin.sso") })).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url === "/auth/logout")).toBe(true);
  });

  it("shows why a sign-in came back", async () => {
    window.history.replaceState({}, "", "/?signin_error=not_allowed");
    ssoConfigured = true;
    render(<App />);
    expect(await screen.findByText(t("signin.error.not_allowed"))).toBeTruthy();
    cleanup();
    window.history.replaceState({}, "", "/?signin_error=<script>");
    render(<App />);
    await screen.findByRole("button", { name: t("signin.sso") });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("frame", () => {
  // The top bar; a page header inside main is a <header> too.
  const banner = () => screen.getAllByRole("banner").find((el) => !el.closest("main"))!;

  it("the page header holds the title and description, the page's only h1; the top bar holds the breadcrumb", async () => {
    await signIn();
    await screen.findByText("Chat");
    const main = screen.getByRole("main");
    expect(await within(main).findByRole("heading", { level: 1, name: t("systems.title") })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(within(main).getByText(t("systems.description"))).toBeTruthy();
    const trail = within(banner()).getByRole("navigation", { name: ui("en").breadcrumb.breadcrumb });
    expect(within(trail).getByText(t("nav.title"))).toBeTruthy();
    expect(within(trail).getByText(t("nav.systems"))).toBeTruthy();
  });

  it("opened pages become tabs after the pinned Overview tab; closing the open tab goes to its neighbour", async () => {
    await signIn();
    await screen.findByText("Chat");
    window.location.hash = "#/usage";
    fireEvent(window, new HashChangeEvent("hashchange"));
    await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: t("usage.title") });
    // The strip's tabs are owned by its tablist (aria-owns), not nested in it.
    expect(screen.getByRole("tablist", { name: t("shell.openPages") })).toBeTruthy();
    expect([...document.querySelectorAll(".console-tabs [role=tab]")].map((x) => x.textContent)).toEqual([t("nav.overview"), t("nav.systems"), t("nav.usage")]);
    fireEvent.click(screen.getByRole("button", { name: ui("en").tabStrip.close(t("nav.usage")) }));
    await waitFor(() => expect(window.location.hash).toBe("#/systems"));
    expect(screen.queryByRole("button", { name: ui("en").tabStrip.close(t("nav.overview")) })).toBeNull();
  });

  it("each page puts its own title in its header and the browser tab", async () => {
    await signIn();
    await screen.findByText("Chat");
    for (const [hash, title] of [
      ["#/usage", "usage.title"],
      ["#/combos", "combos.title"],
      ["#/token-saver", "saver.title"],
    ] as const) {
      window.location.hash = hash;
      fireEvent(window, new HashChangeEvent("hashchange"));
      expect(await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: t(title) })).toBeTruthy();
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(document.title).toBe(`${t(title)} · ${t("app.name")}`);
    }
  });

  it("the sidebar lists the pages in order, in three groups, and marks the open one", async () => {
    await signIn();
    await screen.findByText("Chat");
    const gateway = screen.getByRole("navigation", { name: t("nav.title") });
    const insight = screen.getByRole("navigation", { name: t("nav.insight") });
    const system = screen.getByRole("navigation", { name: t("nav.system") });
    const links = [...within(gateway).getAllByRole("link"), ...within(insight).getAllByRole("link"), ...within(system).getAllByRole("link")];
    const name = (a: HTMLElement) => a.querySelector(".settings-nav-label")?.textContent;
    expect(within(gateway).getAllByRole("link").map(name)).toEqual([t("nav.overview"), t("nav.systems"), t("nav.providers"), t("nav.combos"), t("nav.cliTools"), t("nav.mcp")]);
    expect(within(insight).getAllByRole("link").map(name)).toEqual([t("nav.usage"), t("nav.quota"), t("nav.tokenSaver")]);
    expect(within(system).getAllByRole("link").map(name)).toEqual([t("nav.clips"), t("nav.media"), t("nav.proxyPools"), t("nav.skills"), t("nav.logs"), t("nav.settings"), t("nav.pricing")]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#/overview", "#/systems", "#/providers", "#/combos", "#/cli-tools", "#/mcp",
      "#/usage", "#/quota", "#/token-saver",
      "#/clips", "#/media", "#/proxy-pools", "#/skills", "#/logs", "#/settings", "#/pricing",
    ]);
    expect(name(within(gateway).getByRole("link", { current: "page" }))).toBe(t("nav.systems"));
    expect(within(insight).queryByRole("link", { current: "page" })).toBeNull();
  });

  it("the sidebar counts the combos and the accounts, and marks an account cooling down", async () => {
    routes["GET /admin/connections"] = () =>
      json([
        { id: "a", provider: "openai", disabled: false, cooldown_until: 0 },
        { id: "b", provider: "openai", disabled: false, cooldown_until: Date.now() / 1000 + 600 },
      ]);
    await signIn();
    await screen.findByText("Chat");
    const gateway = screen.getByRole("navigation", { name: t("nav.title") });
    const link = (href: string) => within(gateway).getAllByRole("link").find((a) => a.getAttribute("href") === href)!;
    await waitFor(() => expect(link("#/combos").querySelector(".settings-nav-count")?.textContent).toBe("1"));
    expect(link("#/providers").querySelector(".settings-nav-count")?.textContent).toBe("2");
    expect(within(link("#/providers")).getByText(t("nav.cooling", { n: "1" }))).toBeTruthy();
  });

  it("Ctrl K opens the palette, which goes to a page or a provider", async () => {
    routes["GET /admin/providers"] = () => json([{ id: "openai", name: "OpenAI", format: "openai", auth: ["api_key"], env_key: false, key_url: null, strategy: "fill-first", color: "#10a37f", mark: "OA" }]);
    routes["GET /admin/connections"] = () => json([]);
    await signIn();
    await screen.findByText("Chat");
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    fireEvent.click(within(await screen.findByRole("dialog", { name: t("palette.dialog") })).getByText(t("nav.usage")));
    expect(window.location.hash).toBe("#/usage");
    expect(screen.queryByRole("dialog", { name: t("palette.dialog") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("palette.trigger") }));
    fireEvent.click(await within(await screen.findByRole("dialog", { name: t("palette.dialog") })).findByText("OpenAI"));
    expect(window.location.hash).toBe("#/providers/openai");
  });

  it("the sidebar shows the product name, the gateway status and the version", async () => {
    await signIn();
    await screen.findByText("Chat");
    const side = screen.getByRole("complementary");
    expect(within(side).getByText(t("app.name"))).toBeTruthy();
    expect(within(side).getByText(t("shell.online"))).toBeTruthy();
    expect(within(side).getByText(buildLabel(__APP_VERSION__))).toBeTruthy();
    expect(screen.queryByText(t("build.newTitle"))).toBeNull();
  });

  it("offers a reload when the gateway runs a newer build than this page", async () => {
    routes["GET /health"] = () => json({ ok: true, version: "fedcba9876543210fedcba9876543210fedcba98", built_at: null });
    await signIn();
    await screen.findByText(t("build.newTitle"));
    expect(screen.getByText(t("build.newBody", { version: "fedcba9" }))).toBeTruthy();
    expect(screen.getByRole("button", { name: t("build.reload") })).toBeTruthy();
  });

  it("Endpoint & Key opens on the OpenAI base URL of this origin and its /v1 paths", async () => {
    await signIn();
    await screen.findByText("Chat");
    expect(screen.getByRole("heading", { level: 2, name: t("endpoint.title") })).toBeTruthy();
    const formats = screen.getByRole("group", { name: t("endpoint.format") });
    expect(within(formats).getAllByRole("button").map((b) => b.textContent)).toEqual([t("endpoint.fmt.openai"), t("endpoint.fmt.anthropic"), t("endpoint.fmt.gemini")]);
    expect(within(formats).getByRole("button", { name: t("endpoint.fmt.openai") }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(t("endpoint.body.openai"))).toBeTruthy();
    expect(screen.getByText("OPENAI_BASE_URL")).toBeTruthy();
    expect(screen.getAllByText(`${window.location.origin}/v1`).length).toBeGreaterThan(0);
    const items = () => within(screen.getByRole("list", { name: t("endpoint.paths") })).getAllByRole("listitem").map((li) => li.textContent);
    expect(items()).toEqual(OPENAI_PATHS);
  });

  it("Endpoint & Key switches to the Anthropic and Gemini base URLs, which are the origin", async () => {
    await signIn();
    await screen.findByText("Chat");
    const formats = screen.getByRole("group", { name: t("endpoint.format") });
    const items = () => within(screen.getByRole("list", { name: t("endpoint.paths") })).getAllByRole("listitem").map((li) => li.textContent);

    fireEvent.click(within(formats).getByRole("button", { name: t("endpoint.fmt.anthropic") }));
    expect(screen.getByText(t("endpoint.body.anthropic"))).toBeTruthy();
    expect(screen.getByText("ANTHROPIC_BASE_URL")).toBeTruthy();
    expect(screen.getAllByText(window.location.origin).length).toBeGreaterThan(0);
    expect(items()).toEqual(["/v1/messages", "/v1/messages/count_tokens"]);

    fireEvent.click(within(formats).getByRole("button", { name: t("endpoint.fmt.gemini") }));
    expect(screen.getByText(t("endpoint.body.gemini"))).toBeTruthy();
    expect(screen.getByText("GOOGLE_GEMINI_BASE_URL")).toBeTruthy();
    expect(screen.getAllByText(window.location.origin).length).toBeGreaterThan(0);
    expect(items()).toEqual(["/v1beta/models", "/v1beta/models/{model}:generateContent", "/v1beta/models/{model}:streamGenerateContent", "/v1beta/models/{model}:countTokens", "/v1beta/models/{model}:embedContent"]);
  });

  it("names the API of a request path the way the Endpoint page does", () => {
    expect(apiOf("/v1/chat/completions")).toBe("openai");
    expect(apiOf("/openai/v1/responses")).toBe("openai");
    expect(apiOf("/v1/embeddings")).toBe("openai");
    expect(apiOf("/v1/messages")).toBe("anthropic");
    expect(apiOf("/v1/messages/count_tokens")).toBe("anthropic");
    expect(apiOf("/anthropic/v1/messages")).toBe("anthropic");
    expect(apiOf("/v1beta/models/gemini-2.5-pro:generateContent")).toBe("gemini");
    expect(apiOf("/v1/search")).toBe("openai");
  });

  it("Logs shows which API each request used", async () => {
    const line = (id: number, path: string) => ({ id, at: 1_700_000_000_000 + id, level: "info", method: "POST", path, status: 200, took_ms: 12, system_id: "app", model: "m", message: null });
    routes["GET /admin/logs"] = () =>
      json({ logs: [line(3, "/v1beta/models/g:generateContent"), line(2, "/v1/messages"), line(1, "/v1/chat/completions")], kept: { rows: 500, minutes: 15 } });
    await signIn();
    await screen.findByText("Chat");
    window.location.hash = "#/logs";
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("columnheader", { name: t("logs.col.api") })).toBeTruthy();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).queryByText(t("endpoint.fmt.gemini")) ?? within(r).queryByText(t("endpoint.fmt.anthropic")) ?? within(r).queryByText(t("endpoint.fmt.openai"))).map((e) => e?.textContent)).toEqual([
      t("endpoint.fmt.gemini"),
      t("endpoint.fmt.anthropic"),
      t("endpoint.fmt.openai"),
    ]);
  });

  it("the provider search sits in the providers page toolbar only", async () => {
    routes["GET /admin/providers"] = () => json([]);
    routes["GET /admin/connections"] = () => json([]);
    await signIn();
    await screen.findByText("Chat");
    expect(screen.queryByRole("searchbox", { name: t("providers.search") })).toBeNull();
    window.location.hash = "#/providers";
    fireEvent(window, new HashChangeEvent("hashchange"));
    const search = await within(screen.getByRole("main")).findByRole("searchbox", { name: t("providers.search") });
    expect(search.getAttribute("placeholder")).toBe(t("providers.searchPlaceholder"));
  });

  it("the account menu holds the theme, the language and sign out", async () => {
    await signIn();
    await screen.findByText("Chat");
    fireEvent.click(within(banner()).getByRole("button", { name: t("shell.account") }));
    expect(await screen.findByRole("menuitem", { name: t("shell.signOut") })).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: t("theme.dark") })).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: "Tiếng Việt" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: t("shell.signOut") }));
    expect(await screen.findByLabelText(t("signin.token"))).toBeTruthy();
  });

  it("choosing a page closes the drawer", async () => {
    await signIn();
    await screen.findByText("Chat");
    const menu = within(banner()).getByRole("button", { name: ui("en").appShell.openNav });
    fireEvent.click(menu);
    expect(within(banner()).getByRole("button", { name: ui("en").appShell.closeNav }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(screen.getByRole("navigation", { name: t("nav.insight") })).getByRole("link", { name: t("nav.usage") }));
    expect(within(banner()).getByRole("button", { name: ui("en").appShell.openNav }).getAttribute("aria-expanded")).toBe("false");
    // Let the link's hash change land here, not in the next test.
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: t("usage.title") })).toBeTruthy();
  });
});

describe("systems", () => {
  it("creates a system and shows its token once", async () => {
    await signIn();
    await screen.findByText("Chat");
    fireEvent.click(screen.getByRole("button", { name: t("systems.add") }));
    fireEvent.change(screen.getByLabelText(t("create.id")), { target: { value: "xdevd" } });
    fireEvent.change(screen.getByLabelText(t("create.name")), { target: { value: "xDev daemon" } });
    fireEvent.change(screen.getByLabelText(t("create.cap")), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: t("create.submit") }));

    expect(await screen.findByText(t("token.title", { id: "xdevd" }))).toBeTruthy();
    expect(screen.getAllByText(/xllm_new_token/).length).toBeGreaterThan(0);
    expect(calls.find((c) => c.method === "POST" && c.url.startsWith("/admin/"))?.body).toEqual({ id: "xdevd", name: "xDev daemon", monthly_token_cap: 5000 });
  });

  it("validates the id before calling the API", async () => {
    await signIn();
    await screen.findByText("Chat");
    fireEvent.click(screen.getByRole("button", { name: t("systems.add") }));
    fireEvent.change(screen.getByLabelText(t("create.id")), { target: { value: "Bad Id" } });
    fireEvent.change(screen.getByLabelText(t("create.name")), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: t("create.submit") }));
    await waitFor(() => expect(screen.getByLabelText(t("create.id")).getAttribute("aria-invalid")).toBe("true"));
    expect(calls.some((c) => c.method === "POST" && c.url.startsWith("/admin/"))).toBe(false);
  });
});

describe("models and savers", () => {
  it("saves allowed models and savers in one PATCH, and refuses bad patterns first", async () => {
    await signIn();
    await screen.findByText("Chat");
    fireEvent.click(screen.getByRole("button", { name: `${t("systems.col.actions")}: chat` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("systems.settings") }));
    const models = screen.getByLabelText(t("settings.models")) as HTMLTextAreaElement;
    expect(models.value).toBe("anthropic/*");

    fireEvent.change(models, { target: { value: "anthropic/*\nOpenAI/gpt" } });
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    expect(await screen.findByText(t("settings.modelsBad", { bad: "OpenAI/gpt" }))).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    fireEvent.change(models, { target: { value: "anthropic/*\ncombo/fast, groq/*" } });
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(t("settings.rtk")) }));
    fireEvent.change(screen.getByLabelText(t("settings.caveman")), { target: { value: "lite" } });
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      allowed_models: ["anthropic/*", "combo/fast", "groq/*"],
      rtk: true,
      caveman: "lite",
      ponytail: null,
    }));
  });
});

describe("combos", () => {
  it("lists combos, creates one and deletes one", async () => {
    window.location.hash = "#/combos";
    await signIn();
    expect(await screen.findByText("fast")).toBeTruthy();
    expect(screen.getByText("claude-haiku-5-5")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: t("combos.add") })[0]);
    fireEvent.change(screen.getByLabelText(t("combos.name")), { target: { value: "cheap" } });
    fireEvent.click(screen.getByRole("button", { name: t("combos.addModel") }));
    fireEvent.change(screen.getByRole("combobox", { name: t("combos.pickLabel") }), { target: { value: "groq/llama-4" } });
    fireEvent.click(await screen.findByRole("option", { name: /groq\/llama-4/ }));
    expect(screen.getByRole("button", { name: t("combos.remove", { name: "groq/llama-4" }) })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("combos.create") }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.url === "/admin/combos")).toMatchObject({ body: { name: "cheap", targets: ["groq/llama-4"] } }));

    fireEvent.click(await screen.findByRole("button", { name: t("combos.deleteOne", { name: "fast" }) }));
    fireEvent.click(await screen.findByRole("button", { name: t("combos.delete") }));
    expect(await screen.findByText(t("combos.deletedNotice", { name: "fast" }))).toBeTruthy();
  });

  it("checks the name before saving and shows a taken name on the field", async () => {
    window.location.hash = "#/combos";
    await signIn();
    await screen.findByText("fast");
    fireEvent.click(screen.getAllByRole("button", { name: t("combos.add") })[0]);
    fireEvent.click(screen.getByRole("button", { name: t("combos.create") }));
    expect(await screen.findByText(t("combos.nameRequired"))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t("combos.name")), { target: { value: "Bad Name" } });
    fireEvent.click(screen.getByRole("button", { name: t("combos.create") }));
    expect(calls.some((c) => c.method === "POST" && c.url === "/admin/combos")).toBe(false);

    fireEvent.change(screen.getByLabelText(t("combos.name")), { target: { value: "taken" } });
    fireEvent.click(screen.getByRole("button", { name: t("combos.create") }));
    expect(await screen.findByText(t("combos.taken"))).toBeTruthy();
  });

  it("renames a combo through PUT and filters by search", async () => {
    window.location.hash = "#/combos";
    await signIn();
    await screen.findByText("fast");
    fireEvent.change(screen.getByRole("searchbox", { name: t("combos.searchLabel") }), { target: { value: "zzz" } });
    expect(await screen.findByText(t("combos.noMatch", { q: "zzz" }))).toBeTruthy();
    fireEvent.click(screen.getByText(t("combos.clearSearch"), { selector: "button" }));
    fireEvent.click(await screen.findByRole("button", { name: t("combos.editOne", { name: "fast" }) }));
    fireEvent.change(screen.getByLabelText(t("combos.name")), { target: { value: "quick" } });
    fireEvent.click(screen.getByRole("button", { name: t("combos.moveUp", { name: "claude-haiku-5-5" }) }));
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")).toMatchObject({ url: "/admin/combos/fast", body: { name: "quick", targets: ["claude-haiku-5-5", "groq/llama"] } }),
    );
  });
});

describe("combo timeouts (FR-CTO-11)", () => {
  it("timeoutsBody: empty is the gateway setting, 0 or 10 to 3600 are kept, anything else is refused", () => {
    expect(timeoutsBody({ first_byte_s: "", idle_s: " " })).toEqual({ timeouts: null });
    expect(timeoutsBody({ first_byte_s: "20", idle_s: "0" })).toEqual({ timeouts: { first_byte_s: 20, idle_s: 0 } });
    expect(timeoutsBody({ first_byte_s: "3600", idle_s: "" })).toEqual({ timeouts: { first_byte_s: 3600 } });
    expect(timeoutsBody({ first_byte_s: "5", idle_s: "1.5" })).toEqual({ bad: ["first_byte_s", "idle_s"] });
    expect(timeoutsBody({ first_byte_s: "3601", idle_s: "-10" })).toEqual({ bad: ["first_byte_s", "idle_s"] });
    expect(timeoutsDraft({ name: "x", targets: [], updated_at: 1, timeouts: { idle_s: 0 } })).toEqual({ first_byte_s: "", idle_s: "0" });
    expect(timeoutsDraft(null)).toEqual({ first_byte_s: "", idle_s: "" });
  });

  it("the dialog shows a bad limit on its field and sends nothing, then sends the limits it was given", async () => {
    window.location.hash = "#/combos";
    await signIn();
    await screen.findByText("fast");
    fireEvent.click(await screen.findByRole("button", { name: t("combos.editOne", { name: "fast" }) }));
    const first = screen.getByLabelText(t("combos.timeoutFirstByte"));
    fireEvent.change(first, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    expect(await screen.findByText(t("prefs.timeoutInvalid"))).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    fireEvent.change(first, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT" && c.url === "/admin/combos/fast")).toMatchObject({ body: { timeouts: { first_byte_s: 20 } } }),
    );
  });
});

describe("providers", () => {
  const PROVIDER_LIST = [
    { id: "anthropic", name: "Anthropic", format: "anthropic", auth: ["api_key"], env_key: true, key_url: "https://console.anthropic.com/settings/keys", strategy: "fill-first", color: "#D97757", mark: "AN" },
    { id: "openai", name: "OpenAI", format: "openai", auth: ["api_key"], env_key: false, key_url: "https://platform.openai.com/api-keys", strategy: "fill-first", color: "#10A37F", mark: "OA" },
    { id: "groq", name: "Groq", format: "openai", auth: ["api_key"], env_key: false, key_url: null, strategy: "round-robin", color: "#F55036", mark: "GQ" },
  ];
  const account = (over: Record<string, unknown>) => ({
    id: "c1",
    provider: "openai",
    auth_type: "api_key",
    name: "Work",
    hint: "1234",
    expires_at: null,
    priority: 1,
    disabled: false,
    cooldown_until: 0,
    last_error: null,
    last_error_at: null,
    last_used_at: 1_790_000_000,
    created_at: 1_790_000_000,
    updated_at: 1_790_000_000,
    ...over,
  });
  const WORK = account({});
  const BACKUP = account({ id: "c2", name: "Backup", hint: "9999", priority: 2, cooldown_until: Math.floor(Date.now() / 1000) + 600, last_error: "429 slow down" });

  beforeEach(() => {
    routes["GET /admin/providers"] = () => json(PROVIDER_LIST);
    routes["GET /admin/connections"] = () => json([WORK, BACKUP]);
    routes["POST /admin/connections"] = () => json(account({ id: "c3", name: "New", hint: "5678", priority: 3 }), 201);
    routes["PATCH /admin/connections/c1"] = () => json(WORK);
    routes["DELETE /admin/connections/c2"] = () => new Response(null, { status: 204 });
    routes["PUT /admin/providers/openai/order"] = () => json([BACKUP, WORK]);
  });

  async function openProvider() {
    window.location.hash = "#/providers/openai";
    await signIn();
    await screen.findByText("Work");
  }

  it("lists the providers as cards that link to their accounts, with what each has", async () => {
    window.location.hash = "#/providers";
    await signIn();
    expect(await screen.findByRole("heading", { name: t("providers.title") })).toBeTruthy();
    expect(screen.getByRole("heading", { name: t("providers.section.api_key") })).toBeTruthy();

    const openai = screen.getByRole("link", { name: /OpenAI/ });
    expect(openai.getAttribute("href")).toBe("#/providers/openai");
    expect(openai.textContent).toContain(t("providers.connected", { n: "1" }));
    expect(openai.textContent).toContain(t("providers.setAside", { n: "1" }));
    expect(screen.getByRole("link", { name: /Anthropic/ }).textContent).toContain(t("providers.envKey"));
    expect(screen.getByRole("link", { name: /Groq/ }).textContent).toContain(t("providers.none"));

    // Each card carries the provider's own logo, on its colour.
    const mark = screen.getByRole("img", { name: "OpenAI" });
    expect(mark.querySelector("img")!.getAttribute("src")).toBe("/providers/openai.svg");
    expect(mark.getAttribute("style")).toContain("#10A37F");
    // The section says how many providers it holds.
    expect(screen.getByRole("heading", { name: t("providers.section.api_key") }).parentElement!.textContent).toContain("3");
  });

  it("narrows the cards with the search field and the status filter", async () => {
    window.location.hash = "#/providers";
    await signIn();
    await screen.findByRole("link", { name: /OpenAI/ });

    fireEvent.change(screen.getByRole("searchbox", { name: t("providers.search") }), { target: { value: "gro" } });
    expect(screen.queryByRole("link", { name: /OpenAI/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Groq/ })).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: t("providers.search") }), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(t("providers.filter")), { target: { value: "connected" } });
    expect(screen.getByRole("link", { name: /OpenAI/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Groq/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Anthropic/ })).toBeNull();

    fireEvent.change(screen.getByLabelText(t("providers.filter")), { target: { value: "none" } });
    expect(screen.queryByRole("link", { name: /OpenAI/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Groq/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Anthropic/ })).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: t("providers.search") }), { target: { value: "zzz" } });
    expect(screen.getByText(t("ux.providers.noMatchQuery", { query: "zzz" }))).toBeTruthy();
  });

  it("a provider's switch turns all of its accounts off, and only providers with accounts have one", async () => {
    routes["PATCH /admin/connections/c2"] = () => json(BACKUP);
    window.location.hash = "#/providers";
    await signIn();
    await screen.findByRole("link", { name: /OpenAI/ });
    expect(screen.queryByRole("switch", { name: t("providers.useProvider", { name: "Groq" }) })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: t("providers.useProvider", { name: "OpenAI" }) }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.url, c.body])).toEqual([
      ["/admin/connections/c1", { disabled: true }],
      ["/admin/connections/c2", { disabled: true }],
    ]);
  });

  it("the provider page names the provider, counts its accounts and links back", async () => {
    await openProvider();
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: "OpenAI" })).toBeTruthy();
    const trail = within(screen.getAllByRole("banner").find((el) => !el.closest("main"))!).getByRole("navigation", { name: ui("en").breadcrumb.breadcrumb });
    expect(within(trail).getByRole("link", { name: t("providers.title") }).getAttribute("href")).toBe("#/providers");
    expect(within(trail).getByText("OpenAI")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText(t("providers.connections", { n: "2" }))).toBeTruthy();
    expect(screen.getByRole("link", { name: t("providers.back") }).getAttribute("href")).toBe("#/providers");
  });

  it("shows each account with the end of its key and why it is set aside, never a key", async () => {
    await openProvider();
    expect(screen.getByText("Backup")).toBeTruthy();
    expect(screen.getByText(/1234/)).toBeTruthy();
    expect(screen.getByText(/429 slow down/)).toBeTruthy();
    expect(screen.getAllByText(t("providers.status.ok"))).toHaveLength(1);
    expect(screen.getAllByText(new RegExp(t("providers.status.cooling", { time: ".*" })))).toHaveLength(1);
  });

  it("adds an account for this provider and does not show the key again", async () => {
    await openProvider();
    fireEvent.click(screen.getByRole("button", { name: t("providers.add") }));
    const key = screen.getByLabelText(t("providers.apiKey")) as HTMLInputElement;
    expect(key.type).toBe("password");
    fireEvent.change(screen.getByLabelText(t("providers.name")), { target: { value: "New" } });
    fireEvent.change(key, { target: { value: "sk-new-12345678" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: t("providers.add") }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.url === "/admin/connections")).toMatchObject({ body: { provider: "openai", name: "New", api_key: "sk-new-12345678" } }));
    expect(await screen.findByText(t("providers.savedNotice", { name: "New" }))).toBeTruthy();
    expect(document.body.textContent).not.toContain("sk-new-12345678");
  });

  it("asks for a name and a key before calling the API", async () => {
    await openProvider();
    fireEvent.click(screen.getByRole("button", { name: t("providers.add") }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: t("providers.add") }));
    expect(await screen.findByText(t("providers.nameRequired"))).toBeTruthy();
    expect(screen.getByText(t("providers.apiKeyRequired"))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url.startsWith("/admin/"))).toBe(false);
  });

  it("renames without touching the key when the key field is left empty", async () => {
    await openProvider();
    fireEvent.click(screen.getByRole("button", { name: `${t("systems.col.actions")}: Work` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("providers.edit") }));
    fireEvent.change(screen.getByLabelText(t("providers.name")), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/admin/connections/c1", body: { name: "Renamed" } }));
    expect(calls.find((c) => c.method === "PATCH")!.body).not.toHaveProperty("api_key");
  });

  it("turns an account off with its switch", async () => {
    await openProvider();
    fireEvent.click(screen.getByRole("switch", { name: t("providers.enabled", { name: "Work" }) }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/admin/connections/c1", body: { disabled: true } }));
  });

  it("saves the new order after an account is moved with the keyboard", async () => {
    await openProvider();
    const handle = () => screen.getByRole("button", { name: t("providers.move", { name: "Work" }) });
    fireEvent.keyDown(handle(), { key: " " });
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    fireEvent.keyDown(handle(), { key: " " });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toMatchObject({ url: "/admin/providers/openai/order", body: { ids: ["c2", "c1"] } }));
  });

  it("deletes an account after a confirmation", async () => {
    await openProvider();
    fireEvent.click(screen.getByRole("button", { name: `${t("systems.col.actions")}: Backup` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("providers.delete") }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: t("providers.delete") }));
    expect(await screen.findByText(t("providers.deletedNotice", { name: "Backup" }))).toBeTruthy();
    expect(calls.find((c) => c.method === "DELETE")).toMatchObject({ url: "/admin/connections/c2" });
  });

  it("says so when the environment also holds a key for the provider", async () => {
    routes["GET /admin/connections"] = () => json([]);
    window.location.hash = "#/providers/anthropic";
    await signIn();
    expect(await screen.findByText(t("providers.envKeyNote"))).toBeTruthy();
    expect(screen.getByText(t("providers.empty"))).toBeTruthy();
  });

  it("links to the provider's page for creating a key, in a new tab", async () => {
    await openProvider();
    const link = screen.getByRole("link", { name: t("providers.getKey") });
    expect(link.getAttribute("href")).toBe("https://platform.openai.com/api-keys");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("the round robin switch shows the provider's strategy and saves a change", async () => {
    routes["PUT /admin/providers/openai/strategy"] = () => json({ provider: "openai", strategy: "round-robin" });
    await openProvider();
    const sw = screen.getByRole("switch", { name: t("providers.roundRobin") }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toMatchObject({ url: "/admin/providers/openai/strategy", body: { strategy: "round-robin" } }));
  });

  it("tests a connection's key and says what the provider answered", async () => {
    routes["POST /admin/connections/c1/test"] = () => json({ ok: true });
    routes["POST /admin/connections/c2/test"] = () => json({ ok: false, status: 401, message: "Invalid API Key" });
    await openProvider();
    fireEvent.click(screen.getByRole("button", { name: `${t("systems.col.actions")}: Work` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("providers.test") }));
    expect(await screen.findByText(t("providers.testOk", { name: "Work" }))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `${t("systems.col.actions")}: Backup` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("providers.test") }));
    expect(await screen.findByText(t("ux.providers.testFailed", { name: "Backup" }))).toBeTruthy();
    expect(screen.getByText(t("ux.providers.testAnswer", { answer: "401 Invalid API Key" }))).toBeTruthy();
  });

  describe("subscription login", () => {
    const CODEX = { id: "codex", name: "OpenAI Codex", format: "codex", auth: ["oauth"], env_key: false, key_url: "https://chatgpt.com/codex", strategy: "fill-first", color: "#3B82F6", mark: "CX" };
    const SIGNED_IN = account({ id: "o1", provider: "codex", auth_type: "oauth", name: "dev@example.com", hint: null, account: "acc_1", expires_at: 1_790_003_600 });
    const AUTHORIZE = "https://auth.openai.com/oauth/authorize?state=abc";
    let opened: string[];

    beforeEach(() => {
      opened = [];
      vi.spyOn(window, "open").mockImplementation((url) => {
        opened.push(String(url));
        return null;
      });
      routes["GET /admin/providers"] = () => json([...PROVIDER_LIST, CODEX]);
      routes["GET /admin/connections"] = () => json([WORK, SIGNED_IN]);
      routes["POST /admin/oauth/codex/start"] = () => json({ authorize_url: AUTHORIZE });
      routes["POST /admin/oauth/codex/finish"] = () => json(SIGNED_IN, 201);
    });

    async function openCodex() {
      window.location.hash = "#/providers/codex";
      await signIn();
      await screen.findByText("dev@example.com");
    }

    it("lists subscription providers in their own section, before the API key providers", async () => {
      window.location.hash = "#/providers";
      await signIn();
      await screen.findByRole("link", { name: /OpenAI Codex/ });
      // The section headings of the page, in page order (the sidebar has headings of its own).
      const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent).filter((h) => h !== t("nav.title") && h !== t("nav.insight") && h !== t("nav.system"));
      // The custom section comes first, shown empty with its add buttons while the owner has none.
      expect(headings).toEqual([t("providers.section.custom"), t("providers.section.oauth"), t("providers.section.api_key")]);
    });

    it("warns that a subscription login may break the provider's terms", async () => {
      await openCodex();
      expect(screen.getByText(t("providers.riskNotice"))).toBeTruthy();
      // There is no key to get: the link goes to the provider's sign-up page.
      expect(screen.getByRole("link", { name: t("providers.signUp") }).getAttribute("href")).toBe("https://chatgpt.com/codex");
      expect(screen.queryByRole("link", { name: t("providers.getKey") })).toBeNull();
    });

    it("signing in opens the provider's page in a new tab, then takes the address the browser ended on", async () => {
      await openCodex();
      fireEvent.click(screen.getByRole("button", { name: t("providers.add") }));
      await waitFor(() => expect(opened).toEqual([AUTHORIZE]));
      expect(calls.find((c) => c.url === "/admin/oauth/codex/start")).toMatchObject({ method: "POST" });

      const back = "http://localhost:1455/auth/callback?code=xyz&state=abc";
      fireEvent.change(await screen.findByLabelText(t("providers.oauth.callback")), { target: { value: back } });
      fireEvent.click(screen.getByRole("button", { name: t("providers.oauth.finish") }));
      await waitFor(() => expect(calls.find((c) => c.url === "/admin/oauth/codex/finish")).toMatchObject({ method: "POST", body: { callback_url: back } }));
      expect(await screen.findByText(t("providers.signedIn", { name: "dev@example.com" }))).toBeTruthy();
    });

    it("shows what the provider answered when the sign-in is refused, and keeps the dialog open", async () => {
      routes["POST /admin/oauth/codex/finish"] = () => json({ error: "provider_refused", message: "code expired" }, 502);
      await openCodex();
      fireEvent.click(screen.getByRole("button", { name: t("providers.add") }));
      fireEvent.change(await screen.findByLabelText(t("providers.oauth.callback")), { target: { value: "http://localhost:1455/auth/callback?code=x&state=abc" } });
      fireEvent.click(screen.getByRole("button", { name: t("providers.oauth.finish") }));
      expect(await screen.findByText(t("providers.oauth.failed", { message: "code expired" }))).toBeTruthy();
      expect(screen.getByLabelText(t("providers.oauth.callback"))).toBeTruthy();
    });

    it("a device sign-in shows the code, opens the provider's page and closes when the gateway says it is done", async () => {
      const GITHUB = { ...CODEX, id: "github", name: "GitHub Copilot", format: "openai", key_url: "https://github.com/settings/copilot", color: "#333333", mark: "GH" };
      const OCTO = account({ id: "o2", provider: "github", auth_type: "oauth", name: "octo@example.com", hint: null, account: "42", expires_at: 1_790_003_600 });
      routes["GET /admin/providers"] = () => json([...PROVIDER_LIST, CODEX, GITHUB]);
      routes["GET /admin/connections"] = () => json([WORK, OCTO]);
      routes["POST /admin/oauth/github/start"] = () =>
        json({ flow: "device", id: "dev-1", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 600 });
      let polls = 0;
      routes["POST /admin/oauth/github/poll"] = () => (++polls === 1 ? json({ status: "pending", interval: 1 }, 202) : json(OCTO, 201));
      window.location.hash = "#/providers/github";
      await signIn();
      await screen.findByText("octo@example.com");
      fireEvent.click(screen.getByRole("button", { name: t("providers.add") }));
      await waitFor(() => expect(opened).toEqual(["https://github.com/login/device"]));
      expect(await screen.findByRole("group", { name: t("providers.device.code") })).toBeTruthy();
      expect(screen.getByText(t("providers.device.waiting"))).toBeTruthy();
      expect(await screen.findByText(t("providers.signedIn", { name: "octo@example.com" }), undefined, { timeout: 4000 })).toBeTruthy();
      expect(polls).toBe(2);
      expect(calls.filter((c) => c.url === "/admin/oauth/github/poll").map((c) => c.body)).toEqual([{ id: "dev-1" }, { id: "dev-1" }]);
    });

    it("the paste hint names the address the provider sends the browser back to", async () => {
      expect(redirectOrigin("https://claude.ai/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback")).toBe("http://localhost:54545");
      expect(redirectOrigin("https://auth.openai.com/oauth/authorize?state=abc")).toBe("http://localhost");
      expect(redirectOrigin("not a url")).toBe("http://localhost");
    });

    it("a signed-in connection can be renamed but has no key to replace", async () => {
      await openCodex();
      fireEvent.click(screen.getByRole("button", { name: `${t("systems.col.actions")}: dev@example.com` }));
      fireEvent.click(await screen.findByRole("menuitem", { name: t("providers.edit") }));
      expect(screen.getByLabelText(t("providers.name"))).toBeTruthy();
      expect(screen.queryByLabelText(t("providers.apiKey"))).toBeNull();
    });
  });

  it("providerLogo: the logo file of a provider that has one, else null (its letters show instead)", () => {
    expect(providerLogo("mistral")).toBe("/providers/mistral.svg");
    expect(providerLogo("alicode")).toBe("/providers/alicode.png");
    expect(providerLogo("runcrate")).toBeNull();
    expect(providerLogo("../secret")).toBeNull();
  });

  it("clientLogo: a system named after a tool shows that tool's logo; other names keep their letters", () => {
    expect(clientLogo("Claude Code")).toBe("/cli/claude-code.png");
    expect(clientLogo("n8n flows")).toBe("/clients/n8n.svg");
    expect(clientLogo("Batch jobs")).toBeNull();
    // A tool name inside another word is not that tool.
    expect(clientLogo("Authorized bot")).toBeNull();
  });

  it("providerFromHash: the provider of a detail page, else null", () => {
    expect(providerFromHash("#/providers/openai")).toBe("openai");
    expect(providerFromHash("#/providers")).toBeNull();
    expect(providerFromHash("#/providers/Bad Id")).toBeNull();
    expect(providerFromHash("#/systems")).toBeNull();
    expect(pageFromHash("#/providers")).toBe("providers");
    expect(pageFromHash("#/providers/openai")).toBe("providers");
  });
});

describe("theme", () => {
  it("the theme icon button flips the theme on the page and keeps it for the next visit", async () => {
    window.location.hash = "#/systems";
    await signIn();
    await screen.findByText("Chat");
    // No system preference in the test DOM, so the page starts dark and the one button offers light.
    expect(screen.queryByRole("button", { name: t("theme.light") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("theme.toLight") }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("ai-router.theme")).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: t("theme.toDark") }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("ai-router.theme")).toBe("dark");
  });
});

describe("usage", () => {
  async function openUsage() {
    window.location.hash = "#/usage";
    await signIn();
    await screen.findByRole("heading", { name: t("usage.title") });
  }

  it("shows the last 24 hours: totals, the cost estimate, and what is behind them", async () => {
    await openUsage();
    // Every token of the period in short form (4,010 in, 620 out, 30 + 240 cache), and the share read from the cache.
    expect(await screen.findByText("4.9K")).toBeTruthy();
    expect(screen.getByText("5.6%")).toBeTruthy();
    expect(calls.some((c) => c.url === "/admin/usage/summary?period=24h")).toBe(true);
    // The total, and the model that makes it up.
    expect(screen.getAllByText("~$3.60")).toHaveLength(2);
    expect(screen.getByText(t("usage.unpriced", { n: "1" }))).toBeTruthy();
    expect(screen.getAllByText("gpt-5").length).toBeGreaterThan(0);
    expect(screen.getAllByText("llama-4").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: t("usage.byProvider") })).toBeTruthy();
    expect(screen.getByRole("heading", { name: t("usage.topModels") })).toBeTruthy();
    expect(screen.getByRole("heading", { name: t("usage.recent") })).toBeTruthy();
  });

  it("loads another period when one is picked", async () => {
    await openUsage();
    await screen.findByText("4.9K");
    fireEvent.click(screen.getByRole("button", { name: t("usage.period.7d") }));
    await waitFor(() => expect(calls.some((c) => c.url === "/admin/usage/summary?period=7d")).toBe(true));
  });

  it("Details lists each request with its status and latency, and filters by provider", async () => {
    routes["GET /admin/providers"] = () => json([{ id: "openai", name: "OpenAI", format: "openai", auth: ["api_key"], env_key: false, key_url: null, strategy: "fill-first" }]);
    await openUsage();
    fireEvent.click(screen.getByRole("tab", { name: t("usage.tab.details") }));
    expect(await screen.findByText("812 ms")).toBeTruthy();
    expect(screen.getByText("429")).toBeTruthy();
    expect(screen.getByText("llama-4")).toBeTruthy();
    expect(calls.some((c) => c.url === "/admin/usage/requests?limit=100")).toBe(true);

    fireEvent.change(await screen.findByLabelText(t("usage.filter.provider")), { target: { value: "openai" } });
    await waitFor(() => expect(calls.some((c) => c.url === "/admin/usage/requests?limit=100&provider=openai")).toBe(true));
  });
});

describe("token saver", () => {
  const SETTINGS = { rtk: true, caveman: null, ponytail: "lite", custom_prompt: null, headroom: { enabled: false, url: null } };
  const puts = () => calls.filter((c) => c.method === "PUT" && c.url === "/admin/token-saver").map((c) => c.body);

  beforeEach(() => {
    routes["GET /admin/token-saver"] = () => json(SETTINGS);
    routes["PUT /admin/token-saver"] = () => json(SETTINGS);
  });

  async function openSavers() {
    window.location.hash = "#/token-saver";
    await signIn();
    await screen.findByRole("switch", { name: t("saver.rtk") });
  }

  it("shows the gateway's savers as they are set", async () => {
    await openSavers();
    expect(screen.getByRole("heading", { name: t("saver.title") })).toBeTruthy();
    expect((screen.getByRole("switch", { name: t("saver.rtk") }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(t("saver.caveman")) as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText(t("saver.ponytail")) as HTMLSelectElement).value).toBe("lite");
    expect((screen.getByRole("switch", { name: t("saver.headroom") }) as HTMLInputElement).checked).toBe(false);
  });

  it("a switch or a level is saved at once, alone", async () => {
    await openSavers();
    fireEvent.click(screen.getByRole("switch", { name: t("saver.rtk") }));
    await waitFor(() => expect(puts()).toEqual([{ rtk: false }]));
    fireEvent.change(screen.getByLabelText(t("saver.caveman")), { target: { value: "full" } });
    await waitFor(() => expect(puts()).toEqual([{ rtk: false }, { caveman: "full" }]));
    fireEvent.change(screen.getByLabelText(t("saver.ponytail")), { target: { value: "" } });
    await waitFor(() => expect(puts()[2]).toEqual({ ponytail: null }));
    // One notice per save.
    expect((await screen.findAllByText(t("saver.saved"))).length).toBeGreaterThanOrEqual(1);
  });

  it("saves the custom prompt with its button", async () => {
    await openSavers();
    fireEvent.change(screen.getByLabelText(t("saver.custom")), { target: { value: "Answer in British English." } });
    fireEvent.click(screen.getByRole("button", { name: t("saver.saveCustom") }));
    await waitFor(() => expect(puts()).toEqual([{ custom_prompt: "Answer in British English." }]));
  });

  it("Headroom needs an address before it can be switched on, and refuses one that is not a web address", async () => {
    await openSavers();
    const sw = screen.getByRole("switch", { name: t("saver.headroom") }) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(t("saver.headroomUrl")), { target: { value: "headroom" } });
    fireEvent.click(screen.getByRole("button", { name: t("saver.saveHeadroom") }));
    expect(await screen.findByText(t("saver.headroomUrlBad"))).toBeTruthy();
    expect(puts()).toEqual([]);

    fireEvent.change(screen.getByLabelText(t("saver.headroomUrl")), { target: { value: "https://headroom.test" } });
    fireEvent.click(screen.getByRole("button", { name: t("saver.saveHeadroom") }));
    await waitFor(() => expect(puts()).toEqual([{ headroom: { enabled: false, url: "https://headroom.test" } }]));
  });

  it("lays the Headroom address out as a setting row and titles the custom prompt card", async () => {
    await openSavers();
    const address = screen.getByLabelText(t("saver.headroomUrl"));
    const row = address.closest(".settings-item");
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).getByText(t("saver.headroomUrlHint"))).toBeTruthy();
    expect(within(row as HTMLElement).getByRole("button", { name: t("saver.saveHeadroom") })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: t("saver.customCard") })).toBeTruthy();
    for (const id of ["saver-rtk", "saver-headroom", "saver-caveman", "saver-ponytail"]) {
      expect(document.getElementById(id)?.getAttribute("aria-describedby")).toBe(`${id}-hint`);
    }
  });

  it("the intro grows only as a column of a .page-actions row, never as height", () => {
    const intro = /\n\.page-intro\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(intro).not.toMatch(/\bflex\s*:/);
    expect(styles).toMatch(/\.page-actions\s*>\s*\.page-intro\s*\{[^}]*flex:\s*1 1 20rem/);
  });

  it("the two Save buttons wait for a change, and the one saving says so", async () => {
    routes["GET /admin/token-saver"] = () => json({ ...SETTINGS, custom_prompt: "Be brief.", headroom: { enabled: false, url: "https://headroom.test" } });
    let release: () => void = () => {};
    routes["PUT /admin/token-saver"] = () => new Promise<Response>((r) => (release = () => r(json(SETTINGS))));
    await openSavers();
    const saveUrl = () => screen.getByRole("button", { name: /^(Save address|Saving)$/ }) as HTMLButtonElement;
    const savePrompt = () => screen.getByRole("button", { name: t("saver.saveCustom") }) as HTMLButtonElement;
    expect(saveUrl().disabled).toBe(true);
    expect(savePrompt().disabled).toBe(true);

    // Only spaces around the saved value is no change.
    fireEvent.change(screen.getByLabelText(t("saver.custom")), { target: { value: " Be brief. " } });
    expect(savePrompt().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(t("saver.custom")), { target: { value: "Be briefer." } });
    expect(savePrompt().disabled).toBe(false);

    // An address that is not a web address still enables Save, so the error can show.
    fireEvent.change(screen.getByLabelText(t("saver.headroomUrl")), { target: { value: "headroom" } });
    expect(saveUrl().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(t("saver.headroomUrl")), { target: { value: "https://other.test" } });
    fireEvent.click(saveUrl());
    expect(await screen.findByRole("button", { name: t("common.saving") })).toBeTruthy();
    expect(savePrompt().disabled).toBe(true);
    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: t("common.saving") })).toBeNull());
  });

  it("switches Headroom on when it has an address", async () => {
    routes["GET /admin/token-saver"] = () => json({ ...SETTINGS, headroom: { enabled: false, url: "https://headroom.test" } });
    await openSavers();
    fireEvent.click(screen.getByRole("switch", { name: t("saver.headroom") }));
    await waitFor(() => expect(puts()).toEqual([{ headroom: { enabled: true, url: "https://headroom.test" } }]));
  });
});

describe("overview", () => {
  const now = 1_790_000_000;
  const conn = (over: Partial<Connection>): Connection => ({
    id: "a", provider: "openai", auth_type: "api_key", name: "work", hint: null, account: null, expires_at: null, priority: 1,
    disabled: false, cooldown_until: 0, last_error: null, last_error_at: null, last_used_at: null, created_at: 1, updated_at: 1, ...over,
  });

  it("is the page the console opens on", async () => {
    window.history.replaceState({}, "", "/");
    await signIn();
    expect(await screen.findByRole("heading", { name: t("overview.title") })).toBeTruthy();
    expect(await screen.findByText(t("overview.caps.title"))).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/admin/usage/summary?period=today"))).toBe(true));
    expect(calls.some((c) => c.url === "/admin/usage/requests?status=error&limit=5")).toBe(true);
  });

  it("lists what needs a look: a failing account first, then one cooling down and a system near its cap", async () => {
    window.history.replaceState({}, "", "/#/overview");
    const t0 = Date.now() / 1000;
    routes["GET /admin/providers"] = () => json([{ id: "openai", name: "OpenAI", format: "openai", auth: ["api_key"], env_key: false, key_url: null, strategy: "fill-first", color: "#10a37f", mark: "OA" }]);
    routes["GET /admin/connections"] = () =>
      json([
        conn({ id: "a", name: "cool", cooldown_until: t0 + 300 }),
        conn({ id: "b", name: "broken", last_error: "401 invalid key", last_error_at: t0 - 60, last_used_at: t0 - 3600 }),
        conn({ id: "c", name: "off", disabled: true, cooldown_until: t0 + 300 }),
      ]);
    routes["GET /admin/usage"] = () =>
      json({ month: "2026-11", rows: [{ ...USAGE.rows[0], input_tokens: 800, output_tokens: 100 }] });
    await signIn();
    await screen.findByRole("heading", { name: t("overview.attn.titleN", { n: "3" }) });
    // The attention list is the page's first list.
    const list = screen.getByText("OpenAI · broken").closest("ul")!;
    const rows = within(list).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("OpenAI · broken");
    expect(rows[0]).toContain("401 invalid key");
    expect(rows.some((r) => r.includes("OpenAI · cool"))).toBe(true);
    expect(rows.some((r) => r.includes("Chat") && r.includes(t("overview.attn.nearCap", { n: "90" })))).toBe(true);
    expect(rows.some((r) => r.includes("off"))).toBe(false);
  });

  it("says when nothing needs a look", async () => {
    window.history.replaceState({}, "", "/#/overview");
    routes["GET /admin/connections"] = () => json([conn({})]);
    await signIn();
    expect(await screen.findByText(t("overview.attn.none"))).toBeTruthy();
  });

  it("attentionItems: an error older than the last success or a day does not count; a reached cap is danger", () => {
    const sys = { ...SYSTEM, monthly_token_cap: 1000 };
    const items = attentionItems(
      [
        conn({ id: "old", last_error: "x", last_error_at: now - 2 * 86_400 }),
        conn({ id: "fixed", last_error: "x", last_error_at: now - 600, last_used_at: now - 60 }),
      ],
      [sys, { ...sys, id: "off", disabled: true }],
      new Map([["chat", 1000], ["off", 5000]]),
      new Map(),
      "en",
      now,
    );
    expect(items.map((i) => [i.key, i.tone])).toEqual([["cap:chat", "danger"]]);
  });

  it("monthUsed and capShare count every token against the cap", () => {
    const used = monthUsed(USAGE);
    expect(used.get("chat")).toBe(500);
    expect(capShare({ ...SYSTEM, monthly_token_cap: 1000 }, 500)).toBe(50);
    expect(capShare({ ...SYSTEM, monthly_token_cap: null }, 500)).toBeNull();
    expect(capShare({ ...SYSTEM, monthly_token_cap: 0 }, 0)).toBe(100);
  });
});

describe("page tabs", () => {
  const paths = (tabs: { path: string }[]) => tabs.map((x) => x.path);
  it("tabPathOf drops the query and maps an empty hash to Overview", () => {
    expect(tabPathOf("#/usage?tab=details")).toBe("/usage");
    expect(tabPathOf("")).toBe(HOME);
    expect(tabPathOf("#/providers/openai")).toBe("/providers/openai");
  });
  it("visitTab keeps Overview first, each page once, at most the limit", () => {
    let tabs = visitTab([], "/usage");
    expect(paths(tabs)).toEqual([HOME, "/usage"]);
    tabs = visitTab(tabs, "/usage");
    expect(paths(tabs)).toEqual([HOME, "/usage"]);
    tabs = ["/a", "/b", "/c"].reduce((acc, x) => visitTab(acc, x, 3), tabs);
    expect(paths(tabs)).toEqual([HOME, "/b", "/c"]);
  });
  it("closeTabs never closes Overview and moves off a closed open page", () => {
    const tabs = [HOME, "/a", "/b", "/c"].map((path) => ({ path }));
    expect(closeTabs(tabs, "close", "/b", "/b")).toEqual({ tabs: [HOME, "/a", "/c"].map((path) => ({ path })), go: "/c" });
    expect(paths(closeTabs(tabs, "others", "/b", "/b").tabs)).toEqual([HOME, "/b"]);
    expect(closeTabs(tabs, "all", "/a", "/c")).toEqual({ tabs: [{ path: HOME }], go: HOME });
    expect(paths(closeTabs(tabs, "left", "/b", "/c").tabs)).toEqual([HOME, "/b", "/c"]);
  });
  it("readTabs drops anything malformed", () => {
    expect(readTabs('[{"path":"/usage"},{"path":3},"x",{"path":"usage"}]')).toEqual([{ path: "/usage" }]);
    expect(readTabs("not json")).toEqual([]);
  });
});

describe("helpers", () => {
  it("parseCap: empty is no cap, digits are a cap, anything else is invalid", () => {
    expect(parseCap("")).toBeNull();
    expect(parseCap(" 42 ")).toBe(42);
    expect(parseCap("-1")).toBeUndefined();
    expect(parseCap("1.5")).toBeUndefined();
    expect(parseCap("99999999999999999999")).toBeUndefined();
  });

  it("pageFromHash knows the three pages", () => {
    expect(pageFromHash("#/combos")).toBe("combos");
    expect(pageFromHash("#/usage")).toBe("usage");
    expect(pageFromHash("#/whatever")).toBe("overview");
  });

  it("pageFromHash knows the token saver page", () => {
    expect(pageFromHash("#/token-saver")).toBe("token-saver");
  });

  it("pageFromHash: Overview when the page is unknown or missing", () => {
    expect(pageFromHash("#/usage")).toBe("usage");
    expect(pageFromHash("#/systems")).toBe("systems");
    expect(pageFromHash("")).toBe("overview");
    expect(pageFromHash("#/nope")).toBe("overview");
  });
});
