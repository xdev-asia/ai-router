import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * How the console is signed in: with xDev ID, or with the admin token. Either way the gateway holds the
 * session (an HttpOnly cookie the page never sees, stored in D1 as a hash), so a reload stays signed in.
 * The admin token is sent once, to POST /auth/token, and never kept by the page.
 */
export type Auth = { kind: "token" } | { kind: "sso"; email: string; name: string } | null;

let auth: Auth = null;
const listeners = new Set<() => void>();

export function setAuth(next: Auth): void {
  auth = next;
  listeners.forEach((l) => l());
}

/** Trades the admin token for a console session. Throws ApiError(401) for a wrong token. */
export async function signInWithToken(token: string): Promise<void> {
  const res = await fetch("/auth/token", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status, res.status === 401 ? "unauthorized" : String(res.status));
  setAuth({ kind: "token" });
}

export function useAuth(): Auth {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => auth,
    () => null,
  );
}

/** The console session of this browser, if any, and whether xDev ID sign-in is set up on the gateway. */
export async function checkSession(): Promise<{ user: Auth; sso: boolean }> {
  try {
    const res = await fetch("/auth/me");
    const body = (await res.json()) as { email?: unknown; name?: unknown; sso?: unknown; admin?: unknown };
    if (res.ok && body.admin === true) return { user: { kind: "token" }, sso: false };
    if (res.ok && typeof body.email === "string") {
      return { user: { kind: "sso", email: body.email, name: typeof body.name === "string" ? body.name : body.email }, sso: true };
    }
    return { user: null, sso: body.sso === true };
  } catch {
    return { user: null, sso: false };
  }
}

/** Signs out: ends the console session on the gateway. */
export async function signOut(): Promise<void> {
  await fetch("/auth/logout", { method: "POST" }).catch(() => undefined);
  setAuth(null);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** What the gateway said in plain words, when it did (e.g. a provider's reason for refusing a sign-in). */
    readonly detail: string | null = null,
  ) {
    super(code);
  }
}

/** Calls /admin with the console session cookie. A 401 signs the console out. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/admin${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) {
    setAuth(null);
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: unknown };
    throw new ApiError(res.status, body.error ?? String(res.status), typeof body.message === "string" ? body.message : null);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type LoadState<T> = { status: "loading" } | { status: "error"; code: string } | { status: "ready"; data: T };

/** Loads an admin resource; `reload()` fetches it again and keeps the old data on screen meanwhile. */
export function useLoad<T>(path: string): [LoadState<T>, () => void] {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    api<T>(path).then(
      (data) => live && setState({ status: "ready", data }),
      (e: unknown) => live && setState({ status: "error", code: e instanceof ApiError ? e.code : "failed" }),
    );
    return () => {
      live = false;
    };
  }, [path, tick]);
  return [state, () => setTick((n) => n + 1)];
}

export interface System {
  id: string;
  name: string;
  monthly_token_cap: number | null;
  disabled: boolean;
  created_at: number;
  /** JSON array of model patterns; null means Claude only. */
  allowed_models: string | null;
  rtk: boolean;
  caveman: SaverLevel | null;
  ponytail: SaverLevel | null;
}

export type SaverLevel = "lite" | "full" | "ultra";

/** The savers every system gets (GET/PUT /admin/token-saver). */
export interface TokenSaverSettings {
  rtk: boolean;
  caveman: SaverLevel | null;
  ponytail: SaverLevel | null;
  custom_prompt: string | null;
  headroom: { enabled: boolean; url: string | null };
}

/** How a combo picks its model (worker/combo-strategy.ts). */
export const COMBO_STRATEGIES = ["fallback", "round-robin", "smart", "fusion"] as const;
export type ComboStrategy = (typeof COMBO_STRATEGIES)[number];
export const ROUTER_POLICIES = ["smart", "strict", "per-turn", "custom"] as const;
export type RouterPolicy = (typeof ROUTER_POLICIES)[number];

/** A combo's own settings for its strategy. */
export interface ComboConfig {
  judge_model?: string | null;
  router_model?: string | null;
  policy?: RouterPolicy;
  threshold?: number;
}

export interface Combo {
  name: string;
  targets: string[];
  updated_at: number;
  /** Null: the gateway-wide strategy (Fallback unless changed). */
  strategy?: ComboStrategy | null;
  config?: ComboConfig | null;
}

/** A provider the gateway can reach. `env_key`: the environment holds a key for it. */
export interface Provider {
  id: string;
  name: string;
  format: string;
  auth: string[];
  env_key: boolean;
  /** The provider's page for creating a key. */
  key_url: string | null;
  strategy: "fill-first" | "round-robin";
  /** The provider's own colour (a CSS hex colour) and one to three letters, for its `Emblem`. */
  color: string;
  mark: string;
  /** The provider gives a key with free use (rate limited); good last steps in a Fallback combo. */
  free_tier?: boolean;
  /** Added by the owner (POST /admin/custom-providers): its endpoint, which it can edit or delete. */
  custom?: boolean;
  base_url?: string;
  /** What a connection of this provider is set up with besides its key (worker/wire.ts); never their values. */
  settings?: ProviderSetting[];
  /** A subscription login whose client comes from the gateway's variables (Google) names the unset ones; it cannot be added until they are set. */
  missing_env?: string[];
}

/** One setting of a provider's connections. `default`: what an empty one means. `options`: the only values it takes. */
export interface ProviderSetting {
  name: string;
  required: boolean;
  secret: boolean;
  default: string | null;
  options: string[] | null;
}

