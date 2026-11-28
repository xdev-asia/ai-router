import { BLOCKED_MESSAGE, RELAY_ERROR_HEADER, RELAY_SECRET_HEADER, isBlockPage } from "./codex";
import { PROXY_ERROR_HEADER, codexDestinationFor } from "./proxy-pools";
import { connectionAccess, type ConnectionAccess } from "./connections";
import type { Env } from "./env";
import { COPILOT_HEADERS } from "./oauth";
import { providerDef } from "./providers";

/**
 * What each provider says about an account (the quota tracker): its plan, what is left and when it starts again.
 *
 *   codex       chatgpt.com's wham/usage: plan, 5-hour and weekly windows
 *   groq        the rate-limit headers of a chat answer (the model list carries none): requests a day and tokens a
 *               minute, for one model. Asking costs one request of one token, so the answer is kept (quota_snapshot)
 *               and only asked again on refresh
 *   openrouter  /key and /credits: free tier or paid, today's free-model requests, the key's limit, credits left
 *   github      copilot_internal/user: the Copilot plan and the month's premium requests
 *   deepseek    its balance
 *   ollama      /api/me: the plan only
 *
 * A key or token never leaves this module.
 */

export const QUOTA_PROVIDERS = ["codex", "groq", "openrouter", "github", "deepseek", "ollama"] as const;
export type QuotaProvider = (typeof QUOTA_PROVIDERS)[number];
export const isQuotaProvider = (v: unknown): v is QuotaProvider => typeof v === "string" && (QUOTA_PROVIDERS as readonly string[]).includes(v);

export interface QuotaWindow {
  name: string;
  /**
   * percent: used/total are percent; count: requests or tokens; spend: money used of a limit (in `currency`);
   * balance: money left (`total`, in `currency`; `used` is what was spent, 0 when the provider does not say).
   */
  kind: "percent" | "count" | "spend" | "balance";
  used: number;
  total: number;
  remaining_percent: number;
  /** Unix seconds; null when the provider does not say. */
  reset_at: number | null;
  /** Length of the cycle in seconds (18000: 5 hours, 86400: a day); null when the limit has none or it is unknown. */
  period_seconds: number | null;
  currency?: string;
}

export type QuotaSeat = "standard" | "premium";

export type QuotaTier = "free" | "paid";

export interface QuotaReport {
  /** The plan as the provider names it; null when it does not say. */
  plan: string | null;
  /** Whether that plan is the provider's free one; null when unknown. */
  tier: QuotaTier | null;
  /** ChatGPT Business (plan_type team/business): Standard seats have a 5-hour window, Premium seats do not. */
  seat: QuotaSeat | null;
  windows: QuotaWindow[];
  limit_reached: boolean;
  /** Codex: reset credits the account can spend. */
  reset_credits: number | null;
  /** The model the limits were read for, when they are per model (Groq). */
  scope: string | null;
  /** Unix seconds: when the provider was asked. Earlier than now for a kept answer. */
  checked_at: number;
  /** Connected, but nothing to show (and why). */
  message: string | null;
  error: { status: number; message: string } | null;
}

