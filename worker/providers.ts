import type { Env } from "./env";
import type { Usage } from "./usage";

/** The Messages API version this gateway speaks when it builds an Anthropic request itself. */
export const ANTHROPIC_VERSION = "2023-06-01";

export interface ProviderDef {
  name: string;
  /** The provider's own colour and one to three letters, for its mark in the console (from 9router's registry). */
  color: string;
  mark: string;
  /**
   * "anthropic": the Messages API at ANTHROPIC_BASE_URL. "openai": Chat Completions at `baseUrl` + `/chat/completions`.
   * "codex": the ChatGPT Codex backend (worker/codex.ts).
   */
  format: "anthropic" | "openai" | "codex";
  /** "oauth": the provider is reached with a subscription login (worker/oauth.ts) instead of an API key. */
  auth?: "oauth";
  baseUrl?: string;
  /** Where a key is checked (a GET that needs the key). Default: `baseUrl` + `/models`. */
  modelsUrl?: string;
  /** The provider's page for creating a key, linked from the console. */
  keyUrl?: string;
}

/**
 * Providers reached with their own API keys. Anthropic speaks Messages; the others speak OpenAI Chat Completions.
 * The first six are the gateway's original ones; the rest are the providers 9router (MIT) lists as plain
 * OpenAI-compatible, with the names, base URLs and key pages from its registry at commit 54a88d04. Only the first
 * six have been called by this gateway's tests against the real services' shapes; the others are untested against
 * the live providers. `codex` is the first subscription login (a ChatGPT account, as the Codex CLI uses it).
 */
