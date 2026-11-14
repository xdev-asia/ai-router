import { parseModel, targetName, type Target } from "./providers";

/**
 * How a combo picks its model (four strategies, FR-CMB-05..15):
 * - fallback: the saved order, every request.
 * - round-robin: each request starts one model further on; the rest follow in turn (FR-CMB-10).
 * - smart: a router model reads the user's last message and picks the model to try first (FR-CMB-12, 13, 32).
 * - fusion: every model answers, then a judge model writes the answer (FR-CMB-14, 15, 30).
 * A combo without its own strategy follows the gateway-wide setting "combo", then fallback.
 */
export const STRATEGIES = ["fallback", "round-robin", "smart", "fusion"] as const;
export type Strategy = (typeof STRATEGIES)[number];
export const isStrategy = (v: unknown): v is Strategy => typeof v === "string" && (STRATEGIES as readonly string[]).includes(v);

export const POLICIES = ["smart", "strict", "per-turn", "custom"] as const;
export type Policy = (typeof POLICIES)[number];

export interface FusionTuning {
  /** Answers needed before the grace period starts (FR-CMB-14: 2). */
  min_answers: number;
  /** How long to wait for slower models once `min_answers` are in (8 s). */
  grace_ms: number;
  /** The longest the panel may take (90 s). */
  max_ms: number;
}

/** A combo's own settings for its strategy. Null fields take the defaults below. */
export interface ComboConfig {
  judge_model?: string | null;
  router_model?: string | null;
  policy?: Policy;
  /** Custom Threshold only: 0.5 to 0.95. */
  threshold?: number;
  fusion?: Partial<FusionTuning>;
}

export const FUSION_DEFAULTS: FusionTuning = { min_answers: 2, grace_ms: 8000, max_ms: 90_000 };
/** The threshold of Smart Switch, Strict Lock and Per-Turn (FR-CMB-13). */
export const SMART_THRESHOLD = 0.8;
export const ROUTER_TIMEOUT_MS = 8000;
export const ROUTER_INPUT_CHARS = 2000;
/** A session's model is dropped this long after its last use (FR-CMB-13). */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isModel = (v: unknown) => typeof v === "string" && parseModel(v)?.kind === "target";
const intIn = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** Why a combo's config is refused, or null. */
export function configError(config: unknown): string | null {
  if (config === null || config === undefined) return null;
  if (!isObj(config)) return "config: an object";
  for (const f of ["judge_model", "router_model"] as const) {
    const v = config[f];
    if (v !== undefined && v !== null && !isModel(v)) return `config.${f}: provider/model or claude-*`;
  }
  if (config.policy !== undefined && !(POLICIES as readonly unknown[]).includes(config.policy)) return `config.policy: one of ${POLICIES.join(", ")}`;
  if (config.threshold !== undefined && !(typeof config.threshold === "number" && config.threshold >= 0.5 && config.threshold <= 0.95)) return "config.threshold: 0.5 to 0.95";
  if (config.fusion !== undefined) {
    const f = config.fusion;
    if (!isObj(f)) return "config.fusion: an object";
    if (f.min_answers !== undefined && !intIn(f.min_answers, 1, 50)) return "config.fusion.min_answers: 1 to 50";
    if (f.grace_ms !== undefined && !intIn(f.grace_ms, 0, 120_000)) return "config.fusion.grace_ms: 0 to 120000";
    if (f.max_ms !== undefined && !intIn(f.max_ms, 1000, 300_000)) return "config.fusion.max_ms: 1000 to 300000";
  }
  return null;
}

/** The stored config as an object; a damaged row reads as no config. */
export function readConfig(raw: string | null): ComboConfig {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return configError(v) === null && isObj(v) ? (v as ComboConfig) : {};
  } catch {
    return {};
  }
}

/** Gateway-wide combo settings (the setting row "combo"). */
export interface ComboSettings {
  strategy: Strategy;
  /** Round robin moves on after this many requests (`comboStickyRoundRobinLimit`, FR-CMB-10). */
  sticky_limit: number;
}
export const COMBO_SETTINGS_DEFAULT: ComboSettings = { strategy: "fallback", sticky_limit: 1 };

export function mergeComboSettings(current: ComboSettings, patch: Record<string, unknown>): ComboSettings | null {
  const next = { ...current };
  if ("strategy" in patch) {
    if (!isStrategy(patch.strategy)) return null;
    next.strategy = patch.strategy;
  }
  if ("sticky_limit" in patch) {
    if (!intIn(patch.sticky_limit, 1, 1000)) return null;
    next.sticky_limit = patch.sticky_limit as number;
  }
  return next;
}