type Json = Record<string, unknown>;
type Fetch = (req: Request) => Promise<Response>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const clamp = (n: number) => Math.min(100, Math.max(0, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const nowS = () => Math.floor(Date.now() / 1000);

const report = (p: Partial<QuotaReport>): QuotaReport => ({
  plan: null,
  tier: null,
  seat: null,
  windows: [],
  limit_reached: false,
  reset_credits: null,
  scope: null,
  checked_at: nowS(),
  message: null,
  error: null,
  ...p,
});
const failed = (status: number, message: string) => report({ error: { status, message } });

/** Unix seconds from seconds, milliseconds (≥ 1e12) or an ISO date; null otherwise. */
export function toUnixSeconds(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  return null;
}

// --- Codex -------------------------------------------------------------------------------------------------

const SESSION_MAX_S = 6 * 3600;
const WEEKLY_MIN_S = 2 * 86400;

/** The window's length in seconds when the answer says it (limit_window_seconds or window_minutes). */
function windowSeconds(w: Json): number | null {
  const s = num(w.limit_window_seconds);
  if (s !== null && s > 0) return s;
  const m = num(w.window_minutes ?? w.limit_window_minutes);
  return m !== null && m > 0 ? m * 60 : null;
}

function percentWindow(prefix: string, fallback: "session" | "weekly", w: unknown): { window: QuotaWindow; seconds: number | null } | null {
  if (!isObj(w)) return null;
  const raw = num(w.used_percent ?? w.percent_used);
  if (raw === null) return null;
  const used = clamp(raw);
  const seconds = windowSeconds(w);
  // Named by length when known: a Premium seat has no 5-hour window, so its weekly one can come as `primary`.
  const base = seconds === null ? fallback : seconds <= SESSION_MAX_S ? "session" : seconds >= WEEKLY_MIN_S ? "weekly" : fallback;
  const reset_at = toUnixSeconds(w.reset_at ?? w.resets_at ?? w.resetAt);
  return { window: { name: `${prefix}${base}`, kind: "percent", used, total: 100, remaining_percent: round2(100 - used), reset_at, period_seconds: seconds }, seconds };
}

function snapshotWindows(prefix: string, snap: unknown): { windows: QuotaWindow[]; seconds: (number | null)[]; reached: boolean } {
  if (!isObj(snap)) return { windows: [], seconds: [], reached: false };
  const body = isObj(snap.rate_limit) ? snap.rate_limit : snap;
  const parts = [percentWindow(prefix, "session", body.primary_window ?? body.primary), percentWindow(prefix, "weekly", body.secondary_window ?? body.secondary)].filter(
    (p): p is NonNullable<typeof p> => p !== null,
  );
  return { windows: parts.map((p) => p.window), seconds: parts.map((p) => p.seconds), reached: body.limit_reached === true };
}

const BUSINESS_PLANS = new Set(["team", "business", "self_serve_business", "self_serve_business_prolite", "self_serve_business_usage_based"]);

/**
 * wham/usage has no seat field: both seats answer plan_type team (or business). A Standard seat has a 5-hour
 * window; a Premium seat only a weekly one. Null when the plan is not Business or the windows' lengths are unknown.
 */
export function businessSeat(plan: string, main: { seconds: (number | null)[] }): QuotaSeat | null {
  if (!BUSINESS_PLANS.has(plan.toLowerCase())) return null;
  if (main.seconds.length === 0 || main.seconds.some((s) => s === null)) return null;
  return main.seconds.some((s) => s! <= SESSION_MAX_S) ? "standard" : "premium";
}

function additional(data: Json, word: string): unknown {
  const list = Array.isArray(data.additional_rate_limits)
    ? data.additional_rate_limits
    : isObj(data.additional_rate_limits)
      ? Object.entries(data.additional_rate_limits).map(([id, v]) => (isObj(v) ? { id, ...v } : null))
      : [];
  return list.find((e) => isObj(e) && [e.limit_id, e.limit_name, e.id, e.name, e.metered_feature].some((x) => typeof x === "string" && x.toLowerCase().includes(word)));
}

/** chatgpt.com's wham/usage answer as rows: session and weekly, then review_ and spark_ ones when present. */
export function parseCodexUsage(data: Json): QuotaReport {
  const byId = isObj(data.rate_limits_by_limit_id) ? data.rate_limits_by_limit_id : {};
  const main = data.rate_limit ?? data.rate_limits ?? byId.codex;
  const review = data.code_review_rate_limit ?? data.review_rate_limit ?? byId.code_review ?? byId.codex_review ?? byId.review ?? additional(data, "review");
  const spark =
    data.spark_rate_limit ?? data.gpt_5_3_codex_spark_rate_limit ?? byId["gpt-5.3-codex-spark"] ?? byId.gpt_5_3_codex_spark ?? byId.spark ?? additional(data, "spark");
  const parts = [snapshotWindows("", main), snapshotWindows("review_", review), snapshotWindows("spark_", spark)];
  const summary = isObj(data.summary) ? data.summary : {};
  const plan = typeof data.plan_type === "string" && data.plan_type ? data.plan_type : typeof summary.plan === "string" && summary.plan ? summary.plan : "unknown";
  const credits = isObj(data.rate_limit_reset_credits) ? num(data.rate_limit_reset_credits.available_count) : null;
  const tier: QuotaTier | null = plan === "unknown" ? null : plan.toLowerCase() === "free" ? "free" : "paid";
  return report({ plan, tier, seat: businessSeat(plan, parts[0]!), windows: parts.flatMap((p) => p.windows), limit_reached: parts[0]!.reached || data.limit_reached === true, reset_credits: credits });
}

const WHAM_HEADERS = { accept: "application/json", "openai-beta": "codex-1", originator: "codex_cli_rs" };

type CodexCall = { ok: true; res: Response } | { ok: false; status: number; message: string };

/**
 * A call to chatgpt.com's /backend-api/wham/… with the account's token, through the relay when one is set.
 * A 401 renews the token once and asks again.
 */
export async function codexCall(env: Env, upstream: Fetch, conn: ConnectionAccess, path: string, init: { method: "GET" | "POST"; body?: string }): Promise<CodexCall> {
  const dest = await codexDestinationFor(env, conn.proxyPool);
  if (!dest.ok) return { ok: false, status: 0, message: dest.message };
  const url = dest.url.replace(/\/codex\/responses$/, "") + path;
  const send = async (force: boolean): Promise<CodexCall> => {
    const token = await conn.key(force);
    if (token === null) return { ok: false, status: 0, message: "the stored tokens cannot be opened (CONNECTIONS_KEY changed)" };
    if (typeof token !== "string") return { ok: false, status: token.status, message: token.error };
    const headers = new Headers({ ...WHAM_HEADERS, authorization: `Bearer ${token}` });
    if (conn.account) headers.set("chatgpt-account-id", conn.account);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (dest.secret) headers.set(RELAY_SECRET_HEADER, dest.secret);
    let res: Response;
    try {
      res = await (dest.fetch ?? upstream)(new Request(url, { method: init.method, headers, body: init.body }));
    } catch {
      return { ok: false, status: 502, message: "could not reach chatgpt.com" };
    }
    if (res.headers.get(PROXY_ERROR_HEADER)) {
      const e = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      return { ok: false, status: 502, message: e?.error?.message ?? "the proxy request failed" };
    }
    if (dest.secret && res.headers.get(RELAY_ERROR_HEADER) === "relay_unauthorized") return { ok: false, status: 502, message: "not_configured: the Codex relay refused CODEX_RELAY_SECRET" };
    if (isBlockPage(res)) return { ok: false, status: 502, message: BLOCKED_MESSAGE };
    return { ok: true, res };
  };
  const first = await send(false);
  if (!first.ok || first.res.status !== 401) return first;
  const again = await send(true);
  if (again.ok && again.res.status === 401) return { ok: false, status: 401, message: "Codex refused the account's token: sign in again" };
  return again;
}

async function codexQuota(env: Env, upstream: Fetch, conn: ConnectionAccess): Promise<QuotaReport> {
  const r = await codexCall(env, upstream, conn, "/wham/usage", { method: "GET" });
  if (!r.ok) return failed(r.status, r.message);
  const data = r.res.ok ? await r.res.json().catch(() => null) : null;
  if (!isObj(data)) return report({ message: `Codex connected. Usage API temporarily unavailable (${r.res.status}).` });
  return parseCodexUsage(data);
}

export interface ResetCredit {
  status: string;
  granted_at: number | null;
  expires_at: number | null;
}

/** The account's reset credits; `{error}` when chatgpt.com cannot be asked. */
export async function codexResetCredits(env: Env, upstream: Fetch, conn: ConnectionAccess): Promise<{ available_count: number; credits: ResetCredit[] } | { status: number; message: string }> {
  const r = await codexCall(env, upstream, conn, "/wham/rate-limit-reset-credits", { method: "GET" });
  if (!r.ok) return r;
  const data = r.res.ok ? await r.res.json().catch(() => null) : null;
  if (!isObj(data)) return { status: 502, message: `chatgpt.com answered ${r.res.status}` };
  const credits = (Array.isArray(data.credits) ? data.credits : []).filter(isObj).map((c) => ({
    status: typeof c.status === "string" ? c.status : "unknown",
    granted_at: toUnixSeconds(c.granted_at),
    expires_at: toUnixSeconds(c.expires_at),
  }));
  return { available_count: num(data.available_count) ?? credits.filter((c) => c.status === "available").length, credits };
}

/** Spends one reset credit. `no_credit`: none left. */
export async function consumeResetCredit(env: Env, upstream: Fetch, conn: ConnectionAccess): Promise<{ windows_reset: number } | { error: "no_credit" } | { status: number; message: string }> {
  const r = await codexCall(env, upstream, conn, "/wham/rate-limit-reset-credits/consume", { method: "POST", body: JSON.stringify({ redeem_request_id: crypto.randomUUID() }) });
  if (!r.ok) return r;
  const data = await r.res.json().catch(() => null);
  if (isObj(data) && data.code === "no_credit") return { error: "no_credit" };
  const windows = isObj(data) ? (num(data.windows_reset) ?? 0) : 0;
  if (r.res.ok && isObj(data) && (data.code === "reset" || windows > 0)) return { windows_reset: windows };
  return { status: 502, message: `chatgpt.com did not reset the limits (${r.res.status})` };
}

// --- API-key providers ---------------------------------------------------------------------------------------

/** A Go duration ("2m30s", "500ms", "1h") in seconds; null when there is none. */
export function parseGoDuration(v: string | null): number | null {
  if (!v) return null;
  const unit: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };
  let total = 0;
  let found = false;
  for (const m of v.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(m[1]) * unit[m[2]!]!;
    found = true;
  }
  return found ? total : null;
}

const DAY_S = 86400;

/** Groq counts requests by the day and tokens by the minute (its rate-limit headers, console.groq.com/docs/rate-limits). */
function groqWindow(h: Headers, name: string, which: "requests" | "tokens", now: number): QuotaWindow | null {
  const limit = num(h.get(`x-ratelimit-limit-${which}`));
  const remaining = num(h.get(`x-ratelimit-remaining-${which}`));
  if (limit === null || remaining === null) return null;
  const reset = parseGoDuration(h.get(`x-ratelimit-reset-${which}`));
  return {
    name,
    kind: "count",
    used: Math.max(0, limit - remaining),
    total: limit,
    remaining_percent: limit > 0 ? round2(clamp((remaining / limit) * 100)) : 0,
    reset_at: reset === null ? null : Math.ceil(now + reset),
    period_seconds: which === "requests" ? DAY_S : 60,
  };
}

async function keyedCall(upstream: Fetch, url: string, key: string, init: { method?: "GET" | "POST"; body?: string } = {}): Promise<Response | null> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  try {
    return await upstream(new Request(url, { method: init.method ?? "GET", headers, body: init.body }));
  } catch {
    return null;
  }
}

