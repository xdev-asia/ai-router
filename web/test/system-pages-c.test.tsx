import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { parseBulkKeys } from "../pages/Providers";
import { readBackup, validateSso } from "../pages/Settings";

// Settings, the add-account dialog (bulk add, Check, priority, proxy pool) and Codex's custom headers.
// Every key here is made up for the test.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: { method: string; url: string; body: unknown }[];
let routes: Record<string, (body?: unknown) => Response>;
let signedIn: boolean;

const PROVIDERS = [
  { id: "openai", name: "OpenAI", format: "openai", auth: ["api_key"], env_key: false, key_url: null, strategy: "fill-first", color: "#10A37F", mark: "OA", free_tier: false },
  { id: "groq", name: "Groq", format: "openai", auth: ["api_key"], env_key: false, key_url: null, strategy: "fill-first", color: "#F55036", mark: "GQ", free_tier: true },
  { id: "codex", name: "OpenAI Codex", format: "codex", auth: ["oauth"], env_key: false, key_url: null, strategy: "fill-first", color: "#3B82F6", mark: "CX", free_tier: false },
];
const account = (over: Record<string, unknown>) => ({
  id: "c1",
  provider: "openai",
  auth_type: "api_key",
  name: "Work",
  hint: "1234",
  account: null,
  expires_at: null,
  priority: 1,
  disabled: false,
  cooldown_until: 0,
  last_error: null,
  last_error_at: null,
  last_used_at: null,
  proxy_pool: null,
  created_at: 1_790_000_000,
  updated_at: 1_790_000_000,
  ...over,
});

beforeEach(() => {
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  window.location.hash = "";
  window.history.replaceState({}, "", "/");
  calls = [];
  signedIn = false;
  routes = {
    "GET /admin/providers": () => json(PROVIDERS),
    "GET /admin/connections": () => json([account({})]),
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === "/auth/token") {
      signedIn = new Headers(init.headers).get("authorization") === "Bearer good-admin-token";
      return signedIn ? json({ admin: true }) : json({ error: "unauthorized" }, 401);
    }
    if (url === "/auth/me") return signedIn ? json({ admin: true }) : json({ error: "unauthorized", sso: false }, 401);
    if (!signedIn) return json({ error: "unauthorized" }, 401);
    const route = routes[`${method} ${url.split("?")[0]}`];
    return route ? route(body) : json({ error: "not_found" }, 404);
  });
});

afterEach(() => {
  cleanup();
  act(() => setAuth(null));
  vi.unstubAllGlobals();
});

async function signIn() {
  render(<App />);
  fireEvent.change(await screen.findByLabelText(t("signin.token")), { target: { value: "good-admin-token" } });
  fireEvent.click(screen.getByRole("button", { name: t("signin.submit") }));
}

async function openAddDialog(provider = "openai") {
  window.location.hash = `#/providers/${provider}`;
  await signIn();
  await screen.findByText("Work");
  fireEvent.click(screen.getByRole("button", { name: t("providers.add") }));
  return screen.getByRole("dialog");
}