/** One model on a provider's page. `id` is the provider's own id; clients send `<alias>/<id>`. */
export interface ProviderModel {
  id: string;
  name: string;
  /** Added by the owner, so it can be removed. */
  custom: boolean;
  disabled: boolean;
  /** The thinking levels the model takes. */
  thinking?: string[];
  context?: number;
  /** In the provider's own list, as last synced. */
  synced?: boolean;
  /** Synced, not in the catalog, first seen within a week. */
  new?: boolean;
}

/** A provider's Available Models card: its prefix, its Thinking mode and its models. */
export interface ProviderModels {
  provider: string;
  alias: string;
  thinking: { options: string[]; mode: string } | null;
  models: ProviderModel[];
  /** Whether the provider's own list can be synced, when it last was, and the last failure. */
  sync?: { supported: boolean; synced_at: number | null; error: string | null };
}

/** One account at a provider. The key itself never reaches the console: only its last 4 characters. */
export interface Connection {
  id: string;
  provider: string;
  auth_type: "api_key" | "oauth";
  name: string;
  hint: string | null;
  /** The provider's id of the account an OAuth connection signed in as. */
  account: string | null;
  expires_at: number | null;
  priority: number;
  disabled: boolean;
  /** Unix seconds; the account is set aside while this is in the future. */
  cooldown_until: number;
  last_error: string | null;
  last_error_at: number | null;
  last_used_at: number | null;
  /** The proxy pool this account's requests go through; null or absent: straight out. */
  proxy_pool?: string | null;
  created_at: number;
  updated_at: number;
}

/** One pattern per line or comma; the same rule as the gateway's (providers.ts PATTERN). */
export const MODEL_PATTERN = /^(\*|[a-z][a-z0-9-]*\/\*|[a-z][a-z0-9-]*\/[A-Za-z0-9._:\/@+_-]{1,200})$/;
/** A combo target: provider/model or a bare claude-* model. */
export const TARGET = /^(claude-[A-Za-z0-9._:@+_-]{1,190}|[a-z][a-z0-9-]*\/[A-Za-z0-9._:\/@+_-]{1,200})$/;
/** Letters, digits, -, _ and . (worker/providers.ts COMBO_NAME). Systems call it bare or as combo/<name>. */
export const COMBO_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** What the gateway answers (400) when a combo name is already used. */
export const COMBO_TAKEN = "Combo name already exists";

/** The combo a member names (`combo/x`, or a bare name of a known combo), else null. */
export function memberCombo(member: string, known: ReadonlySet<string>): string | null {
  if (member.startsWith("combo/")) return member.slice(6);
  return !member.includes("/") && known.has(member) ? member : null;
}

export const splitList = (raw: string): string[] => [...new Set(raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];

/** The patterns a system's allowed_models holds (Claude only when null). */
export function patternsOf(s: Pick<System, "allowed_models">): string[] {
  if (s.allowed_models === null) return ["anthropic/*"];
  try {
    const v: unknown = JSON.parse(s.allowed_models);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : ["anthropic/*"];
  } catch {
    return ["anthropic/*"];
  }
}

export interface UsageTokens {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** US dollars, from the owner's prices; null when nothing in the group has a price. */
  cost: number | null;
  /** Requests answered with status 400 or above. */
  errors?: number;
  /** Mean latency of the requests that recorded one; null when none did. */
  latency_ms?: number | null;
}

export interface UsageRequest {
  id: number;
  /** Unix seconds. */
  at: number;
  system_id: string;
  provider: string;
  model: string | null;
  status: number;
  streamed: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  latency_ms: number | null;
}

export type UsagePeriod = "today" | "24h" | "7d" | "30d" | "60d" | "all";

export interface UsageSummary {
  period: UsagePeriod;
  from: number;
  totals: UsageTokens & { unpriced_requests: number };
  by_provider: (UsageTokens & { provider: string; last_at?: number | null })[];
  by_model: (UsageTokens & { provider: string; model: string | null; last_at?: number | null })[];
  /** Per provider account; `name` and `hint` only, never the key. Media rows have no account (null). */
  by_connection?: (UsageTokens & { connection_id: string | null; provider: string; name: string | null; hint: string | null; last_at: number | null })[];
  by_system: (UsageTokens & { system_id: string; name?: string | null; last_at?: number | null })[];
  recent: UsageRequest[];
  /** The same span just before the period, for the change beside each total; null for "all". */
  previous?: UsageTokens | null;
}

/** One bucket of the Usage chart: its start (unix seconds) and what it holds; cost null when nothing in it is priced. */
export interface UsageBucket {
  t: number;
  requests: number;
  tokens: number;
  cost: number | null;
  errors?: number;
}

export interface UsageChart {
  period: UsagePeriod;
  /** Bucket width in seconds: an hour or a day. */
  step: number;
  buckets: UsageBucket[];
}

/** US dollars per 1M tokens. */
export interface PriceRates {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** A price the gateway knows: `target` is "provider/model" or a bare model; `custom` when the owner set it. */
export interface PriceRow extends PriceRates {
  target: string;
  custom: boolean;
  /** The built-in price for this target, when there is one; resetting a custom price goes back to it. */
  default: PriceRates | null;
}

export interface UsageRow {
  system_id: string;
  provider: string;
  model: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface UsageReport {
  month: string;
  rows: UsageRow[];
}

/** Tokens a row counts against the cap: the same sum the gateway uses. */
export const capTokens = (r: UsageRow): number =>
  r.input_tokens + r.output_tokens + r.cache_creation_input_tokens + r.cache_read_input_tokens;