const GROQ_PROBE_FIRST = ["openai/gpt-oss-20b", "llama-3.1-8b-instant"];
const NOT_A_CHAT_MODEL = /whisper|guard|tts|orpheus|speech|embed/i;

/** The model the probe asks: a small chat model when the key has one of the usual ones, else its first chat model. */
export function groqProbeModel(ids: string[]): string | null {
  return GROQ_PROBE_FIRST.find((m) => ids.includes(m)) ?? ids.find((m) => !NOT_A_CHAT_MODEL.test(m)) ?? null;
}

/**
 * Groq's limits come only on an inference answer, so this sends one chat request of one token (it counts as one
 * request of the day). The limits are per model: `scope` names the one asked. An error body is never read: it may
 * quote the key.
 */
async function groqProbe(upstream: Fetch, key: string): Promise<QuotaReport> {
  const base = providerDef("groq").baseUrl;
  const list = await keyedCall(upstream, `${base}/models`, key);
  if (!list) return failed(502, "could not reach Groq");
  if (list.status === 401 || list.status === 403) return failed(list.status, "Groq authentication failed. Check the API key.");
  if (!list.ok) return failed(list.status, `Groq answered ${list.status}`);
  const data = await list.json().catch(() => null);
  const ids = (isObj(data) && Array.isArray(data.data) ? data.data : []).flatMap((m) => (isObj(m) && typeof m.id === "string" ? [m.id] : []));
  const model = groqProbeModel(ids);
  if (!model) return report({ message: "Groq connected. This key has no chat model to read the limits from." });
  const res = await keyedCall(upstream, `${base}/chat/completions`, key, { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }) });
  if (!res) return failed(502, "could not reach Groq");
  if (res.status === 401 || res.status === 403) return failed(res.status, "Groq authentication failed. Check the API key.");
  if (!res.ok && res.status !== 429) return failed(res.status, `Groq answered ${res.status}`);
  const now = nowS();
  const windows = [groqWindow(res.headers, "Requests", "requests", now), groqWindow(res.headers, "Tokens", "tokens", now)].filter((w): w is QuotaWindow => w !== null);
  if (windows.length === 0 && res.status === 429) return failed(429, "Groq answered 429");
  return report({ scope: model, windows, limit_reached: res.status === 429, message: windows.length === 0 ? "Groq connected. No rate-limit data reported for this key yet." : null });
}