describe("bulk add", () => {
  it("reads one key per line, an optional name before the first bar, and says which lines are wrong", () => {
    const { lines, problems } = parseBulkKeys("Main|sk-test-aaaa\n\n  sk-test-bbbb  \nOdd|sk-test|with-bar\nNo key|\n" + "n".repeat(101) + "|sk-test-cccc");
    expect(lines.map((l) => [l.line, l.name, l.key])).toEqual([
      [1, "Main", "sk-test-aaaa"],
      [3, null, "sk-test-bbbb"],
      [4, "Odd", "sk-test|with-bar"],
    ]);
    expect(problems).toEqual([
      { line: 5, kind: "emptyKey" },
      { line: 6, kind: "longName" },
    ]);
    expect(parseBulkKeys(" \n\n")).toEqual({ lines: [], problems: [] });
  });

  it("creates the keys one after another, names the unnamed ones, and keeps the failed lines in the box", async () => {
    routes["POST /admin/connections"] = (body) => {
      const b = body as { name: string; api_key: string };
      return b.api_key === "sk-test-bad" ? json({ error: "invalid_input" }, 400) : json(account({ id: `n-${b.name}`, name: b.name }), 201);
    };
    const dialog = await openAddDialog();
    fireEvent.click(within(dialog).getByRole("tab", { name: t("providers.tab.bulk") }));
    const box = within(dialog).getByLabelText(t("providers.bulkKeys")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Main|sk-test-aaaa\nsk-test-bbbb\nBad|sk-test-bad" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("providers.bulkSave", { n: "3" }) }));

    expect(await within(dialog).findByText(t("providers.bulkSome", { ok: "2", n: "3" }))).toBeTruthy();
    const posts = calls.filter((c) => c.method === "POST" && c.url === "/admin/connections").map((c) => c.body);
    expect(posts).toEqual([
      { provider: "openai", name: "Main", api_key: "sk-test-aaaa" },
      { provider: "openai", name: t("providers.bulkKeyName", { n: "2" }), api_key: "sk-test-bbbb" },
      { provider: "openai", name: "Bad", api_key: "sk-test-bad" },
    ]);
    expect(within(dialog).getByText(t("providers.bulkLineOk", { line: "1", name: "Main" }))).toBeTruthy();
    expect(within(dialog).getByText(t("providers.bulkLineFailed", { line: "3", error: t("providers.bulkRefused") }))).toBeTruthy();
    expect(box.value).toBe("Bad|sk-test-bad");
  });

  it("closes and says how many were saved when every line is saved", async () => {
    routes["POST /admin/connections"] = (body) => json(account({ id: "n", name: (body as { name: string }).name }), 201);
    const dialog = await openAddDialog();
    fireEvent.click(within(dialog).getByRole("tab", { name: t("providers.tab.bulk") }));
    fireEvent.change(within(dialog).getByLabelText(t("providers.bulkKeys")), { target: { value: "sk-test-one\nsk-test-two" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("providers.bulkSave", { n: "2" }) }));
    expect(await screen.findByText(t("providers.bulkDone", { n: "2" }))).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain("sk-test-one");
  });

  it("names a line with no key and calls nothing", async () => {
    const dialog = await openAddDialog();
    fireEvent.click(within(dialog).getByRole("tab", { name: t("providers.tab.bulk") }));
    fireEvent.change(within(dialog).getByLabelText(t("providers.bulkKeys")), { target: { value: "sk-test-one\nEmpty|" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("providers.bulkSave", { n: "1" }) }));
    expect(await within(dialog).findByText(t("providers.bulkEmptyKey", { line: "2" }))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url === "/admin/connections")).toBe(false);
  });
});

