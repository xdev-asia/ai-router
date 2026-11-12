import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, pageFromHash, providerFromHash } from "../App";
import { setToken } from "../api";
import { resetLang, t } from "../i18n";
import { parseCap } from "../pages/Systems";

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
const REQUESTS = {
  rows: [
    { id: 9, at: 1_790_000_500, system_id: "chat", provider: "openai", model: "gpt-5", status: 429, streamed: false, ...TOKENS, input_tokens: 77, latency_ms: 812 },
    { id: 8, at: 1_790_000_400, system_id: "chat", provider: "groq", model: "llama-4", status: 200, streamed: true, ...TOKENS, output_tokens: 55, latency_ms: null },
  ],
};

let calls: { method: string; url: string; auth: string | null; body: unknown }[];
let routes: Record<string, () => Response>;
/** The xDev ID session the fake gateway sees (the cookie itself is invisible to the page). */
let ssoUser: { email: string; name: string } | null;
let ssoConfigured: boolean;

beforeEach(() => {
  localStorage.setItem("xdev-llm.lang", "en");
  resetLang();
  window.location.hash = "";
  calls = [];
  ssoUser = null;
  ssoConfigured = false;
  window.history.replaceState({}, "", "/");
  routes = {
    "GET /admin/systems": () => json([SYSTEM]),
    "GET /admin/usage": () => json(USAGE),
    "GET /admin/usage/summary": () => json(SUMMARY),
    "GET /admin/usage/requests": () => json(REQUESTS),
    "POST /admin/systems": () => json({ id: "xdevd", token: "xllm_new_token" }, 201),
    "PATCH /admin/systems/chat": () => json(SYSTEM),
    "GET /admin/combos": () => json([{ name: "fast", targets: ["groq/llama", "claude-haiku-5-5"], updated_at: 1 }]),
    "PUT /admin/combos/cheap": () => json({ name: "cheap", targets: ["groq/llama"], updated_at: 2 }),
    "DELETE /admin/combos/fast": () => new Response(null, { status: 204 }),
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ method, url, auth, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/auth/me") return ssoUser ? json(ssoUser) : json({ error: "unauthorized", sso: ssoConfigured }, 401);
    if (url === "/auth/logout") {
      ssoUser = null;
      return new Response(null, { status: 204 });
    }
    const signedIn = auth === "Bearer good-admin-token" || (auth === null && ssoUser !== null);
    if (!signedIn) return json({ error: "unauthorized" }, 401);
    const route = routes[`${method} ${url.split("?")[0]}`];
    return route ? route() : json({ error: "not_found" }, 404);
  });
});

afterEach(() => {
  cleanup();
  act(() => setToken(null));
  vi.unstubAllGlobals();
});

async function signIn(token = "good-admin-token") {
  render(<App />);
  fireEvent.change(screen.getByLabelText(t("signin.token")), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: t("signin.submit") }));
}

