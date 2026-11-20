import type { System } from "./auth";
import { candidatesFor } from "./connections";
import type { Env } from "./env";
import { CATALOG } from "./model-catalog";
import { allSynced } from "./model-sync";
import { ANTHROPIC_VERSION, PROVIDERS, aliasOf, providerIds, allowedPatterns, allows, hasEnvKey, parseModel, targetName, type ProviderId, type Target } from "./providers";

/**
 * Models (backlog item 11, FR-MDL-01..13), after an MIT-licensed gateway's model rules (see THIRD_PARTY_NOTICES.md): the `(level)` thinking
 * suffix and the `[1m]` marker on a model name, the provider a bare name is guessed to belong to, the owner's
 * aliases, disabled and added models, each provider's Thinking mode, and the /v1/models list.
 */

type Json = Record<string, unknown>;

/** The thinking levels and the token budget each stands for. */
/** `ultra` (Codex, gpt-6.2): above max; its budget is a guess for providers that take a budget. [Inference] */
export const LEVEL_TO_BUDGET = { none: 0, minimal: 512, low: 1024, medium: 8192, high: 24576, xhigh: 32768, max: 128000, ultra: 200000 } as const;
export type Level = Exclude<keyof typeof LEVEL_TO_BUDGET, "none">;
const LEVELS = (Object.keys(LEVEL_TO_BUDGET) as (keyof typeof LEVEL_TO_BUDGET)[]).filter((l): l is Level => l !== "none");
const isLevel = (v: string): v is Level => (LEVELS as string[]).includes(v);

export type Thinking = { mode: "none" } | { mode: "auto" } | { mode: "level"; level: Level } | { mode: "budget"; tokens: number };

const ONE_M = /\[1m\]$/i;
const SUFFIX = /^(.*)\(([^()]+)\)\s*$/;

function readThinking(raw: string): Thinking | null {
  const v = raw.trim().toLowerCase();
  if (v === "none" || v === "off") return { mode: "none" };
  if (v === "auto") return { mode: "auto" };
  if (/^\d+$/.test(v)) return { mode: "budget", tokens: Number(v) };
  return isLevel(v) ? { mode: "level", level: v } : null;
}

/**
 * Takes the markers off a model name: a trailing `[1m]` and a `(value)` thinking suffix (a level, none/off, auto
 * or a token budget). An unknown value is dropped with its brackets and sets nothing.
 */
export function stripMarkers(raw: string): { model: string; thinking: Thinking | null } {
  const model = raw.replace(ONE_M, "");
  const m = SUFFIX.exec(model);
  if (!m || !m[1]) return { model, thinking: null };
  return { model: m[1].replace(ONE_M, ""), thinking: readThinking(m[2]!) };
}

/** The lowest level whose budget covers `tokens`; above every level, max. [Inference: no reference rule found.] */
export function levelOfBudget(tokens: number): Level | "none" {
  if (tokens <= 0) return "none";
  return LEVELS.find((l) => LEVEL_TO_BUDGET[l] >= tokens) ?? "max";
}

/** The request with the suffix's thinking applied, as OpenAI's `reasoning_effort`. Never changes `req` itself. */
export function applyThinking(req: Json, t: Thinking): Json {
  if (t.mode === "auto") return req;
  const level = t.mode === "none" ? "none" : t.mode === "level" ? t.level : levelOfBudget(t.tokens);
  if (level === "none") {
    const { reasoning_effort: _e, reasoning: _r, thinking: _t, ...rest } = req;
    return rest;
  }
  return { ...req, reasoning_effort: level };
}