/** A kept answer as it stands now: a window whose reset time has passed is full again. */
export function agedReport(r: QuotaReport, now: number): QuotaReport {
  const windows = r.windows.map((w) => (w.reset_at !== null && w.reset_at <= now ? { ...w, used: 0, remaining_percent: 100, reset_at: null } : w));
  return { ...r, windows, limit_reached: r.limit_reached && windows.some((w) => w.remaining_percent <= 0) };
}

async function keptQuota(db: D1Database, id: string): Promise<QuotaReport | null> {
  const row = await db.prepare("SELECT report FROM quota_snapshot WHERE connection = ?").bind(id).first<{ report: string }>();
  if (!row) return null;
  try {
    const v = JSON.parse(row.report) as QuotaReport;
    return isObj(v) && Array.isArray(v.windows) ? v : null;
  } catch {
    return null;
  }
}

/** Drops the kept answer of a connection that is gone. */
export async function forgetQuota(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM quota_snapshot WHERE connection = ?").bind(id).run();
}

async function groqQuota(env: Env, upstream: Fetch, id: string, key: string, refresh: boolean): Promise<QuotaReport> {
  if (!refresh) {
    const kept = await keptQuota(env.DB, id);
    if (kept) return agedReport(kept, nowS());
  }
  const r = await groqProbe(upstream, key);
  // Only an answer with limits is worth keeping; an error is asked again on the next look.
  if (!r.error && r.windows.length > 0) {
    await env.DB.prepare("INSERT INTO quota_snapshot (connection, report, checked_at) VALUES (?, ?, ?) ON CONFLICT (connection) DO UPDATE SET report = excluded.report, checked_at = excluded.checked_at")
      .bind(id, JSON.stringify(r), r.checked_at)
      .run();
  }
  return r;
}

