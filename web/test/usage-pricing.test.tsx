import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth, type PriceRow, type UsageBucket } from "../api";
import { resetLang, t } from "../i18n";
import { PRICE_TARGET, Pricing, filterPrices, formatPrice } from "../pages/Pricing";
import { Usage, allTokens, bucketValue, cacheRate, chartTicks, formatAgo, formatChange, percentChange, requestQuery, routeSide, routerEnds, successRate, toCsv, type RouteEnd } from "../pages/Usage";

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

  it("reads errors from a bucket, zero when the worker sent none", () => {
    expect(bucketValue({ ...b(0, 3, 30, 0), errors: 2 }, "errors")).toBe(2);
    expect(bucketValue(b(0, 3, 30, 0), "errors")).toBe(0);
  });

  it("counts every token kind", () => {
    expect(allTokens({ ...TOKENS, requests: 1, input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, cost: null })).toBe(10);
  });
});

describe("usage figures", () => {
  const row = (over: Partial<typeof TOKENS & { requests: number; errors: number }>) => ({ ...TOKENS, requests: 0, cost: null, ...over });

  it("rates the cache over the prompt and success over requests; no rate without a base", () => {
    expect(cacheRate(row({ input_tokens: 75, cache_read_input_tokens: 25 }))).toBe(25);
    expect(cacheRate(row({ output_tokens: 10 }))).toBeNull();
    expect(successRate(row({ requests: 200, errors: 3 }))).toBe(98.5);
    expect(successRate(row({ requests: 4 }))).toBe(100);
    expect(successRate(row({}))).toBeNull();
  });

  it("compares with the period before only when there is one", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(5, null)).toBeNull();
    expect(formatChange(50)).toBe("+50%");
    expect(formatChange(-4.26)).toBe("−4.3%");
    expect(formatChange(0.01)).toBe("0%");
  });

  it("writes CSV with quoted fields where needed", () => {
    expect(toCsv([["name", "n"], ['a "b", c', 2], [null, 3]])).toBe(["name,n", '"a ""b"", c",2', ",3", ""].join(String.fromCharCode(13, 10)));
  });

  it("asks for requests with the filters in a fixed order", () => {
    const none = { provider: "", model: "", system: "", status: "" as const, from: "", to: "" };
    expect(requestQuery(none)).toBe("limit=100");
    expect(requestQuery({ ...none, provider: "openai", model: " gpt-5 ", system: "chat", status: "error" })).toBe("limit=100&provider=openai&model=gpt-5&system=chat&status=error");
  });
});

