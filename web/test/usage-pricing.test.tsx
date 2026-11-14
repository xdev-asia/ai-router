import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth, type PriceRow, type UsageBucket } from "../api";
import { resetLang, t } from "../i18n";
import { PRICE_TARGET, Pricing, filterPrices, formatPrice } from "../pages/Pricing";
import { Usage, allTokens, bucketValue, chartTicks } from "../pages/Usage";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Made-up values: no real key ever goes in a test. The API sends an account's name and hint, never its key. */
const TOKENS = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const SUMMARY = {
  period: "24h",
  from: 1_790_000_000,
  totals: { requests: 4, input_tokens: 500, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost: 1.5, unpriced_requests: 0 },
  by_provider: [{ provider: "openai", ...TOKENS, requests: 4, input_tokens: 500, output_tokens: 50, cost: 1.5, last_at: 1_790_000_500 }],
  by_model: [{ provider: "openai", model: "gpt-5", ...TOKENS, requests: 4, input_tokens: 500, output_tokens: 50, cost: 1.5, last_at: 1_790_000_500 }],
  by_connection: [
    { connection_id: "c1", provider: "openai", name: "Work", hint: "…a1b2", ...TOKENS, requests: 3, input_tokens: 300, cost: 1, last_at: 1_790_000_500 },
    { connection_id: null, provider: "openai", name: null, hint: null, ...TOKENS, requests: 1, input_tokens: 200, cost: 0.5, last_at: 1_790_000_400 },
  ],
  by_system: [{ system_id: "chat", name: "Chat app", ...TOKENS, requests: 4, input_tokens: 500, output_tokens: 50, cost: 1.5, last_at: 1_790_000_500 }],
  recent: [],
};
const CHART = {
  period: "24h",
  step: 3600,
  buckets: [
    { t: 1_789_992_800, requests: 1, tokens: 100, cost: 0.25 },
    { t: 1_789_996_400, requests: 0, tokens: 0, cost: 0 },
    { t: 1_790_000_000, requests: 3, tokens: 450, cost: null },
  ],
};

let calls: { method: string; url: string; body: unknown }[];
let routes: Record<string, (body?: unknown) => Response>;