// --- OpenRouter ----------------------------------------------------------------------------------------------

const LIMIT_RESET_S: Record<string, number> = { daily: DAY_S, weekly: 7 * DAY_S, monthly: 30 * DAY_S };

/** openrouter.ai's /key answer (and /credits, when it could be read) as a plan and rows. */
export function parseOpenRouter(key: Json, credits: Json | null): QuotaReport {
  const d = isObj(key.data) ? key.data : {};
  const free = d.is_free_tier === true;
  const windows: QuotaWindow[] = [];
  const daily = isObj(d.free_model_daily_requests) ? d.free_model_daily_requests : null;
  const dailyLimit = daily ? num(daily.limit) : null;
  let freeLeft: number | null = null;
  if (daily && dailyLimit !== null && dailyLimit > 0) {
    const used = Math.max(0, num(daily.used) ?? 0);
    freeLeft = Math.max(0, num(daily.remaining) ?? dailyLimit - used);
    windows.push({ name: "free_requests", kind: "count", used, total: dailyLimit, remaining_percent: round2(clamp((freeLeft / dailyLimit) * 100)), reset_at: null, period_seconds: DAY_S });
  }
  const limit = num(d.limit);
  if (limit !== null && limit > 0) {
    const left = Math.max(0, num(d.limit_remaining) ?? limit - (num(d.usage) ?? 0));
    const cycle = typeof d.limit_reset === "string" ? (LIMIT_RESET_S[d.limit_reset] ?? null) : null;
    windows.push({ name: "key_limit", kind: "spend", used: round2(limit - left), total: limit, remaining_percent: round2(clamp((left / limit) * 100)), reset_at: null, period_seconds: cycle, currency: "USD" });
  }
  const c = credits && isObj(credits.data) ? credits.data : null;
  const bought = c ? num(c.total_credits) : null;
  let creditLeft = 0;
  if (bought !== null && bought > 0) {
    const spent = Math.max(0, num(c!.total_usage) ?? 0);
    creditLeft = Math.max(0, bought - spent);
    windows.push({ name: "credits", kind: "balance", used: round2(spent), total: round2(creditLeft), remaining_percent: round2(clamp((creditLeft / bought) * 100)), reset_at: null, period_seconds: null, currency: "USD" });
  }
  return report({ plan: free ? "Free" : "Paid", tier: free ? "free" : "paid", windows, limit_reached: freeLeft === 0 && creditLeft <= 0 });
}

