import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, pageFromHash } from "../App";
import { setToken } from "../api";
import { resetLang, t } from "../i18n";
import { parseCap } from "../pages/Systems";
import { lastMonths } from "../pages/Usage";

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
const USAGE = {
  month: "2026-11",
  rows: [
    { system_id: "chat", provider: "anthropic", model: "claude-opus-5-5", requests: 3, input_tokens: 400, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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
    routes["GET /admin/usage"] = () => json({ error: "unauthorized" }, 401);
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

describe("usage", () => {
  it("shows totals and one row per system and model", async () => {
    window.location.hash = "#/usage";
    await signIn();
    expect(await screen.findByRole("heading", { name: t("usage.title") })).toBeTruthy();
    expect(await screen.findByText("claude-opus-5-5")).toBeTruthy();
    expect(calls.some((c) => /\/admin\/usage\?month=\d{4}-\d{2}$/.test(c.url))).toBe(true);
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

  it("lastMonths: 12 UTC months, newest first, across a year edge", () => {
    const m = lastMonths(new Date(Date.UTC(2026, 0, 15)));
    expect(m).toHaveLength(12);
    expect(m[0]).toBe("2026-01");
    expect(m[1]).toBe("2025-12");
    expect(m[11]).toBe("2025-02");
  });

  it("pageFromHash: usage or systems", () => {
    expect(pageFromHash("#/usage")).toBe("usage");
    expect(pageFromHash("")).toBe("systems");
    expect(pageFromHash("#/nope")).toBe("systems");
  });
});
