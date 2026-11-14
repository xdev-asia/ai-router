import { beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "../api";
import { resetLang } from "../i18n";
import {
  arrange,
  availableToTurnOn,
  emptyToTurnOff,
  leastLeft,
  nextReset,
  quotaTone,
  resetIn,
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
  ...extra,
});
const rep = (windows: QuotaWindow[], extra: Partial<QuotaReport> = {}): QuotaReport => ({
  plan: "plus",
  windows,
  limit_reached: false,
  reset_credits: null,
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
  it("names the Codex windows and keeps any other name as it came", () => {
    expect(windowLabel("session")).toBe("Session (5h)");
    expect(windowLabel("weekly")).toBe("Weekly");
    expect(windowLabel("review_weekly")).toBe("Code review · Weekly");
    expect(windowLabel("spark_session")).toBe("Spark · Session (5h)");
    expect(windowLabel("Balance (USD)")).toBe("Balance (USD)");
  });

  it("says what is left in the window's own unit", () => {
    expect(windowValue(win("session", 62.5))).toBe("63% left");
    expect(windowValue(win("Tokens", 25, null, { kind: "count", used: 4500, total: 6000 }))).toBe("1,500 / 6,000 left");
    expect(windowValue(win("Balance (USD)", 100, null, { kind: "balance", total: 12.5, currency: "USD" }))).toBe("12.50 USD");
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
