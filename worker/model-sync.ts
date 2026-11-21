/**
 * Model sync: a provider's own model list, fetched with one of its connections and kept in D1 (model_synced), so a
 * model the provider adds shows up without a new release of the gateway. The fixed catalog (model-catalog.ts)
 * stays; synced models are listed beside it, and a synced model the catalog lacks is "new" for a week.
 *
 * - Codex: chatgpt.com's `codex/models?client_version=` with the account's token, the list Codex CLI reads
 *   (openai/codex, codex-rs/codex-api/src/endpoint/models.rs). Through the Codex relay when one is set.
 * - OpenAI-format providers with an API key: `modelsUrl` (default `baseUrl/models`) with the key.
 * - GitHub Copilot: its `/models` with the Copilot token. Only the chat models the account may call through
 *   `/chat/completions` (readCopilotModels).
 * Anything else (Anthropic has its own live list, sign-ins without a list) is not synced.
 */
import { candidatesFor } from "./connections";
import { connectionAccess } from "./connections";
import type { Env } from "./env";
import { CATALOG } from "./model-catalog";
import { isModelName, providerDef, type ProviderId } from "./providers";
import { codexCall } from "./quota";

type Fetch = (req: Request) => Promise<Response>;

/** The Codex CLI version the models list is asked for: the backend may hide models from older clients. */
export const CODEX_CLIENT_VERSION = "0.169.1";
/** A synced model the catalog lacks counts as new for this long after it first showed up. */
const NEW_FOR_S = 7 * 86_400;

export interface SyncedModel {
  id: string;
  name: string;
  thinking?: string[];
  context?: number;
}

export interface SyncState {
  supported: boolean;
  synced_at: number | null;
  error: string | null;
}

/** Whether `provider` has a model list this gateway can read. */
export function syncSupported(provider: ProviderId): boolean {
  const def = providerDef(provider);
  if (def.format === "codex" || provider === "github") return true;
  return def.format === "openai" && def.auth !== "oauth" && typeof (def.modelsUrl ?? def.baseUrl) === "string";
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);

/** chatgpt.com's `{models: [...]}`: the ones it lists (visibility other than hide), with levels and context. */
export function readCodexModels(body: unknown): SyncedModel[] | null {
  if (!isObj(body) || !Array.isArray(body.models)) return null;
  const out: SyncedModel[] = [];
  for (const m of body.models) {
    if (!isObj(m) || typeof m.slug !== "string" || !isModelName(m.slug) || m.visibility === "hide") continue;
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l) => (isObj(l) && typeof l.effort === "string" ? l.effort : null)).filter((l): l is string => l !== null) : [];
    out.push({ id: m.slug, name: typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim().slice(0, 100) : m.slug, ...(levels.length ? { thinking: levels } : {}), ...(num(m.context_window) ? { context: num(m.context_window) } : {}) });
  }
  return out;
}