export const PROVIDERS = {
  anthropic: { name: "Anthropic", color: "#D97757", mark: "AN", format: "anthropic", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { name: "OpenAI", color: "#10A37F", mark: "OA", format: "openai", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
  gemini: { name: "Google Gemini", color: "#4285F4", mark: "GE", format: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/app/apikey" },
  openrouter: { name: "OpenRouter", color: "#F97316", mark: "OR", format: "openai", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/settings/keys" },
  deepseek: { name: "DeepSeek", color: "#4D6BFE", mark: "DS", format: "openai", baseUrl: "https://api.deepseek.com/v1", keyUrl: "https://platform.deepseek.com/api_keys" },
  groq: { name: "Groq", color: "#F55036", mark: "GQ", format: "openai", baseUrl: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys" },
  agnes: { name: "Agnes AI", color: "#7C3AED", mark: "AG", format: "openai", baseUrl: "https://apihub.agnes-ai.com/v1", keyUrl: "https://platform.agnes-ai.com" },
  alicode: { name: "Alibaba", color: "#FF6A00", mark: "ALI", format: "openai", baseUrl: "https://coding.dashscope.aliyuncs.com/v1", keyUrl: "https://bailian.console.aliyun.com/?apiKey=1" },
  "alicode-intl": { name: "Alibaba Coding", color: "#FF6A00", mark: "ALI", format: "openai", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", keyUrl: "https://www.alibabacloud.com/product/coding" },
  "alims-intl": { name: "Alibaba Studio", color: "#FF6A00", mark: "ALI", format: "openai", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyUrl: "https://modelstudio.console.alibabacloud.com/?apiKey=1" },
  "alitp-intl": { name: "Alibaba Token Plan", color: "#FF6A00", mark: "ATP", format: "openai", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", keyUrl: "https://modelstudio.console.alibabacloud.com/?apiKey=1" },
  atria: { name: "Atria Dawn", color: "#C2410C", mark: "AD", format: "openai", baseUrl: "https://api.atria-asi.ai/v1", keyUrl: "https://api.atria-asi.ai/dashboard" },
  bai: { name: "B.AI", color: "#0369A1", mark: "BA", format: "openai", baseUrl: "https://api.b.ai/v1", keyUrl: "https://b.ai" },
  baidu: { name: "Baidu Qianfan", color: "#2932E1", mark: "BD", format: "openai", baseUrl: "https://qianfan.baidubce.com/v2", keyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application" },
  bazaarlink: { name: "Bazaarlink", color: "#DC2626", mark: "BZ", format: "openai", baseUrl: "https://bazaarlink.ai/api/v1", keyUrl: "https://bazaarlink.ai" },
  blackbox: { name: "Blackbox AI", color: "#5B5FEF", mark: "BB", format: "openai", baseUrl: "https://api.blackbox.ai/v1", keyUrl: "https://www.blackbox.ai/api-management" },
  bluesminds: { name: "BluesMinds", color: "#2563EB", mark: "BM", format: "openai", baseUrl: "https://api.bluesminds.com/v1", keyUrl: "https://bluesminds.com" },
  byteplus: { name: "BytePlus ModelArk", color: "#2563EB", mark: "BP", format: "openai", baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3", keyUrl: "https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey" },
  cerebras: { name: "Cerebras", color: "#FF4F00", mark: "CB", format: "openai", baseUrl: "https://api.cerebras.ai/v1", keyUrl: "https://cloud.cerebras.ai/platform" },
  chutes: { name: "Chutes AI", color: "#FFFFFF", mark: "CH", format: "openai", baseUrl: "https://llm.chutes.ai/v1", keyUrl: "https://chutes.ai/app/api" },
  codex: { name: "OpenAI Codex", color: "#3B82F6", mark: "CX", format: "codex", auth: "oauth", keyUrl: "https://chatgpt.com/codex" },
  cohere: { name: "Cohere", color: "#39594D", mark: "CO", format: "openai", baseUrl: "https://api.cohere.ai/v1", keyUrl: "https://dashboard.cohere.com/api-keys" },
  dahl: { name: "Dahl Inference", color: "#1E40AF", mark: "DH", format: "openai", baseUrl: "https://inference.dahl.global/v1", keyUrl: "https://dahl.global/dashboard" },
  featherless: { name: "Featherless", color: "#111827", mark: "FL", format: "openai", baseUrl: "https://api.featherless.ai/v1", keyUrl: "https://featherless.ai/account/api-keys" },
  fireworks: { name: "Fireworks AI", color: "#7B2EF2", mark: "FW", format: "openai", baseUrl: "https://api.fireworks.ai/inference/v1", keyUrl: "https://fireworks.ai/account/api-keys" },
  "glm-cn": { name: "GLM (China)", color: "#DC2626", mark: "GC", format: "openai", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", keyUrl: "https://open.bigmodel.cn/usercenter/apikeys" },
  hyperbolic: { name: "Hyperbolic", color: "#00D4FF", mark: "HY", format: "openai", baseUrl: "https://api.hyperbolic.xyz/v1", keyUrl: "https://app.hyperbolic.xyz/settings" },
  "kilo-gateway": { name: "Kilo Gateway", color: "#8B5CF6", mark: "KG", format: "openai", baseUrl: "https://api.kilo.ai/api/gateway", keyUrl: "https://kilo.ai/dashboard?tab=apiKeys" },
  llm7: { name: "LLM7", color: "#7C3AED", mark: "L7", format: "openai", baseUrl: "https://api.llm7.io/v1", keyUrl: "https://llm7.io" },
  mistral: { name: "Mistral", color: "#FF7000", mark: "MI", format: "openai", baseUrl: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys" },
  morph: { name: "Morph", color: "#14B8A6", mark: "MP", format: "openai", baseUrl: "https://api.morphllm.com/v1", keyUrl: "https://morphllm.com" },
  nanobanana: { name: "NanoBanana API", color: "#FFD700", mark: "NN", format: "openai", baseUrl: "https://api.nanobananaapi.ai/v1", keyUrl: "https://nanobananaapi.ai/dashboard" },
  nebius: { name: "Nebius AI", color: "#6C5CE7", mark: "NB", format: "openai", baseUrl: "https://api.studio.nebius.ai/v1", keyUrl: "https://studio.nebius.com/settings/api-keys" },
  nvidia: { name: "NVIDIA NIM", color: "#76B900", mark: "NV", format: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", keyUrl: "https://build.nvidia.com/settings/api-keys" },
  perplexity: { name: "Perplexity", color: "#20808D", mark: "PP", format: "openai", baseUrl: "https://api.perplexity.ai", keyUrl: "https://www.perplexity.ai/settings/api" },
  poolside: { name: "Poolside", color: "#0EA5E9", mark: "PS", format: "openai", baseUrl: "https://inference.poolside.ai/v1", keyUrl: "https://platform.poolside.ai/api-keys" },
  runcrate: { name: "Runcrate", color: "#1A2B79", mark: "RC", format: "openai", baseUrl: "https://api.runcrate.ai/v1", modelsUrl: "https://www.runcrate.ai/api/v1/billing/balance", keyUrl: "https://www.runcrate.ai/dashboard/api-keys" },
  sambanova: { name: "SambaNova", color: "#F97316", mark: "SN", format: "openai", baseUrl: "https://api.sambanova.ai/v1", keyUrl: "https://cloud.sambanova.ai/apis" },
  sensenova: { name: "SenseNova", color: "#5B5CE2", mark: "SN", format: "openai", baseUrl: "https://token.sensenova.cn/v1", keyUrl: "https://token.sensenova.cn" },
  "sensenova-intl": { name: "SenseNova (Intl)", color: "#5B5CE2", mark: "SN", format: "openai", baseUrl: "https://token.sensenova.ai/v1", keyUrl: "https://platform.sensenova.ai" },
  siliconflow: { name: "SiliconFlow", color: "#5B6EF5", mark: "SF", format: "openai", baseUrl: "https://api.siliconflow.com/v1", keyUrl: "https://cloud.siliconflow.com/account/ak" },
  tencent: { name: "Tencent Hunyuan", color: "#0052D9", mark: "HY", format: "openai", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", keyUrl: "https://console.cloud.tencent.com/hunyuan/api-key" },
  together: { name: "Together AI", color: "#0F6FFF", mark: "TG", format: "openai", baseUrl: "https://api.together.xyz/v1", keyUrl: "https://api.together.xyz/settings/api-keys" },
  tokenharbor: { name: "Token Harbor", color: "#0F766E", mark: "TH", format: "openai", baseUrl: "https://tokenharbor.ai/v1", keyUrl: "https://tokenharbor.ai/dashboard" },
  tokenrouter: { name: "TokenRouter", color: "#0EA5E9", mark: "TR", format: "openai", baseUrl: "https://api.tokenrouter.com/v1", keyUrl: "https://www.tokenrouter.com" },
  venice: { name: "Venice AI", color: "#DC2626", mark: "VE", format: "openai", baseUrl: "https://api.venice.ai/api/v1", keyUrl: "https://venice.ai/settings/api" },
  "vercel-ai-gateway": { name: "Vercel AI Gateway", color: "#111827", mark: "VG", format: "openai", baseUrl: "https://ai-gateway.vercel.sh/v1", keyUrl: "https://vercel.com/dashboard/~/ai-gateway" },
  "volcengine-ark": { name: "Volcengine Ark", color: "#1677FF", mark: "ARK", format: "openai", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey" },
} as const satisfies Record<string, ProviderDef>;

export type ProviderId = keyof typeof PROVIDERS;
export const isProvider = (p: string): p is ProviderId => Object.hasOwn(PROVIDERS, p);
export const providerDef = (id: ProviderId): ProviderDef => PROVIDERS[id];

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

/** Whether the environment holds a key for the provider (for Anthropic: for at least one system). Never the key. */
export function hasEnvKey(env: Env, provider: ProviderId): boolean {
  const raw = provider === "anthropic" ? env.ANTHROPIC_KEYS : env.PROVIDER_KEYS;
  if (!raw) return false;
  try {
    const keys = JSON.parse(raw) as Record<string, unknown>;
    const usable = (k: unknown) => typeof k === "string" && k !== "";
    return provider === "anthropic" ? Object.values(keys).some(usable) : usable(keys[provider]);
  } catch {
    return false;
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

export const PATTERN = /^(\*|[a-z][a-z0-9-]*\/\*|[a-z][a-z0-9-]*\/[A-Za-z0-9._:\/@+-]{1,200})$/;

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