beforeEach(() => {
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  window.location.hash = "";
  calls = [];
  routes = {
    "GET /admin/usage/summary": () => json(SUMMARY),
    "GET /admin/usage/chart": () => json(CHART),
    "GET /admin/connections": () => json([]),
    "GET /admin/providers": () => json([{ id: "openai", name: "OpenAI", format: "openai", auth: ["api_key"], env_key: false, key_url: null, strategy: "fill-first" }]),
  };
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

describe("usage chart helpers", () => {
  const b = (t: number, requests: number, tokens: number, cost: number | null): UsageBucket => ({ t, requests, tokens, cost });

  it("reads a bucket by measure; a bucket with requests and no price is a gap, not zero", () => {
    expect(bucketValue(b(0, 2, 30, 0.1), "tokens")).toBe(30);
    expect(bucketValue(b(0, 2, 30, 0.1), "requests")).toBe(2);
    expect(bucketValue(b(0, 2, 30, null), "cost")).toBeNull();
  });

  it("labels about six points along the axis", () => {
    const buckets = Array.from({ length: 24 }, (_, i) => b(1_790_000_000 + i * 3600, 0, 0, 0));
    const ticks = chartTicks(buckets, 3600, "en");
    expect(ticks.map((x) => x.index)).toEqual([0, 4, 8, 12, 16, 20]);
    expect(chartTicks(buckets.slice(0, 3), 86_400, "en").map((x) => x.index)).toEqual([0, 1, 2]);
  });

  it("counts every token kind", () => {
    expect(allTokens({ ...TOKENS, requests: 1, input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, cost: null })).toBe(10);
  });
});

describe("usage overview", () => {
  it("draws the period over time and switches between tokens, requests and cost", async () => {
    render(<Usage />);
    const chart = await screen.findByRole("figure", { name: t("usage.chart.perHour", { metric: t("usage.metric.tokens") }) });
    expect(calls.some((c) => /^\/admin\/usage\/chart\?period=24h&tz=-?\d+$/.test(c.url))).toBe(true);
    expect(within(chart).getAllByText(/: 450$/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: t("usage.metric.cost") }));
    const cost = await screen.findByRole("figure", { name: t("usage.chart.perHour", { metric: t("usage.metric.cost") }) });
    // The hour with no price says so instead of drawing $0.
    expect(within(cost).getAllByText(new RegExp(`: ${t("usage.chart.noPrice")}$`)).length).toBeGreaterThan(0);
    expect(within(cost).getAllByText(/: ~\$0\.25$/).length).toBeGreaterThan(0);
  });

  it("ranks providers and models in bar charts", async () => {
    render(<Usage />);
    const byProvider = await screen.findByRole("figure", { name: t("usage.bars.byProvider", { metric: t("usage.metric.tokens") }) });
    expect(within(byProvider).getByText("OpenAI")).toBeTruthy();
    expect(within(byProvider).getByText("550")).toBeTruthy();
    const models = screen.getByRole("figure", { name: t("usage.bars.topModels", { metric: t("usage.metric.tokens") }) });
    expect(within(models).getByText("gpt-5")).toBeTruthy();
  });

  it("breaks usage down by account and by API key, by name and hint only", async () => {
    render(<Usage />);
    await screen.findByRole("table", { name: t("usage.breakdown.caption", { group: t("usage.breakdown.model") }) });
    fireEvent.click(screen.getByRole("button", { name: t("usage.breakdown.account") }));
    const accounts = screen.getByRole("table", { name: t("usage.breakdown.caption", { group: t("usage.breakdown.account") }) });
    expect(within(accounts).getByText("Work · …a1b2")).toBeTruthy();
    expect(within(accounts).getByText(t("usage.noAccount"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("usage.breakdown.key") }));
    const keys = screen.getByRole("table", { name: t("usage.breakdown.caption", { group: t("usage.breakdown.key") }) });
    expect(within(keys).getByText("Chat app")).toBeTruthy();
  });

  it("sends the owner's offset for today only", async () => {
    render(<Usage />);
    await screen.findByRole("figure", { name: t("usage.chart.perHour", { metric: t("usage.metric.tokens") }) });
    expect(calls.some((c) => c.url === "/admin/usage/summary?period=24h")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: t("usage.period.today") }));
    await waitFor(() => expect(calls.some((c) => /^\/admin\/usage\/summary\?period=today&tz=-?\d+$/.test(c.url))).toBe(true));
  });

  it("says when the period has no requests", async () => {
    routes["GET /admin/usage/chart"] = () => json({ ...CHART, buckets: CHART.buckets.map((x) => ({ ...x, requests: 0, tokens: 0, cost: 0 })) });
    render(<Usage />);
    await waitFor(() => expect(screen.getAllByText(t("usage.noRequests")).length).toBeGreaterThan(0));
    expect(screen.queryByRole("figure", { name: t("usage.chart.perHour", { metric: t("usage.metric.tokens") }) })).toBeNull();
  });
});

describe("pricing helpers", () => {
  const row = (target: string): PriceRow => ({ target, input: 1, output: 2, cache_read: 0, cache_write: 0, custom: false, default: null });

  it("formats prices and filters by text and provider", () => {
    expect(formatPrice(1.25)).toBe("$1.25");
    expect(formatPrice(0.075)).toBe("$0.075");
    expect(formatPrice(0.000012345)).toBe("$0");
    const rows = [row("openai/gpt-5"), row("anthropic/claude-opus-5-5"), row("openai/gpt-5-mini")];
    expect(filterPrices(rows, "MINI", "").map((r) => r.target)).toEqual(["openai/gpt-5-mini"]);
    expect(filterPrices(rows, "", "anthropic").map((r) => r.target)).toEqual(["anthropic/claude-opus-5-5"]);
  });

  it("accepts provider/model as the gateway does", () => {
    expect(PRICE_TARGET.test("openai/gpt-5")).toBe(true);
    expect(PRICE_TARGET.test("openrouter/meta-llama/llama-4:free")).toBe(true);
    expect(PRICE_TARGET.test("gpt-5")).toBe(false);
    expect(PRICE_TARGET.test("OpenAI/gpt-5")).toBe(false);
  });
});