export async function getComboSettings(db: D1Database): Promise<ComboSettings> {
  const row = await db.prepare("SELECT value FROM setting WHERE key = 'combo'").first<{ value: string }>();
  if (!row) return COMBO_SETTINGS_DEFAULT;
  try {
    return mergeComboSettings(COMBO_SETTINGS_DEFAULT, JSON.parse(row.value) as Record<string, unknown>) ?? COMBO_SETTINGS_DEFAULT;
  } catch {
    return COMBO_SETTINGS_DEFAULT;
  }
}

export async function saveComboSettings(db: D1Database, value: ComboSettings): Promise<void> {
  await db
    .prepare("INSERT INTO setting (key, value, updated_at) VALUES ('combo', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(JSON.stringify(value), Math.floor(Date.now() / 1000))
    .run();
  resetCombo();
}

// ---- Round robin --------------------------------------------------------------------------------------------

/**
 * Where each combo's rotation stands, in this isolate's memory. Another
 * isolate keeps its own count, so on Workers the turn is per isolate. [Inference: Workers may run several isolates.]
 */
const rotation = new Map<string, { index: number; used: number }>();

/** `targets` starting at the combo's current model; counts this request and moves on after `sticky` of them. */
export function rotate<T>(name: string, targets: readonly T[], sticky: number): T[] {
  if (targets.length < 2) return [...targets];
  const s = rotation.get(name) ?? { index: 0, used: 0 };
  const start = s.index % targets.length;
  s.used += 1;
  if (s.used >= Math.max(1, Math.floor(sticky) || 1)) {
    s.index = (start + 1) % targets.length;
    s.used = 0;
  }
  rotation.set(name, s);
  return [...targets.slice(start), ...targets.slice(0, start)];
}

/** Forgets the rotation and the smart-router sessions of one combo, or of all (FR-CMB-11, FR-CMB-13). */
export function resetCombo(name?: string): void {
  if (name === undefined) {
    rotation.clear();
    sessions.clear();
    return;
  }
  rotation.delete(name);
  for (const k of sessions.keys()) if (k.startsWith(`${name}\u0000`)) sessions.delete(k);
}

// ---- Smart router -------------------------------------------------------------------------------------------

/** The model a session settled on, per combo and session, with when it was last used. */
const sessions = new Map<string, { model: string; at: number }>();

export function thresholdOf(config: ComboConfig): number {
  return config.policy === "custom" && typeof config.threshold === "number" ? config.threshold : SMART_THRESHOLD;
}

/** The text of the last user message, at most ROUTER_INPUT_CHARS. */
export function lastUserText(req: Record<string, unknown>): string {
  const messages = Array.isArray(req.messages) ? (req.messages as Record<string, unknown>[]) : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join("\n") : "";
    return text.slice(0, ROUTER_INPUT_CHARS);
  }
  return "";
}

/**
 * The chat request sent to the router model (FR-CMB-32): any chat model is asked for the choice as JSON, so the
 * owner can use a model they have.
 */
export function routerRequest(routerModel: string, members: string[], text: string): Record<string, unknown> {
  return {
    model: routerModel,
    stream: false,
    temperature: 0,
    max_tokens: 200,
    messages: [
      {
        role: "system",
        content:
          "You pick the model best suited to answer a request. Reply with JSON only: " +
          '{"choice": "<one model id from the list>", "confidence": <0 to 1>, "probabilities": {"<model id>": <0 to 1>}}.',
      },
      { role: "user", content: `Models:\n${members.map((m) => `- ${m}`).join("\n")}\n\nRequest:\n${text}` },
    ],
  };
}

export interface RouterAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/** Reads the router's JSON reply (also inside a code fence or after some words); null when it has no choice. */
export function parseRouterAnswer(text: string): RouterAnswer | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v: unknown = JSON.parse(text.slice(start, end + 1));
    if (!isObj(v) || typeof v.choice !== "string") return null;
    const probabilities: Record<string, number> = {};
    if (isObj(v.probabilities)) for (const [k, p] of Object.entries(v.probabilities)) if (typeof p === "number") probabilities[k] = p;
    const confidence = typeof v.confidence === "number" ? v.confidence : (probabilities[v.choice] ?? 0);
    return { choice: v.choice, confidence, probabilities };
  } catch {
    return null;
  }
}

