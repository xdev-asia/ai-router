import { beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "../api";
import { resetLang } from "../i18n";
import {
  accountState,
  arrange,
  availableToTurnOn,
  cycleLabel,
  emptyToTurnOff,
  meterText,
  groupByProvider,
  groupFacts,
  leastLeft,
  nextReset,
  planLabel,
  quotaTone,
  resetIn,
  summarize,
  usedPercent,
  windowLabel,
  windowValue,
  type QuotaReport,
  type QuotaWindow,
} from "../pages/Quota";

const win = (name: string, remaining: number, reset_at: number | null = null, extra: Partial<QuotaWindow> = {}): QuotaWindow => ({
  name,
  kind: "percent",
  used: 100 - remaining,
  total: 100,
  remaining_percent: remaining,
  reset_at,
  period_seconds: null,
  ...extra,
});
const rep = (windows: QuotaWindow[], extra: Partial<QuotaReport> = {}): QuotaReport => ({
  plan: "plus",
  tier: "paid",
  windows,
  limit_reached: false,
  reset_credits: null,
  scope: null,
  checked_at: 1000,
  message: null,
  error: null,
  ...extra,
});
const conn = (id: string, provider: string, priority: number, disabled = false): Connection => ({
  id,
  provider,
  auth_type: "oauth",
  name: id,
  hint: null,
  account: null,
  expires_at: null,
  priority,
  disabled,
  cooldown_until: 0,
  last_error: null,
  last_error_at: null,
  last_used_at: null,
  created_at: 1,
  updated_at: 1,
});

beforeEach(() => resetLang());

describe("quotaTone", () => {
  it("is green above 70% left, yellow from 30 to 70, red below 30", () => {
    expect(quotaTone(71)).toBe("ok");
    expect(quotaTone(70)).toBe("warn");
    expect(quotaTone(30)).toBe("warn");
    expect(quotaTone(29.9)).toBe("danger");
  });
});

describe("leastLeft and nextReset", () => {
  it("take the tightest window and the soonest reset; null when the report has none", () => {
    const r = rep([win("session", 80, 500), win("weekly", 40, 300), win("review_session", 90, null)]);
    expect(leastLeft(r)).toBe(40);
    expect(nextReset(r)).toBe(300);
    expect(leastLeft(rep([]))).toBeNull();
    expect(nextReset(rep([win("session", 50)]))).toBeNull();
    expect(leastLeft(undefined)).toBeNull();
  });

  it("does not count a failed report as known", () => {
    expect(leastLeft(rep([win("session", 3)], { error: { status: 401, message: "x" } }))).toBeNull();
  });
});

describe("windowLabel and windowValue", () => {
  it("names the windows it knows and keeps any other name as it came", () => {
    expect(windowLabel("session")).toBe("Session");
    expect(windowLabel("weekly")).toBe("Weekly");
    expect(windowLabel("review_weekly")).toBe("Code review · Weekly");
    expect(windowLabel("spark_session")).toBe("Spark · Session");
    expect(windowLabel("Requests")).toBe("Requests");
    expect(windowLabel("free_requests")).toBe("Free-model requests");
    expect(windowLabel("key_limit")).toBe("Key spending limit");
    expect(windowLabel("credits")).toBe("Credits");
    expect(windowLabel("premium_interactions")).toBe("Premium requests");
    expect(windowLabel("Balance (USD)")).toBe("Balance (USD)");
  });

  it("says what is used in the window's own unit; a balance says what is left", () => {
    expect(windowValue(win("session", 62.5))).toBe("38% used");
    expect(windowValue(win("Tokens", 25, null, { kind: "count", used: 4500, total: 6000 }))).toBe("4,500 / 6,000 used");
    expect(windowValue(win("key_limit", 25, null, { kind: "spend", used: 15, total: 20, currency: "USD" }))).toBe("$15.00 / $20.00 used");
    expect(windowValue(win("Balance (USD)", 100, null, { kind: "balance", total: 12.5, currency: "USD" }))).toBe("$12.50 left");
    expect(windowValue(win("Balance (CNY)", 100, null, { kind: "balance", total: 12.5, currency: "CNY" }))).toBe("12.50 CNY left");
  });

  it("after the bar: the percent used, never a rounded-away first use", () => {
    expect(meterText(win("session", 62.5))).toBe("38% used");
    expect(meterText(win("Requests", 99.9, null, { kind: "count", used: 1, total: 1000 }))).toBe("<1% used");
    expect(meterText(win("Requests", 100, null, { kind: "count", used: 0, total: 1000 }))).toBe("0% used");
    expect(meterText(win("key_limit", 25, null, { kind: "spend", used: 15, total: 20, currency: "USD" }))).toBe("75% used");
    expect(meterText(win("credits", 75, null, { kind: "balance", total: 37.5, currency: "USD" }))).toBe("$37.50 left");
  });

  it("the bar shows the share used", () => {
    expect(usedPercent(win("session", 96))).toBe(4);
    expect(usedPercent(win("Requests", 99.9, null, { kind: "count", used: 1, total: 1000 }))).toBeCloseTo(0.1);
    expect(usedPercent(win("credits", 0, null, { kind: "balance", total: 0 }))).toBe(100);
  });
});

describe("cycleLabel", () => {
  it("says how often a limit starts again", () => {
    expect(cycleLabel(60)).toBe("Every minute");
    expect(cycleLabel(600)).toBe("Every 10 minutes");
    expect(cycleLabel(3600)).toBe("Every hour");
    expect(cycleLabel(18000)).toBe("Every 5 hours");
    expect(cycleLabel(86400)).toBe("Daily");
    expect(cycleLabel(259200)).toBe("Every 3 days");
    expect(cycleLabel(604800)).toBe("Weekly");
    for (const d of [28, 29, 30, 31]) expect(cycleLabel(d * 86400)).toBe("Monthly");
    expect(cycleLabel(null)).toBeNull();
    expect(cycleLabel(0)).toBeNull();
  });
});

describe("planLabel", () => {
  it("writes the provider's plan name as a label", () => {
    expect(planLabel("plus")).toBe("Plus");
    expect(planLabel("free")).toBe("Free");
    expect(planLabel("individual (free_educational_quota)")).toBe("Individual (free educational quota)");
    expect(planLabel("self_serve_business")).toBe("Self serve business");
    expect(planLabel("unknown")).toBeNull();
    expect(planLabel(null)).toBeNull();
  });
});

describe("accountState", () => {
  it("is off, failing, at its limit, cooling down or active, in that order", () => {
    const c = conn("a", "groq", 1);
    expect(accountState(c, rep([win("session", 50)]), 100).key).toBe("quota.state.active");
    expect(accountState({ ...c, cooldown_until: 500 }, rep([win("session", 50)]), 100)).toEqual({ tone: "warn", key: "quota.state.cooling" });
    expect(accountState({ ...c, cooldown_until: 50 }, rep([win("session", 50)]), 100).key).toBe("quota.state.active");
    expect(accountState({ ...c, cooldown_until: 500 }, rep([], { limit_reached: true }), 100).key).toBe("quota.state.limit");
    expect(accountState(c, rep([], { error: { status: 401, message: "x" } }), 100).key).toBe("quota.state.error");
    expect(accountState({ ...c, disabled: true }, rep([], { error: { status: 401, message: "x" } }), 100).key).toBe("quota.state.off");
  });
});

describe("groupByProvider and summarize", () => {
  const rows = [conn("g1", "groq", 1), conn("c1", "codex", 1), conn("g2", "groq", 2, true), conn("o1", "openrouter", 1)];
  const reports = {
    c1: rep([win("session", 96, 5000), win("weekly", 20, 9000)]),
    g1: rep([win("Requests", 2, 3000)], { limit_reached: true }),
    g2: rep([win("Requests", 100)]),
  };

  it("groups the accounts by provider, in the order they came", () => {
    expect(groupByProvider(rows).map((g) => [g.provider, g.rows.map((c) => c.id)])).toEqual([["groq", ["g1", "g2"]], ["codex", ["c1"]], ["openrouter", ["o1"]]]);
    expect(groupByProvider([])).toEqual([]);
  });

  it("says once per provider what holds for all its accounts", () => {
    const groq = [conn("g1", "groq", 1), conn("g2", "groq", 2), conn("g3", "groq", 3)];
    const r = (scope: string | null, plan: string | null = null) => rep([win("Requests", 50)], { plan, scope });
    expect(groupFacts(groq, { g1: r("m1"), g2: r("m1") })).toEqual({ noPlan: true, scope: "m1" });
    expect(groupFacts(groq, { g1: r("m1"), g2: r("m2") })).toEqual({ noPlan: true, scope: null });
    expect(groupFacts(groq, { g1: r(null, "plus"), g2: r(null) })).toEqual({ noPlan: false, scope: null });
    // Failed and missing reports say nothing either way.
    expect(groupFacts(groq, { g1: rep([], { error: { status: 401, message: "x" } }) })).toEqual({ noPlan: false, scope: null });
    expect(groupFacts(groq, {})).toEqual({ noPlan: false, scope: null });
  });

  it("counts the accounts that can take requests, the ones running low, and finds the next reset", () => {
    expect(summarize(rows, reports, 1000)).toEqual({
      total: 4,
      active: 3,
      off: 1,
      // c1 (20% left: low, but usable) and o1 (not reported yet) are on and not at a limit; g1 is at its limit.
      ready: 2,
      low: 2,
      next: { at: 3000, account: "g1", window: "Requests" },
    });
    // A reset that has passed is not the next one.
    expect(summarize(rows, reports, 4000).next).toEqual({ at: 5000, account: "c1", window: "session" });
    expect(summarize([], {}, 0)).toEqual({ total: 0, active: 0, off: 0, ready: 0, low: 0, next: null });
  });
});

describe("resetIn", () => {
  it("counts down in days, hours and minutes, and says now once passed", () => {
    expect(resetIn(1000 + 2 * 86400 + 3 * 3600, 1000)).toBe("in 2d 3h");
    expect(resetIn(1000 + 3 * 3600 + 15 * 60, 1000)).toBe("in 3h 15m");
    expect(resetIn(1000 + 59, 1000)).toBe("in 1m");
    expect(resetIn(1000 + 5 * 3600 - 30, 1000)).toBe("in 5h 0m");
    expect(resetIn(1000 + 86400 - 30, 1000)).toBe("in 1d 0h");
    expect(resetIn(900, 1000)).toBe("now");
  });
});

describe("arrange", () => {
  const rows = [conn("a", "codex", 1), conn("b", "codex", 2, true), conn("c", "groq", 1), conn("d", "deepseek", 1)];
  const reports = { a: rep([win("session", 20, 900)]), b: rep([win("session", 90, 200)]), c: rep([win("Requests", 50, 100)]) };
  const base = { provider: "all", status: "all", sort: "default", expiringFirst: false } as const;

  it("keeps the provider order, then the account order, by default", () => {
    expect(arrange(rows, reports, base).map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("filters by provider and by status", () => {
    expect(arrange(rows, reports, { ...base, provider: "codex" }).map((c) => c.id)).toEqual(["a", "b"]);
    expect(arrange(rows, reports, { ...base, status: "active" }).map((c) => c.id)).toEqual(["a", "c", "d"]);
    expect(arrange(rows, reports, { ...base, status: "off" }).map((c) => c.id)).toEqual(["b"]);
  });

  it("sorts by quota left, with unknown accounts last either way", () => {
    expect(arrange(rows, reports, { ...base, sort: "high" }).map((c) => c.id)).toEqual(["b", "c", "a", "d"]);
    expect(arrange(rows, reports, { ...base, sort: "low" }).map((c) => c.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("puts the soonest reset first when asked, ahead of the chosen sort", () => {
    expect(arrange(rows, reports, { ...base, sort: "low", expiringFirst: true }).map((c) => c.id)).toEqual(["c", "b", "a", "d"]);
  });
});

describe("bulk turn off and on", () => {
  const rows = [conn("a", "codex", 1), conn("b", "codex", 2, true), conn("c", "groq", 1), conn("d", "groq", 2, true), conn("e", "deepseek", 1)];
  const reports = { a: rep([win("session", 4)]), b: rep([win("session", 60)]), c: rep([win("Requests", 80)]), d: rep([win("Requests", 3)]) };

  it("turns off active accounts with 5% or less left, and only those whose quota is known", () => {
    expect(emptyToTurnOff(rows, reports).map((c) => c.id)).toEqual(["a"]);
  });

  it("turns on accounts that are off but have more than 5% left", () => {
    expect(availableToTurnOn(rows, reports).map((c) => c.id)).toEqual(["b"]);
  });
});