async function openrouterQuota(upstream: Fetch, key: string): Promise<QuotaReport> {
  const base = providerDef("openrouter").baseUrl;
  const [res, credits] = await Promise.all([keyedCall(upstream, `${base}/key`, key), keyedCall(upstream, `${base}/credits`, key)]);
  if (!res) return failed(502, "could not reach OpenRouter");
  // Never read an error body: it may quote the key.
  if (res.status === 401 || res.status === 403) return failed(res.status, "OpenRouter authentication failed. Check the API key.");
  if (!res.ok) return failed(res.status, `OpenRouter answered ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!isObj(data)) return failed(502, "OpenRouter answered something that is not JSON");
  const c = credits?.ok ? await credits.json().catch(() => null) : null;
  return parseOpenRouter(data, isObj(c) ? c : null);
}

// --- GitHub Copilot ------------------------------------------------------------------------------------------

/** Seconds from the same day a month earlier to `resetAt`: the length of the month that is running. */
function monthBefore(resetAt: number): number {
  const d = new Date(resetAt * 1000);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  return resetAt - Math.floor(start / 1000);
}

/** api.github.com's copilot_internal/user answer: the plan, and one row per quota that is not unlimited. */
export function parseCopilotUser(data: Json): QuotaReport {
  const planName = typeof data.copilot_plan === "string" && data.copilot_plan ? data.copilot_plan : null;
  const sku = typeof data.access_type_sku === "string" && data.access_type_sku ? data.access_type_sku : null;
  const plan = planName && sku ? `${planName} (${sku})` : (planName ?? sku);
  const tier: QuotaTier | null = plan === null ? null : /free/i.test(plan) ? "free" : "paid";
  const reset_at = toUnixSeconds(data.quota_reset_date_utc ?? data.quota_reset_date);
  const period_seconds = reset_at === null ? null : monthBefore(reset_at);
  const snaps = isObj(data.quota_snapshots) ? data.quota_snapshots : {};
  const windows: QuotaWindow[] = Object.entries(snaps).flatMap(([id, q]) => {
    if (!isObj(q) || q.unlimited === true) return [];
    const total = num(q.entitlement);
    if (total === null || total <= 0) return [];
    const left = Math.min(total, Math.max(0, num(q.remaining) ?? num(q.quota_remaining) ?? 0));
    const percent = num(q.percent_remaining);
    return [{ name: id, kind: "count" as const, used: round2(total - left), total, remaining_percent: round2(clamp(percent ?? (left / total) * 100)), reset_at, period_seconds }];
  });
  const premium = windows.find((w) => w.name === "premium_interactions");
  return report({ plan, tier, windows, limit_reached: premium !== undefined && premium.remaining_percent <= 0 });
}

async function copilotQuota(upstream: Fetch, conn: ConnectionAccess): Promise<QuotaReport> {
  // The quota is asked with GitHub's own token; the connection's access token is the short-lived Copilot one.
  const token = await conn.refreshToken();
  if (token === null) return failed(0, "the stored tokens cannot be opened (CONNECTIONS_KEY changed)");
  let res: Response;
  try {
    res = await upstream(new Request("https://api.github.com/copilot_internal/user", { headers: { authorization: `token ${token}`, accept: "application/json", "user-agent": COPILOT_HEADERS["user-agent"]! } }));
  } catch {
    return failed(502, "could not reach GitHub");
  }
  // Never read an error body: it may quote the token.
  if (res.status === 401 || res.status === 403) return failed(res.status, "GitHub refused the account's token: sign in again");
  if (!res.ok) return failed(res.status, `GitHub answered ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!isObj(data)) return failed(502, "GitHub answered something that is not JSON");
  return parseCopilotUser(data);
}

// --- Ollama Cloud --------------------------------------------------------------------------------------------

/** ollama.com's /api/me: the plan. Ollama reports no limit and no reset time. */
async function ollamaQuota(upstream: Fetch, key: string): Promise<QuotaReport> {
  const res = await keyedCall(upstream, "https://ollama.com/api/me", key, { method: "POST" });
  if (!res) return failed(502, "could not reach Ollama");
  if (res.status === 401 || res.status === 403) return failed(res.status, "Ollama authentication failed. Check the API key.");
  if (!res.ok) return failed(res.status, `Ollama answered ${res.status}`);
  const data = await res.json().catch(() => null);
  const plan = isObj(data) && typeof data.Plan === "string" && data.Plan ? data.Plan : null;
  return report({ plan, tier: plan === null ? null : plan.toLowerCase() === "free" ? "free" : "paid" });
}