describe("pricing page", () => {
  let prices: PriceRow[];
  const BUILT_IN = { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 };
  beforeEach(() => {
    prices = [
      { target: "openai/gpt-5", ...BUILT_IN, custom: false, default: BUILT_IN },
      { target: "openai/gpt-5-mini", input: 0.3, output: 2, cache_read: 0, cache_write: 0, custom: true, default: { input: 0.25, output: 2, cache_read: 0.025, cache_write: 0 } },
      { target: "groq/llama-4", input: 0.1, output: 0.2, cache_read: 0, cache_write: 0, custom: true, default: null },
    ];
    routes["GET /admin/pricing"] = () => json(prices);
    routes["PUT /admin/pricing"] = (body) => {
      const b = body as PriceRow;
      prices = prices.map((p) => (p.target === b.target ? { ...p, ...b, custom: true } : p));
      return json({ ok: true });
    };
    routes["DELETE /admin/pricing"] = () => new Response(null, { status: 204 });
  });

  it("lists every price with where it comes from", async () => {
    render(<Pricing />);
    const table = await screen.findByRole("table", { name: t("pricing.caption") });
    expect(within(table).getByText("gpt-5")).toBeTruthy();
    expect(within(table).getByText("$1.25")).toBeTruthy();
    expect(within(table).getAllByText(t("pricing.custom"))).toHaveLength(2);
    expect(within(table).getAllByText(t("pricing.builtIn"))).toHaveLength(1);
    // A built-in price has nothing to reset.
    expect(screen.queryByRole("button", { name: t("pricing.resetOne", { target: "openai/gpt-5" }) })).toBeNull();
  });

  it("filters by search and provider and counts what is shown", async () => {
    render(<Pricing />);
    await screen.findByRole("table", { name: t("pricing.caption") });
    fireEvent.change(screen.getByRole("combobox", { name: t("pricing.provider") }), { target: { value: "groq" } });
    expect(screen.getByText(t("pricing.shown", { n: "1", total: "3" }))).toBeTruthy();
    expect(screen.queryByText("gpt-5")).toBeNull();
  });

  it("edits a price and sends the four rates", async () => {
    render(<Pricing />);
    fireEvent.click(await screen.findByRole("button", { name: t("pricing.editOne", { target: "openai/gpt-5" }) }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(t("pricing.builtInIs", { input: "$1.25", output: "$10", cacheRead: "$0.125", cacheWrite: "$0" }))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(t("pricing.col.output")), { target: { value: "12.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.save") }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ target: "openai/gpt-5", input: 1.25, output: 12.5, cache_read: 0.125, cache_write: 0 });
  });

  it("refuses a model without a provider and a negative price before sending", async () => {
    render(<Pricing />);
    fireEvent.click(await screen.findByRole("button", { name: t("pricing.add") }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(t("pricing.target")), { target: { value: "gpt-5" } });
    fireEvent.change(within(dialog).getByLabelText(t("pricing.col.input")), { target: { value: "-1" } });
    fireEvent.change(within(dialog).getByLabelText(t("pricing.col.output")), { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.save") }));
    expect(await within(dialog).findByText(t("pricing.invalidTarget"))).toBeTruthy();
    expect(within(dialog).getByText(t("pricing.invalidPrice"))).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("resets a custom price to the built-in one", async () => {
    render(<Pricing />);
    fireEvent.click(await screen.findByRole("button", { name: t("pricing.resetOne", { target: "openai/gpt-5-mini" }) }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: t("pricing.reset") }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe(`/admin/pricing?target=${encodeURIComponent("openai/gpt-5-mini")}`);
  });

  it("removes a price that has no built-in one", async () => {
    render(<Pricing />);
    fireEvent.click(await screen.findByRole("button", { name: t("pricing.removeOne", { target: "groq/llama-4" }) }));
    expect(screen.getByText(t("pricing.removeBody"))).toBeTruthy();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: t("pricing.remove") }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(encodeURIComponent("groq/llama-4")))).toBe(true));
  });
});