/** The guesses for a name without a provider, first match wins; anything else is OpenAI (FR-MDL-03). */
const INFER: [RegExp, ProviderId][] = [
  [/^codex-auto-review$/, "codex"],
  [/^gpt-[56]\./, "codex"],
  [/^gpt-6-/, "codex"],
  [/^gpt-daybreak-/, "codex"],
  [/^gpt-reserve/, "codex"],
  [/^claude-/, "anthropic"],
  [/^gemini-/, "gemini"],
  [/^gpt-/, "openai"],
  [/^o[134]/, "openai"],
  [/^deepseek-/, "openrouter"],
];
export const inferProvider = (bare: string): ProviderId => INFER.find(([re]) => re.test(bare.toLowerCase()))?.[1] ?? "openai";

/** The id the provider is sent: the catalog's `upstream` for a variant (`gpt-6-astra[1m]`), else the same id. */
export const upstreamModel = (t: Target): string => CATALOG[t.provider]?.models.find((m) => m.id === t.model)?.upstream ?? t.model;

// --- stored state -------------------------------------------------------------------------------------------

export async function loadAliases(db: D1Database): Promise<Record<string, string>> {
  const r = await db.prepare("SELECT alias, model FROM model_alias ORDER BY alias").all<{ alias: string; model: string }>();
  return Object.fromEntries(r.results.map((x) => [x.alias, x.model]));
}

export async function getAlias(db: D1Database, alias: string): Promise<string | null> {
  return (await db.prepare("SELECT model FROM model_alias WHERE alias = ?").bind(alias).first<{ model: string }>())?.model ?? null;
}

/** Every disabled model, as `provider/model`. */
export async function disabledSet(db: D1Database): Promise<Set<string>> {
  const r = await db.prepare("SELECT provider, model FROM model_disabled").all<{ provider: string; model: string }>();
  return new Set(r.results.map((x) => `${x.provider}/${x.model}`));
}

export async function isDisabled(db: D1Database, t: Target): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM model_disabled WHERE provider = ? AND model = ?").bind(t.provider, t.model).first()) !== null;
}

export async function customModels(db: D1Database, provider?: ProviderId): Promise<{ provider: ProviderId; model: string; name: string | null }[]> {
  const q = provider
    ? db.prepare("SELECT provider, model, name FROM model_custom WHERE provider = ? ORDER BY created_at, model").bind(provider)
    : db.prepare("SELECT provider, model, name FROM model_custom ORDER BY created_at, model");
  return (await q.all<{ provider: ProviderId; model: string; name: string | null }>()).results;
}

/** Each provider's Thinking mode (FR-MDL-06), as the owner set it on the provider's page. "auto" is not stored. */
export async function getProviderThinking(db: D1Database): Promise<Record<string, string>> {
  const row = await db.prepare("SELECT value FROM setting WHERE key = 'provider_thinking'").first<{ value: string }>();
  try {
    const v: unknown = row ? JSON.parse(row.value) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, m]) => typeof m === "string")) : {};
  } catch {
    return {};
  }
}

export async function saveProviderThinking(db: D1Database, modes: Record<string, string>): Promise<void> {
  await db
    .prepare("INSERT INTO setting (key, value, updated_at) VALUES ('provider_thinking', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(JSON.stringify(modes), Math.floor(Date.now() / 1000))
    .run();
}

/** Providers with an enabled connection or a key in the environment. */
export async function activeProviders(env: Env): Promise<Set<ProviderId>> {
  const r = await env.DB.prepare("SELECT DISTINCT provider FROM connection WHERE disabled = 0").all<{ provider: ProviderId }>();
  const out = new Set(r.results.map((x) => x.provider));
  for (const p of Object.keys(PROVIDERS) as ProviderId[]) if (hasEnvKey(env, p)) out.add(p);
  return out;
}

// --- /v1/models ----------------------------------------------------------------------------------------------

export interface ListedModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_length?: number;
  thinking_levels?: string[];
}

interface ModelInfo {
  id: string;
  created?: number;
  context?: number;
  thinking?: readonly string[];
}