// --- DeepSeek ------------------------------------------------------------------------------------------------

async function deepseekQuota(upstream: Fetch, key: string): Promise<QuotaReport> {
  const res = await keyedCall(upstream, "https://api.deepseek.com/user/balance", key);
  if (!res) return failed(502, "could not reach DeepSeek");
  if (res.status === 401 || res.status === 403) return failed(res.status, "DeepSeek authentication failed. Check the API key.");
  if (!res.ok) return failed(res.status, `DeepSeek answered ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!isObj(data)) return failed(502, "DeepSeek answered something that is not JSON");
  const windows: QuotaWindow[] = (Array.isArray(data.balance_infos) ? data.balance_infos : []).filter(isObj).flatMap((b) => {
    if (typeof b.currency !== "string" || b.currency === "") return [];
    const total = num(b.total_balance) ?? 0;
    const currency = b.currency.toUpperCase();
    return [{ name: `Balance (${currency})`, kind: "balance" as const, used: 0, total, remaining_percent: total > 0 ? 100 : 0, reset_at: null, period_seconds: null, currency }];
  });
  const plan = data.is_available === true ? "DeepSeek" : "DeepSeek (Insufficient Balance)";
  return report({ plan, windows, message: windows.length === 0 ? "DeepSeek connected. No balance data returned." : null });
}

// --- Entry -----------------------------------------------------------------------------------------------------

/** The connection, when its provider reports a quota; null otherwise (404). */
export async function quotaConnection(env: Env, upstream: Fetch, id: string): Promise<ConnectionAccess | null> {
  const conn = await connectionAccess(env, upstream, id);
  return conn && isQuotaProvider(conn.provider) ? conn : null;
}

/** `refresh`: ask the provider even when that costs a request (Groq); otherwise a kept answer is used when there is one. */
export async function fetchQuota(env: Env, upstream: Fetch, conn: ConnectionAccess, refresh = false): Promise<QuotaReport> {
  if (conn.provider === "codex") return codexQuota(env, upstream, conn);
  if (conn.provider === "github") return copilotQuota(upstream, conn);
  const key = await conn.key();
  if (key === null) return failed(0, "the stored key cannot be opened (CONNECTIONS_KEY changed)");
  if (typeof key !== "string") return failed(key.status, key.error);
  if (conn.provider === "groq") return groqQuota(env, upstream, conn.id, key, refresh);
  if (conn.provider === "openrouter") return openrouterQuota(upstream, key);
  if (conn.provider === "ollama") return ollamaQuota(upstream, key);
  return deepseekQuota(upstream, key);
}

// --- Hidden rows (FR-QUO-10) -----------------------------------------------------------------------------------

export type HiddenRows = Partial<Record<QuotaProvider, string[]>>;
const MAX_HIDDEN = 50;

export async function getHiddenRows(db: D1Database): Promise<HiddenRows> {
  const row = await db.prepare("SELECT value FROM setting WHERE key = 'quota_visibility'").first<{ value: string }>();
  if (!row) return {};
  try {
    const v = JSON.parse(row.value) as unknown;
    if (!isObj(v)) return {};
    const out: HiddenRows = {};
    for (const p of QUOTA_PROVIDERS) {
      const names = v[p];
      if (Array.isArray(names) && names.length > 0 && names.every((n) => typeof n === "string")) out[p] = names as string[];
    }
    return out;
  } catch {
    return {};
  }
}

/** Sets the hidden rows of one provider; null when the input is not valid. */
export async function setHiddenRows(db: D1Database, provider: unknown, names: unknown): Promise<HiddenRows | null> {
  if (!isQuotaProvider(provider) || !Array.isArray(names) || names.length > MAX_HIDDEN) return null;
  if (!names.every((n) => typeof n === "string" && n !== "" && n.length <= 100)) return null;
  const next = { ...(await getHiddenRows(db)) };
  if (names.length === 0) delete next[provider];
  else next[provider] = [...new Set(names as string[])];
  await db
    .prepare("INSERT INTO setting (key, value, updated_at) VALUES ('quota_visibility', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(JSON.stringify(next), nowS())
    .run();
  return next;
}
