import type { Env } from "./env";
import type { Usage } from "./usage";

/**
 * Providers reached with their own official API keys. Anthropic speaks Messages; the others speak
 * OpenAI Chat Completions at `baseUrl` + `/chat/completions`. Subscription logins (Claude Pro/Max,
 * ChatGPT, Gemini CLI, Copilot...) are deliberately absent.
 */
export const PROVIDERS = {
  anthropic: { format: "anthropic" },
  openai: { format: "openai", baseUrl: "https://api.openai.com/v1" },
  gemini: { format: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  openrouter: { format: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  deepseek: { format: "openai", baseUrl: "https://api.deepseek.com/v1" },
  groq: { format: "openai", baseUrl: "https://api.groq.com/openai/v1" },
} as const;

export type ProviderId = keyof typeof PROVIDERS;
export const isProvider = (p: string): p is ProviderId => Object.hasOwn(PROVIDERS, p);

export type Target = { provider: ProviderId; model: string };
export type ModelRef = { kind: "target"; target: Target } | { kind: "combo"; name: string };

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,199}$/;
export const COMBO_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * `claude-*` (no prefix) and `anthropic/<model>` are Claude; `<provider>/<model>` another provider (the model
 * may itself contain "/", as OpenRouter's do); `combo/<name>` a fallback list. Null when it is none of these.
 */
export function parseModel(raw: unknown): ModelRef | null {
  if (typeof raw !== "string" || !MODEL.test(raw)) return null;
  const i = raw.indexOf("/");
  if (i < 0) return raw.startsWith("claude-") ? { kind: "target", target: { provider: "anthropic", model: raw } } : null;
  const head = raw.slice(0, i);
  const rest = raw.slice(i + 1);
  if (!rest) return null;
  if (head === "combo") return COMBO_NAME.test(rest) ? { kind: "combo", name: rest } : null;
  return isProvider(head) ? { kind: "target", target: { provider: head, model: rest } } : null;
}

export const targetName = (t: Target) => `${t.provider}/${t.model}`;

/**
 * The key for a provider. Anthropic keeps one key per system (ANTHROPIC_KEYS); the other providers have
 * one key each in PROVIDER_KEYS (`{"openai": "sk-...", "groq": "gsk_..."}`), shared by the systems allowed
 * to use them.
 */
export function providerKey(env: Env, provider: ProviderId, systemId: string): string | null {
  const raw = provider === "anthropic" ? env.ANTHROPIC_KEYS : env.PROVIDER_KEYS;
  if (!raw) return null;
  try {
    const keys = JSON.parse(raw) as Record<string, unknown>;
    const k = keys[provider === "anthropic" ? systemId : provider];
    return typeof k === "string" && k !== "" ? k : null;
  } catch {
    return null;
  }
}

/** The patterns a system's `allowed_models` holds; NULL or unreadable means Claude only. */
export function allowedPatterns(raw: string | null): string[] {
  if (raw === null) return ["anthropic/*"];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : ["anthropic/*"];
  } catch {
    return ["anthropic/*"];
  }
}

/** `name` is "provider/model" or "combo/name"; a pattern is exact, `provider/*` or `*`. */
export function allows(patterns: string[], name: string): boolean {
  return patterns.some((p) => p === "*" || p === name || (p.endsWith("/*") && name.startsWith(p.slice(0, -1))));
}

export const PATTERN = /^(\*|[a-z]+\/\*|[a-z]+\/[A-Za-z0-9._:\/@+-]{1,200})$/;

/** Usage in an OpenAI chat completion (or the last stream chunk), in this gateway's terms. */
export function usageOfOpenAI(model: string | null, u: unknown): Usage {
  const o = u && typeof u === "object" ? (u as Record<string, unknown>) : {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const details = o.prompt_tokens_details && typeof o.prompt_tokens_details === "object" ? (o.prompt_tokens_details as Record<string, unknown>) : {};
  const cached = num(details.cached_tokens);
  return {
    model,
    input_tokens: Math.max(0, num(o.prompt_tokens) - cached),
    output_tokens: num(o.completion_tokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}