/** An OpenAI-format `{data: [{id}]}` (Gemini prefixes ids with `models/`). */
export function readOpenAIModels(body: unknown): SyncedModel[] | null {
  if (!isObj(body) || !Array.isArray(body.data)) return null;
  const out: SyncedModel[] = [];
  for (const m of body.data) {
    if (!isObj(m) || typeof m.id !== "string") continue;
    const id = m.id.replace(/^models\//, "");
    if (!isModelName(id)) continue;
    const context = num(m.context_window) ?? num(m.context_length);
    out.push({ id, name: typeof m.name === "string" && m.name.trim() ? m.name.trim().slice(0, 100) : id, ...(context ? { context } : {}) });
  }
  return out;
}

/**
 * Copilot's `{data: [...]}`: chat models (`capabilities.type`), not turned off for the account (`policy.state`), that
 * `/chat/completions` serves (`supported_endpoints`, absent on older models). The gateway sends Copilot only there,
 * so a model served on `/responses` alone would fail.
 */
export function readCopilotModels(body: unknown): SyncedModel[] | null {
  if (!isObj(body) || !Array.isArray(body.data)) return null;
  const out: SyncedModel[] = [];
  for (const m of body.data) {
    if (!isObj(m) || typeof m.id !== "string" || !isModelName(m.id)) continue;
    const caps = isObj(m.capabilities) ? m.capabilities : {};
    if (caps.type !== "chat") continue;
    if (isObj(m.policy) && m.policy.state === "disabled") continue;
    if (Array.isArray(m.supported_endpoints) && !m.supported_endpoints.includes("/chat/completions")) continue;
    const context = num(isObj(caps.limits) ? caps.limits.max_context_window_tokens : undefined);
    out.push({ id: m.id, name: typeof m.name === "string" && m.name.trim() ? m.name.trim().slice(0, 100) : m.id, ...(context ? { context } : {}) });
  }
  return out;
}

type Fetched = { ok: true; models: SyncedModel[] } | { ok: false; status: 400 | 409 | 502; message: string };

async function fetchCodex(env: Env, upstream: Fetch): Promise<Fetched> {
  const row = await env.DB.prepare("SELECT id FROM connection WHERE provider = 'codex' AND disabled = 0 ORDER BY priority, created_at LIMIT 1").first<{ id: string }>();
  const conn = row ? await connectionAccess(env, upstream, row.id) : null;
  if (!conn) return { ok: false, status: 409, message: "no Codex connection that is on: sign in on the Providers page first" };
  const version = env.CODEX_CLIENT_VERSION?.trim() || CODEX_CLIENT_VERSION;
  const r = await codexCall(env, upstream, conn, `/codex/models?client_version=${encodeURIComponent(version)}`, { method: "GET" });
  if (!r.ok) return { ok: false, status: 502, message: r.message };
  if (!r.res.ok) return { ok: false, status: 502, message: `chatgpt.com answered ${r.res.status}` };
  const models = readCodexModels(await r.res.json().catch(() => null));
  return models ? { ok: true, models } : { ok: false, status: 502, message: "chatgpt.com's model list was not in the expected shape" };
}

async function fetchOpenAI(env: Env, upstream: Fetch, provider: ProviderId): Promise<Fetched> {
  const def = providerDef(provider);
  const url = def.modelsUrl ?? `${def.baseUrl!.replace(/\/+$/, "")}/models`;
  let key: string | null = null;
  for (const cand of await candidatesFor(env, provider, "", Math.floor(Date.now() / 1000), upstream)) {
    const k = await cand.key();
    if (typeof k === "string") {
      key = k;
      break;
    }
  }
  if (!key) return { ok: false, status: 409, message: provider === "github" ? "no GitHub Copilot sign-in that is on: sign in on the Providers page first" : `no key for ${provider}: add a connection first` };
  let res: Response;
  try {
    res = await upstream(new Request(url, { headers: { ...def.headers, authorization: `Bearer ${key}`, accept: "application/json" } }));
  } catch {
    return { ok: false, status: 502, message: `could not reach ${provider}` };
  }
  if (!res.ok) return { ok: false, status: 502, message: `${provider} answered ${res.status}` };
  const body: unknown = await res.json().catch(() => null);
  const models = provider === "github" ? readCopilotModels(body) : readOpenAIModels(body);
  return models ? { ok: true, models } : { ok: false, status: 502, message: `${provider}'s model list was not in the expected shape` };
}

export type SyncResult = { ok: true; provider: string; count: number; added: string[]; removed: string[]; synced_at: number } | { ok: false; status: 400 | 409 | 502; message: string };

/**
 * Fetches `provider`'s list and replaces its synced models with it. On a failure the last list stays and the error
 * is kept for the console. `added`: models not synced before; `removed`: synced before, gone now.
 */
export async function syncModels(env: Env, upstream: Fetch, provider: ProviderId): Promise<SyncResult> {
  if (!syncSupported(provider)) return { ok: false, status: 400, message: `${provider} has no model list to sync` };
  const got = providerDef(provider).format === "codex" ? await fetchCodex(env, upstream) : await fetchOpenAI(env, upstream, provider);
  const now = Math.floor(Date.now() / 1000);
  if (!got.ok) {
    await env.DB.prepare("INSERT INTO model_sync (provider, synced_at, error, error_at) VALUES (?, NULL, ?, ?) ON CONFLICT (provider) DO UPDATE SET error = excluded.error, error_at = excluded.error_at")
      .bind(provider, got.message.slice(0, 300), now)
      .run();
    return got;
  }
  const before = new Set((await env.DB.prepare("SELECT model FROM model_synced WHERE provider = ?").bind(provider).all<{ model: string }>()).results.map((r) => r.model));
  const seen = new Set<string>();
  const models = got.models.filter((m) => !seen.has(m.id) && seen.add(m.id));
  const removed = [...before].filter((id) => !seen.has(id));
  await env.DB.batch([
    ...models.map((m) =>
      env.DB.prepare(
        "INSERT INTO model_synced (provider, model, name, thinking, context, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (provider, model) DO UPDATE SET name = excluded.name, thinking = excluded.thinking, context = excluded.context, last_seen = excluded.last_seen",
      ).bind(provider, m.id, m.name, m.thinking ? JSON.stringify(m.thinking) : null, m.context ?? null, now, now),
    ),
    ...removed.map((id) => env.DB.prepare("DELETE FROM model_synced WHERE provider = ? AND model = ?").bind(provider, id)),
    env.DB.prepare("INSERT INTO model_sync (provider, synced_at, error, error_at) VALUES (?, ?, NULL, NULL) ON CONFLICT (provider) DO UPDATE SET synced_at = excluded.synced_at, error = NULL, error_at = NULL").bind(provider, now),
  ]);
  // Added: models the gateway did not know, neither from the last sync nor from the catalog.
  const catalog = new Set((CATALOG[provider]?.models ?? []).map((m) => m.id));
  return { ok: true, provider, count: models.length, added: models.filter((m) => !before.has(m.id) && !catalog.has(m.id)).map((m) => m.id), removed, synced_at: now };
}

export interface StoredSynced extends SyncedModel {
  /** In the provider's list but not in the catalog, first seen within a week. */
  new: boolean;
}

/** `provider`'s synced models, and its sync state. */
export async function syncedModels(db: D1Database, provider: ProviderId): Promise<{ models: StoredSynced[]; state: SyncState }> {
  const rows = await db.prepare("SELECT model, name, thinking, context, first_seen FROM model_synced WHERE provider = ? ORDER BY first_seen DESC, model").bind(provider).all<{ model: string; name: string | null; thinking: string | null; context: number | null; first_seen: number }>();
  const state = await db.prepare("SELECT synced_at, error FROM model_sync WHERE provider = ?").bind(provider).first<{ synced_at: number | null; error: string | null }>();
  const catalog = new Set((CATALOG[provider]?.models ?? []).map((m) => m.id));
  const now = Math.floor(Date.now() / 1000);
  return {
    models: rows.results.map((r) => ({
      id: r.model,
      name: r.name ?? r.model,
      ...(r.thinking ? { thinking: JSON.parse(r.thinking) as string[] } : {}),
      ...(r.context ? { context: r.context } : {}),
      new: !catalog.has(r.model) && now - r.first_seen < NEW_FOR_S,
    })),
    state: { supported: syncSupported(provider), synced_at: state?.synced_at ?? null, error: state?.error ?? null },
  };
}

/** Every provider's synced models, for /v1/models. */
export async function allSynced(db: D1Database): Promise<{ provider: string; model: string; thinking: string[] | null; context: number | null }[]> {
  const r = await db.prepare("SELECT provider, model, thinking, context FROM model_synced ORDER BY provider, model").all<{ provider: string; model: string; thinking: string | null; context: number | null }>();
  return r.results.map((x) => ({ provider: x.provider, model: x.model, thinking: x.thinking ? (JSON.parse(x.thinking) as string[]) : null, context: x.context }));
}
