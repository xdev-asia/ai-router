import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, pageFromHash } from "../App";
import { setToken } from "../api";
import { resetLang, t } from "../i18n";
import { parseCap } from "../pages/Systems";
import { lastMonths } from "../pages/Usage";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SYSTEM = { id: "chat", name: "Chat", monthly_token_cap: 1000, disabled: false, created_at: 1_790_000_000 };
const USAGE = {
  month: "2026-11",
  rows: [
    { system_id: "chat", provider: "anthropic", model: "claude-opus-5-5", requests: 3, input_tokens: 400, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ],
};

let calls: { method: string; url: string; auth: string | null; body: unknown }[];
let routes: Record<string, () => Response>;

beforeEach(() => {
  localStorage.setItem("xdev-llm.lang", "en");
  resetLang();
  window.location.hash = "";
  calls = [];
  routes = {
    "GET /admin/systems": () => json([SYSTEM]),
    "GET /admin/usage": () => json(USAGE),
    "POST /admin/systems": () => json({ id: "xdevd", token: "xllm_new_token" }, 201),
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ method, url, auth, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (auth !== "Bearer good-admin-token") return json({ error: "unauthorized" }, 401);
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
    expect(calls.every((c) => c.auth === "Bearer good-admin-token" || c.auth === "Bearer bad")).toBe(true);
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