describe("sign in", () => {
  it("shows an error for a wrong token and stays on the sign-in page", async () => {
    await signIn("bad");
    expect(await screen.findByText(t("signin.wrong"))).toBeTruthy();
    expect(screen.queryByText(t("systems.title"))).toBeNull();
  });

  it("opens the systems page with a good token and sends it as a bearer", async () => {
    await signIn();
    expect(await screen.findByRole("heading", { name: t("systems.title") })).toBeTruthy();
    expect(await screen.findByText("Chat")).toBeTruthy();
    expect(screen.getByText(t("systems.used", { used: "500", cap: "1,000" }))).toBeTruthy();
    expect(screen.getByText("chat")).toBeTruthy();
    const adminCalls = calls.filter((c) => c.url.startsWith("/admin/"));
    expect(adminCalls.length).toBeGreaterThan(0);
    expect(adminCalls.every((c) => c.auth === "Bearer good-admin-token")).toBe(true);
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
    routes["GET /admin/usage/summary"] = () => json({ error: "unauthorized" }, 401);
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
    fireEvent.click(screen.getByRole("button", { name: t("shell.signOut") }));
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
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ id: "xdevd", name: "xDev daemon", monthly_token_cap: 5000 });
  });

  it("validates the id before calling the API", async () => {
    await signIn();
    await screen.findByText("Chat");
    fireEvent.click(screen.getByRole("button", { name: t("systems.add") }));
    fireEvent.change(screen.getByLabelText(t("create.id")), { target: { value: "Bad Id" } });
    fireEvent.change(screen.getByLabelText(t("create.name")), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: t("create.submit") }));
    await waitFor(() => expect(screen.getByLabelText(t("create.id")).getAttribute("aria-invalid")).toBe("true"));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
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
  it("lists combos, adds one and deletes one", async () => {
    window.location.hash = "#/combos";
    await signIn();
    expect(await screen.findByText("combo/fast")).toBeTruthy();
    expect(screen.getByText("claude-haiku-5-5")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t("combos.add") }));
    fireEvent.change(screen.getByLabelText(t("combos.name")), { target: { value: "cheap" } });
    fireEvent.change(screen.getByLabelText(t("combos.targets")), { target: { value: "groq/llama" } });
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toMatchObject({ url: "/admin/combos/cheap", body: { targets: ["groq/llama"] } }));

    fireEvent.click(await screen.findByRole("button", { name: `${t("systems.col.actions")}: fast` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("combos.delete") }));
    fireEvent.click(await screen.findByRole("button", { name: t("combos.delete") }));
    expect(await screen.findByText(t("combos.deletedNotice", { name: "fast" }))).toBeTruthy();
  });

  it("checks the name and the targets before saving", async () => {
    window.location.hash = "#/combos";
    await signIn();
    await screen.findByText("combo/fast");
    fireEvent.click(screen.getByRole("button", { name: t("combos.add") }));
    fireEvent.change(screen.getByLabelText(t("combos.name")), { target: { value: "Bad Name" } });
    fireEvent.change(screen.getByLabelText(t("combos.targets")), { target: { value: "gpt-5" } });
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    expect(await screen.findByText(t("settings.modelsBad", { bad: "gpt-5" }))).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("providers", () => {
  const PROVIDER_LIST = [
    { id: "anthropic", name: "Anthropic", format: "anthropic", auth: ["api_key"], env_key: true, key_url: "https://console.anthropic.com/settings/keys", strategy: "fill-first" },
    { id: "openai", name: "OpenAI", format: "openai", auth: ["api_key"], env_key: false, key_url: "https://platform.openai.com/api-keys", strategy: "fill-first" },
    { id: "groq", name: "Groq", format: "openai", auth: ["api_key"], env_key: false, key_url: null, strategy: "round-robin" },
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
    expect(screen.getByText(t("providers.noMatch"))).toBeTruthy();
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
    expect(screen.getByRole("heading", { name: "OpenAI" })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.url === "/admin/connections")).toMatchObject({ body: { provider: "openai", name: "New", api_key: "sk-new-12345678" } }));
    expect(await screen.findByText(t("providers.savedNotice", { name: "New" }))).toBeTruthy();
    expect(document.body.textContent).not.toContain("sk-new-12345678");
  });

  it("asks for a name and a key before calling the API", async () => {
    await openProvider();
    fireEvent.click(screen.getByRole("button", { name: t("providers.add") }));
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    expect(await screen.findByText(t("providers.nameRequired"))).toBeTruthy();
    expect(screen.getByText(t("providers.apiKeyRequired"))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
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
    expect(await screen.findByText(t("providers.testFailed", { name: "Backup", error: "401 Invalid API Key" }))).toBeTruthy();
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
  it("the theme switch paints the choice on the page and keeps it for the next visit", async () => {
    window.location.hash = "#/systems";
    await signIn();
    await screen.findByText("Chat");
    fireEvent.click(screen.getByRole("button", { name: t("theme.light") }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("xdev-llm.theme")).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: t("theme.dark") }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("xdev-llm.theme")).toBe("dark");
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
    // The total and the only system's row both read 4,010 input tokens.
    expect(await screen.findAllByText("4,010")).toHaveLength(2);
    expect(calls.some((c) => c.url === "/admin/usage/summary?period=24h")).toBe(true);
    // The total, and the provider, system and model that make it up.
    expect(screen.getAllByText("~$3.60")).toHaveLength(4);
    expect(screen.getByText(t("usage.unpriced", { n: "1" }))).toBeTruthy();
    expect(screen.getAllByText("gpt-5").length).toBeGreaterThan(0);
    expect(screen.getByText("llama-4")).toBeTruthy();
    expect(screen.getByRole("heading", { name: t("usage.byProvider") })).toBeTruthy();
    expect(screen.getByRole("heading", { name: t("usage.topModels") })).toBeTruthy();
    expect(screen.getByRole("heading", { name: t("usage.recent") })).toBeTruthy();
  });

  it("loads another period when one is picked", async () => {
    await openUsage();
    await screen.findAllByText("4,010");
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

  it("switches Headroom on when it has an address", async () => {
    routes["GET /admin/token-saver"] = () => json({ ...SETTINGS, headroom: { enabled: false, url: "https://headroom.test" } });
    await openSavers();
    fireEvent.click(screen.getByRole("switch", { name: t("saver.headroom") }));
    await waitFor(() => expect(puts()).toEqual([{ headroom: { enabled: true, url: "https://headroom.test" } }]));
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
    expect(pageFromHash("#/whatever")).toBe("systems");
  });

  it("pageFromHash knows the token saver page", () => {
    expect(pageFromHash("#/token-saver")).toBe("token-saver");
  });

  it("pageFromHash: usage or systems", () => {
    expect(pageFromHash("#/usage")).toBe("usage");
    expect(pageFromHash("")).toBe("systems");
    expect(pageFromHash("#/nope")).toBe("systems");
  });
});