/** Claude models from Anthropic itself, with the system's key; null when there is no key or the call failed. */
async function anthropicModels(env: Env, upstream: (req: Request) => Promise<Response>, system: System, now: number): Promise<ModelInfo[] | null> {
  let key: string | null = null;
  for (const cand of await candidatesFor(env, "anthropic", system.id, now)) {
    const k = await cand.key();
    if (typeof k === "string") {
      key = k;
      break;
    }
  }
  if (!key) return null;
  try {
    const up = await upstream(new Request(env.ANTHROPIC_BASE_URL.replace(/\/+$/, "") + "/v1/models?limit=1000", { headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION } }));
    if (!up.ok) return null;
    const list = (await up.json()) as { data?: { id?: unknown; created_at?: unknown }[] };
    return (list.data ?? []).flatMap((m) =>
      typeof m.id === "string" ? [{ id: m.id, created: typeof m.created_at === "string" ? Math.floor(Date.parse(m.created_at) / 1000) || 0 : 0 }] : [],
    );
  } catch {
    return null;
  }
}

/**
 * What `system` may call (FR-MDL-08): its combos, then the models of every provider with a key or a connection
 * (all providers when none has one): the catalog (Claude from Anthropic when it answers) and the owner's added
 * models, less the disabled ones; then alias targets and the exact entries of its allow-list. A provider's
 * models are named with its short prefix (`cx/gpt-6-astra`); each id once.
 */
export async function listModels(env: Env, upstream: (req: Request) => Promise<Response>, system: System): Promise<ListedModel[]> {
  const now = Math.floor(Date.now() / 1000);
  const patterns = allowedPatterns(system.allowed_models);
  const out: ListedModel[] = [];
  const seen = new Set<string>();
  const push = (canonical: string, m: ListedModel) => {
    if (seen.has(m.id) || !allows(patterns, canonical)) return;
    seen.add(m.id);
    out.push(m);
  };
  const disabled = await disabledSet(env.DB);
  const entry = (t: Target, info: ModelInfo = { id: t.model }) => {
    if (disabled.has(targetName(t))) return;
    const alias = aliasOf(t.provider);
    push(targetName(t), {
      id: `${alias}/${t.model}`,
      object: "model",
      created: info.created ?? 0,
      owned_by: alias,
      ...(info.context ? { context_length: info.context } : {}),
      ...(info.thinking ? { thinking_levels: [...info.thinking] } : {}),
    });
  };

  const combos = await env.DB.prepare("SELECT name, updated_at FROM combo ORDER BY name").all<{ name: string; updated_at: number }>();
  for (const cb of combos.results) push(`combo/${cb.name}`, { id: `combo/${cb.name}`, object: "model", created: cb.updated_at, owned_by: "combo" });

  const active = await activeProviders(env);
  const custom = await customModels(env.DB);
  const synced = await allSynced(env.DB);
  const ids = providerIds().filter((p) => active.size === 0 || active.has(p));
  for (const p of ids) {
    // Skips the providers the allow-list cannot reach (and Anthropic's call with them).
    if (!patterns.some((x) => x === "*" || x.startsWith(`${p}/`))) continue;
    let models: readonly ModelInfo[] = CATALOG[p]?.models ?? [];
    if (p === "anthropic" && active.has(p)) models = (await anthropicModels(env, upstream, system, now)) ?? models;
    for (const m of models) entry({ provider: p, model: m.id }, m);
    for (const m of custom) if (m.provider === p) entry({ provider: p, model: m.model });
    // The provider's own list (model-sync.ts): models it added since the catalog was made.
    for (const m of synced) if (m.provider === p) entry({ provider: p, model: m.model }, { id: m.model, ...(m.context ? { context: m.context } : {}), ...(m.thinking ? { thinking: m.thinking } : {}) });
  }

  for (const model of Object.values(await loadAliases(env.DB))) {
    const ref = parseModel(stripMarkers(model).model);
    if (ref?.kind === "target") entry(ref.target);
  }
  for (const x of patterns) {
    if (x.includes("*")) continue;
    const ref = parseModel(x);
    if (ref?.kind === "target") entry(ref.target);
  }
  return out;
}
