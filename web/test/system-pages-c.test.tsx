import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { parseBulkKeys } from "../pages/Providers";
import { readBackup } from "../pages/Settings";

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

  beforeEach(() => {
    routes["GET /admin/settings/info"] = () => json(INFO);
    routes["GET /admin/combo-settings"] = () => json({ strategy: "fallback", sticky_limit: 3 });
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
    expect(screen.getAllByText(t("prefs.notSet"))).toHaveLength(2);
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

  it("imports a backup only after a confirmation that lists its tables", async () => {
    routes["POST /admin/backup"] = () => json({ ok: true, rows: 3 });
    await openSettings();
    const tables = { combo: [{ name: "a" }, { name: "b" }], price: [{ model: "m" }] };
    const file = new File([JSON.stringify({ version: 1, exported_at: 1, tables })], "ai-router-backup.json", { type: "application/json" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    const dialog = await screen.findByRole("dialog", { name: t("prefs.importTitle") });
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
    const dialog = await screen.findByRole("dialog", { name: t("prefs.importTitle") });
    fireEvent.click(within(dialog).getByRole("button", { name: t("prefs.importConfirm") }));
    expect(await screen.findByText(t("prefs.importFailed", { message: "combo row 1: name is required" }))).toBeTruthy();
  });

  it("readBackup takes only version 1 files with known tables", () => {
    expect(readBackup("nope")).toBeNull();
    expect(readBackup(JSON.stringify({ version: 2, tables: { combo: [] } }))).toBeNull();
    expect(readBackup(JSON.stringify({ version: 1, tables: { connection: [] } }))).toBeNull();
    expect(readBackup(JSON.stringify({ version: 1, tables: { combo: {} } }))).toBeNull();
    expect(readBackup(JSON.stringify({ version: 1, tables: { combo: [], setting: [] } }))).toEqual({ combo: [], setting: [] });
  });
});