describe("router map", () => {
  const end = (id: string, requests: number, errors = 0): RouteEnd => ({ id, name: id.toUpperCase(), requests, errors });

  it("lists every system and every provider with an account, idle ones too, and keeps a gone system by its row's name", () => {
    const data = { ...SUMMARY, by_system: [...SUMMARY.by_system, { system_id: "old", name: "Old app", ...TOKENS, requests: 1, cost: null }] } as unknown as Parameters<typeof routerEnds>[0];
    const providers = [{ id: "openai", name: "OpenAI", color: "#10a37f", mark: "OA" }, { id: "groq", name: "Groq", color: "#f55036", mark: "GQ" }] as Parameters<typeof routerEnds>[1];
    const connections = [{ provider: "groq" }, { provider: "groq" }] as Parameters<typeof routerEnds>[2];
    const systems = [{ id: "chat", name: "Chat" }, { id: "batch", name: "Cursor batch" }] as Parameters<typeof routerEnds>[3];
    const { sources, nodes } = routerEnds(data, providers, connections, systems);
    expect(sources.map((s) => [s.id, s.name, s.requests])).toEqual([["chat", "Chat", 4], ["batch", "Cursor batch", 0], ["old", "Old app", 1]]);
    expect(sources.map((s) => s.src ?? null)).toEqual([null, "/cli/cursor.png", null]);
    expect(nodes.map((n) => [n.id, n.name, n.requests, n.text])).toEqual([["groq", "Groq", 0, "GQ"], ["openai", "OpenAI", 4, "OA"]]);
  });

  it("weighs each line against the busiest box and tones it by success rate", () => {
    const side = routeSide([end("b", 50, 1), end("a", 100, 10), end("c", 0)]);
    expect(side.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(side.map((n) => n.weight)).toEqual([1, 0.5, 0]);
    expect(side.map((n) => n.tone)).toEqual(["danger", "warn", undefined]);
    expect(side.map((n) => n.active)).toEqual([true, true, false]);
    expect(side[0].detail).toBe(t("usage.route.failed", { n: "100", failed: "10" }));
    expect(side[2].detail).toBe(t("usage.route.idle"));
  });

  it("folds the quietest past the limit into one box, last", () => {
    const side = routeSide([end("a", 5), end("b", 4), end("c", 3), end("d", 2), end("e", 1)], 3);
    expect(side.map((n) => n.name)).toEqual(["A", "B", t("usage.route.others", { n: "3" })]);
    expect(side[2].detail).toBe(t("usage.route.requests", { n: "6" }));
    expect(side[2].weight).toBe(1);
    expect(routeSide([end("a", 1), end("b", 1), end("c", 1)], 3)).toHaveLength(3);
  });
});

describe("usage overview", () => {
  it("draws the route from systems through the router to providers", async () => {
    routes["GET /admin/systems"] = () => json([{ id: "chat", name: "Chat app", monthly_token_cap: null }, { id: "idle", name: "Idle app", monthly_token_cap: null }]);
    render(<Usage />);
    const card = await screen.findByRole("region", { name: t("usage.route.title") });
    await within(card).findByText("Idle app");
    expect(within(card).getByText("Chat app")).toBeTruthy();
    expect(within(card).getByText("OpenAI")).toBeTruthy();
    expect(within(card).getAllByText(t("usage.route.requests", { n: "4" }))).toHaveLength(2);
    expect(within(card).getByText(t("usage.route.idle"))).toBeTruthy();
    expect(within(card).getByRole("group", { name: t("usage.route.controls") })).toBeTruthy();
  });

  it("draws the period over time and switches between tokens, requests and cost", async () => {
    render(<Usage />);
    const chart = await screen.findByRole("figure", { name: t("usage.chart.perHour", { metric: t("usage.metric.tokens") }) });
    expect(calls.some((c) => /^\/admin\/usage\/chart\?period=24h&tz=-?\d+$/.test(c.url))).toBe(true);
    expect(within(chart).getAllByText(/: 450$/).length).toBeGreaterThan(0);
    // The breakdown table has a Cost column too; the picker is the chart card's.
    fireEvent.click(within(screen.getByRole("region", { name: t("usage.chart.title") })).getByRole("button", { name: t("usage.metric.cost") }));
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

  it("compares each total with the period before, and leaves the change out without one", async () => {
    routes["GET /admin/usage/summary"] = () =>
      json({
        ...SUMMARY,
        totals: { ...SUMMARY.totals, errors: 1, latency_ms: 900 },
        previous: { ...SUMMARY.totals, requests: 2, errors: 0, latency_ms: 600 },
      });
    render(<Usage />);
    // 4 requests against 2; one failed of four; slower than before.
    expect(await screen.findByText("+100%")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("+50%")).toBeTruthy();
    expect(screen.getAllByText(t("usage.vsPrevious")).length).toBeGreaterThan(0);
    cleanup();
    routes["GET /admin/usage/summary"] = () => json({ ...SUMMARY, previous: null });
    render(<Usage />);
    await screen.findByRole("table", { name: t("usage.breakdown.caption", { group: t("usage.breakdown.model") }) });
    expect(screen.queryByText(t("usage.vsPrevious"))).toBeNull();
  });

  it("opens Details narrowed to a breakdown row; an account row has no link", async () => {
    routes["GET /admin/usage/requests"] = () => json({ rows: [] });
    routes["GET /admin/systems"] = () => json([]);
    render(<Usage />);
    await screen.findByRole("table", { name: t("usage.breakdown.caption", { group: t("usage.breakdown.model") }) });
    fireEvent.click(screen.getByRole("button", { name: t("usage.breakdown.account") }));
    expect(screen.queryByRole("button", { name: t("usage.viewRequestsFor", { name: "Work · …a1b2" }) })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("usage.breakdown.model") }));
    fireEvent.click(screen.getByRole("button", { name: t("usage.viewRequestsFor", { name: "gpt-5" }) }));
    await waitFor(() => expect(calls.some((c) => c.url === "/admin/usage/requests?limit=100&provider=openai&model=gpt-5")).toBe(true));
    expect((screen.getByLabelText(t("usage.filter.model")) as HTMLInputElement).value).toBe("gpt-5");
    fireEvent.click(screen.getByRole("button", { name: t("usage.filter.clear") }));
    await waitFor(() => expect(calls.some((c) => c.url === "/admin/usage/requests?limit=100")).toBe(true));
  });

  it("pages through requests with the last row's id, and filters by outcome", async () => {
    const req = (id: number) => ({ id, at: 1_790_000_000 + id, provider: "openai", model: "gpt-5", system_id: "chat", status: 200, ...TOKENS, latency_ms: 100 });
    routes["GET /admin/systems"] = () => json([]);
    routes["GET /admin/usage/requests"] = () => {
      const url = calls[calls.length - 1].url;
      return json({ rows: url.includes("before=") ? [req(1)] : Array.from({ length: 100 }, (_, i) => req(200 - i)) });
    };
    render(<Usage />);
    fireEvent.click(screen.getByRole("tab", { name: t("usage.tab.details") }));
    expect(await screen.findByText(t("usage.shown", { n: "100" }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("usage.loadMore") }));
    expect(await screen.findByText(t("usage.shown", { n: "101" }))).toBeTruthy();
    expect(calls.some((c) => c.url === "/admin/usage/requests?limit=100&before=101")).toBe(true);
    // A short page is the last one.
    expect(screen.queryByRole("button", { name: t("usage.loadMore") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("usage.filter.statusError") }));
    await waitFor(() => expect(calls.some((c) => c.url === "/admin/usage/requests?limit=100&status=error")).toBe(true));
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

describe("formatAgo", () => {
  it("says how long ago a request was, in the owner's language, rounding down", () => {
    const now = 1_800_000_000;
    expect(formatAgo(now - 20, "en", now)).toBe("now");
    expect(formatAgo(now - 3 * 60 - 59, "en", now)).toBe("3 min. ago");
    expect(formatAgo(now - 2 * 3600, "en", now)).toBe("2 hr. ago");
    expect(formatAgo(now - 3 * 86_400, "en", now)).toBe("3 days ago");
    expect(formatAgo(now + 30, "en", now)).toBe("now"); // a clock a little ahead never reads as the future
    expect(formatAgo(now - 5 * 60, "vi", now)).toMatch(/5 phút trước/);
  });
});
