import { BLOCKED_MESSAGE, RELAY_ERROR_HEADER, RELAY_SECRET_HEADER, isBlockPage } from "./codex";
import { PROXY_ERROR_HEADER, codexDestinationFor } from "./proxy-pools";
import { connectionAccess, type ConnectionAccess } from "./connections";
import type { Env } from "./env";
import { providerDef } from "./providers";

/**
 * What each provider says is left on an account (the quota tracker): Codex reads
 * chatgpt.com's wham/usage, Groq the rate-limit headers of its model list, DeepSeek its balance. Nothing is
 * cached; the console asks again on refresh. A key or token never leaves this module.
 */

export const QUOTA_PROVIDERS = ["codex", "groq", "deepseek"] as const;
export type QuotaProvider = (typeof QUOTA_PROVIDERS)[number];
export const isQuotaProvider = (v: unknown): v is QuotaProvider => typeof v === "string" && (QUOTA_PROVIDERS as readonly string[]).includes(v);

export interface QuotaWindow {
  name: string;
  /** percent: used/total are percent; count: requests or tokens; balance: money left (`total`, in `currency`). */
  kind: "percent" | "count" | "balance";
  used: number;
  total: number;
  remaining_percent: number;
  /** Unix seconds; null when the provider does not say. */
  reset_at: number | null;
  currency?: string;
}

export interface QuotaReport {
  plan: string | null;
  windows: QuotaWindow[];
  limit_reached: boolean;
  /** Codex: reset credits the account can spend. */
  reset_credits: number | null;
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

const report = (p: Partial<QuotaReport>): QuotaReport => ({ plan: null, windows: [], limit_reached: false, reset_credits: null, message: null, error: null, ...p });
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

function percentWindow(name: string, w: unknown): QuotaWindow | null {
  if (!isObj(w)) return null;
  const raw = num(w.used_percent ?? w.percent_used);
  if (raw === null) return null;
  const used = clamp(raw);
  return { name, kind: "percent", used, total: 100, remaining_percent: round2(100 - used), reset_at: toUnixSeconds(w.reset_at ?? w.resets_at ?? w.resetAt) };
}

function snapshotWindows(prefix: string, snap: unknown): { windows: QuotaWindow[]; reached: boolean } {
  if (!isObj(snap)) return { windows: [], reached: false };
  const body = isObj(snap.rate_limit) ? snap.rate_limit : snap;
  const windows = [percentWindow(`${prefix}session`, body.primary_window ?? body.primary), percentWindow(`${prefix}weekly`, body.secondary_window ?? body.secondary)].filter(
    (w): w is QuotaWindow => w !== null,
  );
  return { windows, reached: body.limit_reached === true };
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
  return report({ plan, windows: parts.flatMap((p) => p.windows), limit_reached: parts[0]!.reached || data.limit_reached === true, reset_credits: credits });
}

const WHAM_HEADERS = { accept: "application/json", "openai-beta": "codex-1", originator: "codex_cli_rs" };

type CodexCall = { ok: true; res: Response } | { ok: false; status: number; message: string };

/**
 * A call to chatgpt.com's /backend-api/wham/… with the account's token, through the relay when one is set.
 * A 401 renews the token once and asks again.
 */
async function codexCall(env: Env, upstream: Fetch, conn: ConnectionAccess, path: string, init: { method: "GET" | "POST"; body?: string }): Promise<CodexCall> {
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
  };
}

async function keyedCall(upstream: Fetch, url: string, key: string): Promise<Response | null> {
  try {
    return await upstream(new Request(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } }));
  } catch {
    return null;
  }
}

async function groqQuota(upstream: Fetch, key: string): Promise<QuotaReport> {
  const res = await keyedCall(upstream, `${providerDef("groq").baseUrl}/models`, key);
  if (!res) return failed(502, "could not reach Groq");
  // Never read the body: an error from Groq may quote the key.
  if (res.status === 401 || res.status === 403) return failed(res.status, "Groq authentication failed. Check the API key.");
  if (!res.ok) return failed(res.status, `Groq answered ${res.status}`);
  const now = nowS();
  const windows = [groqWindow(res.headers, "Requests", "requests", now), groqWindow(res.headers, "Tokens", "tokens", now)].filter((w): w is QuotaWindow => w !== null);
  return report({ plan: "Groq", windows, message: windows.length === 0 ? "Groq connected. No rate-limit data reported for this key yet." : null });
}

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
    return [{ name: `Balance (${currency})`, kind: "balance" as const, used: 0, total, remaining_percent: total > 0 ? 100 : 0, reset_at: null, currency }];
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

export async function fetchQuota(env: Env, upstream: Fetch, conn: ConnectionAccess): Promise<QuotaReport> {
  if (conn.provider === "codex") return codexQuota(env, upstream, conn);
  const key = await conn.key();
  if (key === null) return failed(0, "the stored key cannot be opened (CONNECTIONS_KEY changed)");
  if (typeof key !== "string") return failed(key.status, key.error);
  return conn.provider === "groq" ? groqQuota(upstream, key) : deepseekQuota(upstream, key);
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