describe("one key", () => {
  it("Check asks the gateway, shows the outcome and the time, and never shows the key", async () => {
    const KEY = "sk-test-check-1234567";
    let answer: unknown = { ok: false, status: 401, message: `Incorrect API key provided: ${KEY}` };
    routes["POST /admin/connections/check"] = () => json(answer);
    const dialog = await openAddDialog();
    const check = within(dialog).getByRole("button", { name: t("providers.check") }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(t("providers.apiKey")), { target: { value: KEY } });
    fireEvent.click(check);

    expect(await within(dialog).findByText(t("providers.checkFailed", { status: "401", message: "Incorrect API key provided: ***" }))).toBeTruthy();
    expect(calls.find((c) => c.url === "/admin/connections/check")!.body).toEqual({ provider: "openai", api_key: KEY });
    expect(document.body.textContent).not.toContain(KEY);
    // Nothing is saved by a check.
    expect(calls.some((c) => c.method === "POST" && c.url === "/admin/connections")).toBe(false);

    answer = { ok: true };
    fireEvent.click(check);
    expect(await within(dialog).findByText(new RegExp(t("providers.checkOk", { ms: "\\d+" }).replace(/[()]/g, "\\$&")))).toBeTruthy();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("sends a priority and a proxy pool only when they are chosen", async () => {
    routes["GET /admin/proxy-pools"] = () => json([{ id: "p1", name: "Home relays" }]);
    routes["POST /admin/connections"] = () => json(account({ id: "c9", name: "New" }), 201);
    const dialog = await openAddDialog();
    fireEvent.change(within(dialog).getByLabelText(t("providers.name")), { target: { value: "New" } });
    fireEvent.change(within(dialog).getByLabelText(t("providers.apiKey")), { target: { value: "sk-test-new" } });
    fireEvent.change(within(dialog).getByLabelText(t("providers.priority")), { target: { value: "5000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("providers.add") }));
    expect(await within(dialog).findByText(t("providers.priorityBad"))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url === "/admin/connections")).toBe(false);

    fireEvent.change(within(dialog).getByLabelText(t("providers.priority")), { target: { value: "2" } });
    fireEvent.change(await within(dialog).findByLabelText(t("providers.pool")), { target: { value: "p1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("providers.add") }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST" && c.url === "/admin/connections")!.body).toEqual({
        provider: "openai",
        name: "New",
        api_key: "sk-test-new",
        priority: 2,
        proxy_pool: "p1",
      }),
    );
  });
});

describe("providers page", () => {
  it("puts the free tier providers in their own section, before the API key providers", async () => {
    window.location.hash = "#/providers";
    await signIn();
    const free = await screen.findByRole("heading", { level: 2, name: t("providers.section.free") });
    expect(free.closest("section")!.textContent).toContain(t("providers.section.freeHint"));
    expect(within(free.closest("section")!).getByRole("link", { name: /Groq/ })).toBeTruthy();
    const order = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent)
      .filter((h) => [t("providers.section.oauth"), t("providers.section.free"), t("providers.section.api_key")].includes(h ?? ""));
    expect(order).toEqual([t("providers.section.oauth"), t("providers.section.free"), t("providers.section.api_key")]);
  });

  it("Codex has custom headers, saved as a map; a refused value shows the gateway's reason", async () => {
    routes["GET /admin/connections"] = () => json([account({ id: "o1", provider: "codex", auth_type: "oauth", name: "dev@example.com", hint: null })]);
    routes["GET /admin/providers/codex/headers"] = () => json({ headers: { "x-team": "core" } });
    let refuse = true;
    routes["PUT /admin/providers/codex/headers"] = (body) =>
      refuse ? json({ error: "invalid_request", message: "header name x bad is not allowed" }, 400) : json(body);
    window.location.hash = "#/providers/codex";
    await signIn();
    const card = (await screen.findByRole("heading", { name: t("providers.headers") })).closest("section, article, div.x-card") ?? document.body;
    expect(((await screen.findByLabelText(t("providers.headerName"))) as HTMLInputElement).value).toBe("x-team");
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: t("providers.headerAdd") }));
    fireEvent.change(screen.getByLabelText(`${t("providers.headerName")} 2`), { target: { value: "x bad" } });
    fireEvent.change(screen.getByLabelText(`${t("providers.headerValue")} 2`), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: t("providers.headerSave") }));
    expect(await screen.findByText("header name x bad is not allowed")).toBeTruthy();
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ headers: { "x-team": "core", "x bad": "1" } });

    refuse = false;
    fireEvent.change(screen.getByLabelText(`${t("providers.headerName")} 2`), { target: { value: "x-good" } });
    fireEvent.click(screen.getByRole("button", { name: t("providers.headerSave") }));
    expect(await screen.findByText(t("providers.headersSaved"))).toBeTruthy();
    expect(calls.filter((c) => c.method === "PUT").at(-1)!.body).toEqual({ headers: { "x-team": "core", "x-good": "1" } });
  });

  it("an API-key provider has no headers card", async () => {
    window.location.hash = "#/providers/openai";
    await signIn();
    await screen.findByText("Work");
    expect(screen.queryByRole("heading", { name: t("providers.headers") })).toBeNull();
  });

  it("a Codex account's proxy pool is changed from its row", async () => {
    routes["GET /admin/connections"] = () => json([account({ id: "o1", provider: "codex", auth_type: "oauth", name: "dev@example.com", hint: null })]);
    routes["GET /admin/proxy-pools"] = () => json([{ id: "p1", name: "Home relays" }]);
    routes["PATCH /admin/connections/o1"] = () => json(account({ id: "o1", provider: "codex", proxy_pool: "p1" }));
    window.location.hash = "#/providers/codex";
    await signIn();
    fireEvent.change(await screen.findByLabelText(t("providers.poolFor", { name: "dev@example.com" })), { target: { value: "p1" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/admin/connections/o1", body: { proxy_pool: "p1" } }));
    fireEvent.change(screen.getByLabelText(t("providers.poolFor", { name: "dev@example.com" })), { target: { value: "" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({ proxy_pool: null }));
  });
});

describe("settings", () => {
  const INFO = { admin_token: true, oidc: false, console_emails: 2, connections_key: true, codex_relay: false };
  const REDIRECT = "https://router.test/auth/callback";
  const SSO_ENV = { source: "env", issuer: "https://id.test/api/auth", client_id: "router", secret_set: true, redirect_uri: REDIRECT };
  const SSO_NONE = { source: "none", issuer: "", client_id: "", secret_set: false, redirect_uri: REDIRECT };

  beforeEach(() => {
    routes["GET /admin/settings/info"] = () => json(INFO);
    routes["GET /admin/combo-settings"] = () => json({ strategy: "fallback", sticky_limit: 3 });
    routes["GET /admin/timeouts"] = () => json({ first_byte_s: 300, idle_s: 300 });
    routes["GET /admin/sso"] = () => json(SSO_ENV);
    routes["GET /admin/mcp-tokens"] = () => json([]);
  });

  async function openSettings() {
    window.location.hash = "#/settings";
    await signIn();
    await screen.findByText(t("prefs.adminToken"));
  }

  it("says only whether each secret is set", async () => {
    await openSettings();
    await screen.findByText(t("prefs.emailsCount", { n: "2" }));
    expect(screen.getAllByText(t("prefs.set"))).toHaveLength(2);
    expect(screen.getAllByText(t("prefs.notSet"))).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/\btrue\b|\bfalse\b/);
    expect(screen.getByText(t("prefs.signInHint"))).toBeTruthy();
  });

  it("saves the combo strategy, and the sticky limit for round robin within 1 to 1000", async () => {
    routes["PUT /admin/combo-settings"] = (body) => json({ strategy: "round-robin", sticky_limit: 3, ...(body as object) });
    await openSettings();
    fireEvent.change(await screen.findByLabelText(t("prefs.strategy")), { target: { value: "round-robin" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ strategy: "round-robin" }));
    const sticky = await screen.findByLabelText(t("prefs.sticky"));
    fireEvent.change(sticky, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    expect(await screen.findByText(t("prefs.stickyBad"))).toBeTruthy();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    fireEvent.change(sticky, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").at(-1)!.body).toEqual({ sticky_limit: 10 }));
  });

  it("saves each upstream timeout: 0, or 10 to 3600 seconds", async () => {
    routes["PUT /admin/timeouts"] = (body) => json({ first_byte_s: 300, idle_s: 300, ...(body as object) });
    await openSettings();
    const idle = (await screen.findByLabelText(t("prefs.timeoutIdle"))) as HTMLInputElement;
    expect(idle.value).toBe("300");
    expect(idle.getAttribute("inputmode")).toBe("numeric");
    const saveIdle = screen.getByRole("button", { name: t("prefs.saveNamed", { name: t("prefs.timeoutIdle") }) }) as HTMLButtonElement;
    expect(saveIdle.disabled).toBe(true); // nothing changed yet
    for (const v of ["5", "3601", "1.5", "abc"]) {
      fireEvent.change(idle, { target: { value: v } });
      fireEvent.click(saveIdle);
      expect(await screen.findByText(t("prefs.timeoutInvalid"))).toBeTruthy();
    }
    expect(calls.filter((c) => c.url === "/admin/timeouts" && c.method === "PUT")).toHaveLength(0);
    fireEvent.change(idle, { target: { value: "60" } });
    fireEvent.click(saveIdle);
    await waitFor(() => expect(calls.find((c) => c.url === "/admin/timeouts" && c.method === "PUT")!.body).toEqual({ idle_s: 60 }));
    await waitFor(() => expect(screen.queryByText(t("prefs.timeoutInvalid"))).toBeNull());
    fireEvent.change(screen.getByLabelText(t("prefs.timeoutFirstByte")), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: t("prefs.saveNamed", { name: t("prefs.timeoutFirstByte") }) }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/admin/timeouts" && c.method === "PUT").at(-1)!.body).toEqual({ first_byte_s: 0 }));
  });

  it("shows the field error when the gateway refuses a timeout", async () => {
    routes["PUT /admin/timeouts"] = () => json({ error: "invalid_input", hint: "first_byte_s, idle_s: 0 (off) or 10 to 3600 seconds" }, 400);
    await openSettings();
    fireEvent.change(await screen.findByLabelText(t("prefs.timeoutFirstByte")), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: t("prefs.saveNamed", { name: t("prefs.timeoutFirstByte") }) }));
    expect(await screen.findByText(t("prefs.timeoutInvalid"))).toBeTruthy();
  });

  it("imports a backup only after a confirmation that lists its tables", async () => {
    routes["POST /admin/backup"] = () => json({ ok: true, rows: 3 });
    await openSettings();
    const tables = { combo: [{ name: "a" }, { name: "b" }], price: [{ model: "m" }] };
    const file = new File([JSON.stringify({ version: 1, exported_at: 1, tables })], "ai-router-backup.json", { type: "application/json" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    const dialog = await screen.findByRole("alertdialog", { name: t("prefs.importTitle") });
    expect(within(dialog).getByText(t("prefs.importRows", { table: "combo", n: "2" }))).toBeTruthy();
    expect(within(dialog).getByText(t("prefs.importRows", { table: "price", n: "1" }))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url === "/admin/backup")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: t("prefs.importConfirm") }));
    expect(await screen.findByText(t("prefs.imported", { n: "3" }))).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.url === "/admin/backup")!.body).toEqual({ version: 1, tables });
  });

  it("a file that is not a backup is refused before anything is sent, and a refused import shows the reason", async () => {
    routes["POST /admin/backup"] = () => json({ error: "invalid_input", message: "combo row 1: name is required" }, 400);
    await openSettings();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["{\"hello\":1}"], "x.json", { type: "application/json" })] } });
    expect(await screen.findByText(t("prefs.importBad"))).toBeTruthy();

    fireEvent.change(input, { target: { files: [new File([JSON.stringify({ version: 1, tables: { combo: [{}] } })], "b.json", { type: "application/json" })] } });
    const dialog = await screen.findByRole("alertdialog", { name: t("prefs.importTitle") });
    fireEvent.click(within(dialog).getByRole("button", { name: t("prefs.importConfirm") }));
    expect(await screen.findByText(t("prefs.importFailed", { message: "combo row 1: name is required" }))).toBeTruthy();
  });

  it("a failed load offers a retry on every card that reads it", async () => {
    routes["GET /admin/settings/info"] = () => json({ error: "boom" }, 500);
    window.location.hash = "#/settings";
    await signIn();
    await screen.findByText(t("prefs.strategy"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: t("common.retry") })).toHaveLength(2));
  });

  async function openMcp() {
    window.location.hash = "#/mcp";
    await signIn();
    await screen.findByText(t("mcp.steps"));
  }

  it("MCP tokens: lists access per group, creates one with its levels and expiry, and shows it once", async () => {
    const day = Math.floor(Date.now() / 1000);
    routes["GET /admin/mcp-tokens"] = () =>
      json([{ id: "t1", name: "Laptop", hint: "Ab12", scopes: { combos: "write", models: "none", systems: "none", connections: "none", usage: "read", settings: "none" }, created_at: day, expires_at: null, last_used_at: null }]);
    routes["POST /admin/mcp-tokens"] = () => json({ id: "t2", name: "CI", hint: "Zz99", token: "xmcp_onceonly", scopes: {}, created_at: day, expires_at: day + 7 * 86400, last_used_at: null }, 201);
    await openMcp();
    expect(await screen.findByText(`${t("mcp.group.combos")}: ${t("mcp.level.write")} · ${t("mcp.group.usage")}: ${t("mcp.level.read")}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("mcp.add") }));
    const dialog = await screen.findByRole("dialog", { name: t("mcp.addTitle") });
    fireEvent.change(within(dialog).getByLabelText(t("mcp.name")), { target: { value: "CI" } });
    fireEvent.change(within(dialog).getByLabelText(t("mcp.expiry")), { target: { value: "7" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("mcp.presetNone") }));
    fireEvent.change(within(dialog).getByLabelText(t("mcp.group.combos")), { target: { value: "read" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("mcp.create") }));
    await screen.findByRole("dialog", { name: t("mcp.shownTitle", { name: "CI" }) });
    expect(calls.find((c) => c.method === "POST" && c.url === "/admin/mcp-tokens")!.body).toEqual({
      name: "CI",
      expires_days: 7,
      scopes: { combos: "read", models: "none", systems: "none", connections: "none", usage: "none", settings: "none" },
    });
    expect(screen.getAllByText(/xmcp_onceonly/).length).toBeGreaterThan(0);
  });

  it("MCP tokens: revoke asks first, then deletes", async () => {
    routes["GET /admin/mcp-tokens"] = () =>
      json([{ id: "t1", name: "Laptop", hint: "Ab12", scopes: { combos: "read", models: "none", systems: "none", connections: "none", usage: "none", settings: "none" }, created_at: 1, expires_at: null, last_used_at: null }]);
    routes["DELETE /admin/mcp-tokens/t1"] = () => new Response(null, { status: 204 });
    await openMcp();
    fireEvent.click(await screen.findByRole("button", { name: `${t("mcp.col.actions")}: Laptop` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("mcp.revoke") }));
    const dialog = await screen.findByRole("alertdialog", { name: t("mcp.revokeTitle", { name: "Laptop" }) });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: t("mcp.revoke") }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/admin/mcp-tokens/t1")).toBe(true));
  });

  it("the sticky limit Save stays disabled until the value changed", async () => {
    routes["GET /admin/combo-settings"] = () => json({ strategy: "round-robin", sticky_limit: 3 });
    await openSettings();
    const sticky = await screen.findByLabelText(t("prefs.sticky"));
    const save = screen.getByRole("button", { name: t("common.save") }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(sticky, { target: { value: "4" } });
    expect(save.disabled).toBe(false);
    fireEvent.change(sticky, { target: { value: "3" } });
    expect(save.disabled).toBe(true);
  });

  it("the import confirm is a danger alert and its failure shows inside it", async () => {
    routes["POST /admin/backup"] = () => json({ error: "boom" }, 500);
    await openSettings();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([JSON.stringify({ version: 1, tables: { combo: [] } })], "b.json", { type: "application/json" })] } });
    const dialog = await screen.findByRole("alertdialog", { name: t("prefs.importTitle") });
    fireEvent.click(within(dialog).getByRole("button", { name: t("prefs.importConfirm") }));
    expect(await within(dialog).findByText(t("error.generic"))).toBeTruthy();
  });

  it("readBackup takes only version 1 files with known tables", () => {
    expect(readBackup("nope")).toBeNull();
    expect(readBackup(JSON.stringify({ version: 2, tables: { combo: [] } }))).toBeNull();
    expect(readBackup(JSON.stringify({ version: 1, tables: { connection: [] } }))).toBeNull();
    expect(readBackup(JSON.stringify({ version: 1, tables: { combo: {} } }))).toBeNull();
    expect(readBackup(JSON.stringify({ version: 1, tables: { combo: [], setting: [] } }))).toEqual({ combo: [], setting: [] });
  });

  describe("xDev ID sign-in card", () => {
    it("checks fields the way the gateway does", () => {
      const ok = { issuer: "https://id.test/api/auth", client_id: "router", secret: "" };
      expect(validateSso(ok, true)).toEqual({});
      expect(validateSso(ok, false)).toEqual({ secret: "prefs.ssoSecretNeeded" });
      for (const issuer of ["http://id.test", "https://id.test/?a=1", "https://id.test/#x", "https://u:p@id.test", "id.test", `https://id.test/${"x".repeat(500)}`]) {
        expect(validateSso({ ...ok, issuer }, true), issuer.slice(0, 40)).toEqual({ issuer: "prefs.ssoIssuerBad" });
      }
      expect(validateSso({ ...ok, client_id: "  " }, true)).toEqual({ client_id: "prefs.ssoClientBad" });
      expect(validateSso({ ...ok, client_id: "x".repeat(201) }, true)).toEqual({ client_id: "prefs.ssoClientBad" });
      expect(validateSso({ ...ok, secret: "x".repeat(4097) }, true)).toEqual({ secret: "prefs.ssoSecretLong" });
    });

    it("shows where sign-in comes from and the redirect URI to paste into xDev ID, never a secret", async () => {
      await openSettings();
      expect(await screen.findByText(t("prefs.ssoOnEnv"))).toBeTruthy();
      expect(screen.getByText(REDIRECT)).toBeTruthy();
      expect((screen.getByLabelText(t("prefs.ssoIssuer")) as HTMLInputElement).value).toBe(SSO_ENV.issuer);
      expect((screen.getByLabelText(t("prefs.ssoClient")) as HTMLInputElement).value).toBe("router");
      const secret = screen.getByLabelText(t("prefs.ssoSecret")) as HTMLInputElement;
      expect(secret.type).toBe("password");
      expect(secret.value).toBe("");
      expect(secret.placeholder).toBe(t("prefs.ssoSecretKept"));
      expect(screen.queryByRole("button", { name: t("prefs.ssoUseEnv") })).toBeNull();
    });

    it("Save waits for a change, then sends the secret only when one was typed", async () => {
      routes["PUT /admin/sso"] = (body) => json({ ...SSO_ENV, ...(body as object), source: "settings", secret_set: true });
      await openSettings();
      const save = (await screen.findByRole("button", { name: t("prefs.saveNamed", { name: t("prefs.sso") }) })) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText(t("prefs.ssoClient")), { target: { value: "router-2" } });
      expect(save.disabled).toBe(false);
      fireEvent.click(save);
      await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url === "/admin/sso")!.body).toEqual({ issuer: SSO_ENV.issuer, client_id: "router-2" }));
      expect(await screen.findByText(t("prefs.ssoOnSettings"))).toBeTruthy();

      fireEvent.change(screen.getByLabelText(t("prefs.ssoSecret")), { target: { value: "typed-secret" } });
      fireEvent.click(save);
      await waitFor(() => expect(calls.filter((c) => c.url === "/admin/sso" && c.method === "PUT").at(-1)!.body).toEqual({ issuer: SSO_ENV.issuer, client_id: "router-2", secret: "typed-secret" }));
      await waitFor(() => expect((screen.getByLabelText(t("prefs.ssoSecret")) as HTMLInputElement).value).toBe(""));
    });

    it("checks the fields before sending anything", async () => {
      routes["GET /admin/sso"] = () => json(SSO_NONE);
      await openSettings();
      expect(await screen.findByText(t("prefs.ssoOff"))).toBeTruthy();
      fireEvent.change(screen.getByLabelText(t("prefs.ssoIssuer")), { target: { value: "http://id.test" } });
      fireEvent.click(screen.getByRole("button", { name: t("prefs.saveNamed", { name: t("prefs.sso") }) }));
      expect(await screen.findByText(t("prefs.ssoIssuerBad"))).toBeTruthy();
      expect(screen.getByText(t("prefs.ssoClientBad"))).toBeTruthy();
      expect(screen.getByText(t("prefs.ssoSecretNeeded"))).toBeTruthy();
      expect(calls.some((c) => c.url === "/admin/sso" && c.method === "PUT")).toBe(false);
    });

    it("says when the gateway cannot store a secret", async () => {
      routes["PUT /admin/sso"] = () => json({ error: "not_configured", hint: "set the CONNECTIONS_KEY secret" }, 409);
      await openSettings();
      fireEvent.change(await screen.findByLabelText(t("prefs.ssoSecret")), { target: { value: "typed-secret" } });
      fireEvent.click(screen.getByRole("button", { name: t("prefs.saveNamed", { name: t("prefs.sso") }) }));
      expect(await screen.findByText(t("prefs.ssoNoKey"))).toBeTruthy();
      expect((screen.getByLabelText(t("prefs.ssoSecret")) as HTMLInputElement).value).toBe("typed-secret");
    });

    it("goes back to the environment only after a confirmation", async () => {
      routes["GET /admin/sso"] = () => json({ ...SSO_ENV, source: "settings" });
      routes["DELETE /admin/sso"] = () => json(SSO_ENV);
      await openSettings();
      fireEvent.click(await screen.findByRole("button", { name: t("prefs.ssoUseEnv") }));
      const dialog = await screen.findByRole("alertdialog", { name: t("prefs.ssoUseEnvTitle") });
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
      fireEvent.click(within(dialog).getByRole("button", { name: t("prefs.ssoUseEnv") }));
      await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/admin/sso")).toBe(true));
      expect(await screen.findByText(t("prefs.ssoOnEnv"))).toBeTruthy();
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });
});