/** `chosen` first, then the others by the router's probabilities (highest first), ties in the saved order. */
export function orderByChoice(targets: readonly Target[], chosen: string, probabilities: Record<string, number> = {}): Target[] {
  const first = targets.filter((t) => targetName(t) === chosen);
  if (first.length === 0) return [...targets];
  const rest = targets
    .map((t, i) => ({ t, i, p: probabilities[targetName(t)] ?? -1 }))
    .filter((x) => targetName(x.t) !== chosen)
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map((x) => x.t);
  return [...first, ...rest];
}

/** The model this session holds for this combo, if it is still fresh and still a member. */
export function heldModel(combo: string, session: string | null, members: readonly string[], now = Date.now()): string | null {
  if (!session) return null;
  const k = `${combo}\u0000${session}`;
  const s = sessions.get(k);
  if (!s || now - s.at > SESSION_TTL_MS || !members.includes(s.model)) {
    sessions.delete(k);
    return null;
  }
  return s.model;
}

export function holdModel(combo: string, session: string | null, model: string, now = Date.now()): void {
  if (session) sessions.set(`${combo}\u0000${session}`, { model, at: now });
}

/** Lets go of a session's model after it failed or answered empty (FR-CMB-13). */
export function dropHeld(combo: string, session: string | null, model: string): void {
  if (!session) return;
  const k = `${combo}\u0000${session}`;
  if (sessions.get(k)?.model === model) sessions.delete(k);
}

// ---- Fusion -------------------------------------------------------------------------------------------------

/** Text of a message's content (string, or the text parts of an array). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
  return "";
}

/**
 * The request each panel model gets (FR-CMB-30): no stream, no tools; tool calls and tool results in the
 * history become plain text, so a model without tools can still read them.
 */
export function panelRequest(req: Record<string, unknown>): Record<string, unknown> {
  const { tools: _t, tool_choice: _c, stream_options: _s, parallel_tool_calls: _p, ...rest } = req;
  const messages = (Array.isArray(req.messages) ? (req.messages as Record<string, unknown>[]) : []).map((m) => {
    if (m.role === "tool") return { role: "user", content: `[tool result${typeof m.tool_call_id === "string" ? ` ${m.tool_call_id}` : ""}]\n${textOf(m.content)}` };
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const calls = (m.tool_calls as Record<string, unknown>[])
        .map((tc) => {
          const f = isObj(tc.function) ? tc.function : {};
          return `[tool call ${String(f.name ?? "")}] ${String(f.arguments ?? "")}`;
        })
        .join("\n");
      return { role: "assistant", content: [textOf(m.content), calls].filter(Boolean).join("\n") };
    }
    return m;
  });
  return { ...rest, messages, stream: false };
}

/** The judge's request: the client's own (stream and tools kept), with the panel's answers, unnamed, before it. */
export function judgeRequest(req: Record<string, unknown>, answers: string[]): Record<string, unknown> {
  const panel = answers.map((a, i) => `<answer ${i + 1}>\n${a}\n</answer ${i + 1}>`).join("\n\n");
  const note = {
    role: "system",
    content:
      "Several assistants answered the conversation below. Their answers follow, unnamed. Write the single best " +
      "final answer to the user: keep what is correct, fix what is wrong, and do not mention the other answers.\n\n" +
      panel,
  };
  const messages = Array.isArray(req.messages) ? (req.messages as unknown[]) : [];
  return { ...req, messages: [note, ...messages] };
}

/**
 * Settles the panel: resolves with the answers once all are in, or `min` are in and `grace` has passed since,
 * or `max` has passed. A rejected or null result counts as no answer.
 */
export function gather<T>(calls: Promise<T | null>[], t: FusionTuning): Promise<T[]> {
  return new Promise((resolve) => {
    const got: T[] = [];
    let pending = calls.length;
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(maxTimer);
      clearTimeout(graceTimer);
      resolve([...got]);
    };
    const maxTimer = setTimeout(finish, t.max_ms);
    if (pending === 0) finish();
    for (const p of calls) {
      p.then(
        (v) => {
          if (v !== null && v !== undefined) got.push(v);
        },
        () => undefined,
      ).finally(() => {
        pending -= 1;
        if (pending === 0) finish();
        else if (got.length >= t.min_answers && graceTimer === undefined) graceTimer = setTimeout(finish, t.grace_ms);
      });
    }
  });
}
