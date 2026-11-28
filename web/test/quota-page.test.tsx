import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { Quota } from "../pages/Quota";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: string[];
let routes: Record<string, () => Response>;

const provider = (id: string, name: string) => ({ id, name, format: "openai", auth: ["api_key"], env_key: false, key_url: null, strategy: "fill-first", color: "#333333", mark: name.slice(0, 2) });
const conn = (id: string, providerId: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  provider: providerId,
  auth_type: "api_key",
  name,
  hint: "0042",
  account: null,
  expires_at: null,
  priority: 1,
  disabled: false,
  cooldown_until: 0,
  last_error: null,
  last_error_at: null,
  last_used_at: null,
  created_at: 1,
  updated_at: 1,
  ...extra,
});
const now = () => Math.floor(Date.now() / 1000);
const report = (extra: Record<string, unknown>) => ({ plan: null, tier: null, seat: null, windows: [], limit_reached: false, reset_credits: null, scope: null, checked_at: now(), message: null, error: null, ...extra });

beforeEach(() => {
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  calls = [];
  routes = {
    "GET /admin/providers": () => json([provider("codex", "OpenAI Codex"), provider("groq", "Groq"), provider("openrouter", "OpenRouter"), provider("kimchi", "Kimchi")]),
    "GET /admin/quota": () =>
      json({
        providers: ["codex", "groq", "openrouter"],
        connections: [conn("c1", "codex", "dev@example.com", { auth_type: "oauth", hint: null }), conn("g1", "groq", "groq one"), conn("g2", "groq", "groq two"), conn("o1", "openrouter", "router one")],
        hidden: {},
        others: [{ provider: "kimchi", accounts: 6 }],
      }),
    "GET /admin/quota/c1": () =>
      json(report({ plan: "plus", tier: "paid", windows: [{ name: "session", kind: "percent", used: 4, total: 100, remaining_percent: 96, reset_at: now() + 3 * 3600, period_seconds: 18000 }] })),
    "GET /admin/quota/g1": () =>
      json(report({ scope: "openai/gpt-oss-20b", checked_at: now() - 900, windows: [{ name: "Requests", kind: "count", used: 250, total: 1000, remaining_percent: 75, reset_at: now() + 600, period_seconds: 86400 }] })),
    "GET /admin/quota/g2": () => json(report({ scope: "openai/gpt-oss-20b", windows: [{ name: "Requests", kind: "count", used: 1000, total: 1000, remaining_percent: 0, reset_at: now() + 600, period_seconds: 86400 }], limit_reached: true })),
    "GET /admin/quota/o1": () => json(report({ plan: "Free", tier: "free", windows: [{ name: "free_requests", kind: "count", used: 12, total: 50, remaining_percent: 76, reset_at: null, period_seconds: 86400 }] })),
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(`${init.method ?? "GET"} ${url}`);
    const route = routes[`${init.method ?? "GET"} ${url.split("?")[0]}`];
    return route ? route() : json({ error: "not_found" }, 404);
  });
});

afterEach(() => {
  cleanup();
  act(() => setAuth(null));
  vi.unstubAllGlobals();
});

describe("quota page", () => {
  it("groups the accounts by provider, with each one's plan, usage, cycle and reset time", async () => {
    render(<Quota />);
    const codex = (await screen.findByRole("heading", { name: /OpenAI Codex/ })).closest("section")!;
    await within(codex).findByText("Plus");
    expect(within(codex).getByRole("meter", { name: "Session" }).getAttribute("aria-valuetext")).toBe("4% used");
    expect(within(codex).getByText("Every 5 hours")).toBeTruthy();
    expect(within(codex).getByText(/^Resets in (2h 59m|3h 0m)$/)).toBeTruthy();

    // Groq reports no plan and reads its limits for one model: said once, on the card.
    const groq = screen.getByRole("heading", { name: /Groq/ }).closest("section")!;
    await within(groq).findByText("250 / 1,000 used · Daily");
    expect(within(groq).getByText("2 account(s) · 2 on · Plan not reported · Limits of openai/gpt-oss-20b")).toBeTruthy();
    expect(within(groq).getAllByText(/Plan not reported/)).toHaveLength(1);
    expect(within(groq).getByText("Checked 15 min ago")).toBeTruthy();
    expect(within(groq).getByText(t("quota.state.limit"))).toBeTruthy();

    const router = screen.getByRole("heading", { name: /OpenRouter/ }).closest("section")!;
    await within(router).findByText("Free");
    expect(within(router).getByRole("meter", { name: "Free-model requests" }).getAttribute("aria-valuetext")).toBe("24% used");
    expect(within(router).getByText("12 / 50 used · Daily")).toBeTruthy();

    // The totals above, and the providers that report nothing below.
    expect(screen.getByText("4 on · 0 off")).toBeTruthy();
    expect(screen.getByText("Not shown, because these providers report neither a plan nor a quota: Kimchi (6).")).toBeTruthy();
  });

  it("asks the provider only on a refresh: loading the page uses what the gateway kept", async () => {
    render(<Quota />);
    await screen.findByText("250 / 1,000 used · Daily");
    expect(calls.filter((c) => c.includes("/admin/quota/")).every((c) => !c.includes("refresh"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: t("quota.refreshOne", { name: "groq one" }) }));
    await waitFor(() => expect(calls).toContain("GET /admin/quota/g1?refresh=1"));
    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: t("quota.refreshAll") }));
    await waitFor(() => expect(calls.filter((c) => c.endsWith("?refresh=1")).sort()).toEqual(["GET /admin/quota/c1?refresh=1", "GET /admin/quota/g1?refresh=1", "GET /admin/quota/g2?refresh=1", "GET /admin/quota/o1?refresh=1"]));
  });
});
