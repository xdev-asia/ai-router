import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env";
import { CATALOG } from "./model-catalog";
import { COPILOT_HEADERS, MUSE_HEADERS } from "./oauth";
import type { Usage } from "./usage";

/** The Messages API version this gateway speaks when it builds an Anthropic request itself. */
export const ANTHROPIC_VERSION = "2023-06-01";

export interface ProviderDef {
  name: string;
  /** The provider's own colour and one to three letters, for its mark in the console. */
  color: string;
  mark: string;
  /**
   * "anthropic": the Messages API at ANTHROPIC_BASE_URL. "openai": Chat Completions at `baseUrl` + `/chat/completions`.
   * "codex": the ChatGPT Codex backend (worker/codex.ts). "cloudcode": Google's Cloud Code, Gemini CLI's and
   * Antigravity's endpoint (worker/cloudcode.ts).
   */
  format: "anthropic" | "openai" | "codex" | "cloudcode";
  /** "oauth": the provider is reached with a subscription login (worker/oauth.ts) instead of an API key. */
  auth?: "oauth";
  baseUrl?: string;
  /** Where a key is checked (a GET that needs the key). Default: `baseUrl` + `/models`. */
  modelsUrl?: string;
  /** The provider's page for creating a key, linked from the console. */
  keyUrl?: string;
  /** Headers sent with every chat request besides the key (GitHub Copilot: the editor it expects). */
  headers?: Readonly<Record<string, string>>;
  /**
   * Models the provider answers in another format, at another URL (worker/wire.ts): `anthropic` the Messages API
   * (the key in `x-api-key`), `responses` the OpenAI Responses API (a Bearer key). Other models use `format`.
   */
  lanes?: { anthropic?: { url: string; models: RegExp }; responses?: { url: string; models: RegExp } };
}

/**
 * Providers reached with their own API keys. Anthropic speaks Messages; the others speak OpenAI Chat Completions.
 * The first six are the gateway's original ones; the rest are plain OpenAI-compatible providers, with
 * the names, base URLs and key pages from an MIT-licensed registry at commit 54a88d04 (THIRD_PARTY_NOTICES.md). Only the first
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
  // Subscription login (oauth.ts, cloudcode.ts): using a Google account outside Antigravity may be against Google's terms.
  antigravity: { name: "Antigravity", color: "#F59E0B", mark: "AGY", format: "cloudcode", auth: "oauth", keyUrl: "https://antigravity.google" },
  atria: { name: "Atria Dawn", color: "#C2410C", mark: "AD", format: "openai", baseUrl: "https://api.atria-asi.ai/v1", keyUrl: "https://api.atria-asi.ai/dashboard" },
  bai: { name: "B.AI", color: "#0369A1", mark: "BA", format: "openai", baseUrl: "https://api.b.ai/v1", keyUrl: "https://b.ai" },
  baidu: { name: "Baidu Qianfan", color: "#2932E1", mark: "BD", format: "openai", baseUrl: "https://qianfan.baidubce.com/v2", keyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application" },
  bazaarlink: { name: "Bazaarlink", color: "#DC2626", mark: "BZ", format: "openai", baseUrl: "https://bazaarlink.ai/api/v1", keyUrl: "https://bazaarlink.ai" },
  blackbox: { name: "Blackbox AI", color: "#5B5FEF", mark: "BB", format: "openai", baseUrl: "https://api.blackbox.ai/v1", keyUrl: "https://www.blackbox.ai/api-management" },
  bluesminds: { name: "BluesMinds", color: "#2563EB", mark: "BM", format: "openai", baseUrl: "https://api.bluesminds.com/v1", keyUrl: "https://bluesminds.com" },
  byteplus: { name: "BytePlus ModelArk", color: "#2563EB", mark: "BP", format: "openai", baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3", keyUrl: "https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey" },
  cerebras: { name: "Cerebras", color: "#FF4F00", mark: "CB", format: "openai", baseUrl: "https://api.cerebras.ai/v1", keyUrl: "https://cloud.cerebras.ai/platform" },
  chutes: { name: "Chutes AI", color: "#FFFFFF", mark: "CH", format: "openai", baseUrl: "https://llm.chutes.ai/v1", keyUrl: "https://chutes.ai/app/api" },
  // Subscription logins (oauth.ts): using a subscription outside the vendor's own app may be against its terms.
  claude: { name: "Claude Code", color: "#D97757", mark: "CC", format: "anthropic", auth: "oauth", baseUrl: "https://api.anthropic.com", keyUrl: "https://claude.ai/settings/billing" },
  codex: { name: "OpenAI Codex", color: "#3B82F6", mark: "CX", format: "codex", auth: "oauth", keyUrl: "https://chatgpt.com/codex" },
  cohere: { name: "Cohere", color: "#39594D", mark: "CO", format: "openai", baseUrl: "https://api.cohere.ai/v1", keyUrl: "https://dashboard.cohere.com/api-keys" },
  dahl: { name: "Dahl Inference", color: "#1E40AF", mark: "DH", format: "openai", baseUrl: "https://inference.dahl.global/v1", keyUrl: "https://dahl.global/dashboard" },
  featherless: { name: "Featherless", color: "#111827", mark: "FL", format: "openai", baseUrl: "https://api.featherless.ai/v1", keyUrl: "https://featherless.ai/account/api-keys" },
  fireworks: { name: "Fireworks AI", color: "#7B2EF2", mark: "FW", format: "openai", baseUrl: "https://api.fireworks.ai/inference/v1", keyUrl: "https://fireworks.ai/account/api-keys" },
  // Subscription login (oauth.ts, cloudcode.ts): using a Google account outside Gemini CLI may be against Google's terms.
  "gemini-cli": { name: "Gemini CLI", color: "#4285F4", mark: "GCL", format: "cloudcode", auth: "oauth", keyUrl: "https://github.com/google-gemini/gemini-cli" },
  // Subscription login (oauth.ts): using a subscription outside the vendor's own app may be against its terms.
  github: { name: "GitHub Copilot", color: "#333333", mark: "GH", format: "openai", auth: "oauth", baseUrl: "https://api.githubcopilot.com", headers: COPILOT_HEADERS, keyUrl: "https://github.com/settings/copilot" },
  "glm-cn": { name: "GLM (China)", color: "#DC2626", mark: "GC", format: "openai", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", keyUrl: "https://open.bigmodel.cn/usercenter/apikeys" },
  hyperbolic: { name: "Hyperbolic", color: "#00D4FF", mark: "HY", format: "openai", baseUrl: "https://api.hyperbolic.xyz/v1", keyUrl: "https://app.hyperbolic.xyz/settings" },
  "kilo-gateway": { name: "Kilo Gateway", color: "#8B5CF6", mark: "KG", format: "openai", baseUrl: "https://api.kilo.ai/api/gateway", keyUrl: "https://kilo.ai/dashboard?tab=apiKeys" },
  // Subscription login (oauth.ts): using a subscription outside the vendor's own app may be against its terms.
  kilocode: { name: "Kilo Code", color: "#FF6B35", mark: "KC", format: "openai", auth: "oauth", baseUrl: "https://api.kilo.ai/api/openrouter", keyUrl: "https://kilo.ai" },
  // Subscription login (oauth.ts): using a subscription outside the vendor's own app may be against its terms.
  kimi: { name: "Kimi Code", color: "#1E3A8A", mark: "KM", format: "openai", auth: "oauth", baseUrl: "https://api.kimi.com/coding/v1", keyUrl: "https://www.kimi.com/code" },
  llm7: { name: "LLM7", color: "#7C3AED", mark: "L7", format: "openai", baseUrl: "https://api.llm7.io/v1", keyUrl: "https://llm7.io" },
  mistral: { name: "Mistral", color: "#FF7000", mark: "MI", format: "openai", baseUrl: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys" },
  morph: { name: "Morph", color: "#14B8A6", mark: "MP", format: "openai", baseUrl: "https://api.morphllm.com/v1", keyUrl: "https://morphllm.com" },
  // Subscription login (oauth.ts): using a subscription outside the vendor's own app may be against its terms.
  // Muse Spark answers only on the Responses API.
  muse: {
    name: "Muse (Meta)", color: "#0866FF", mark: "MU", format: "openai", auth: "oauth", baseUrl: "https://api.meta.ai/v1", headers: MUSE_HEADERS, keyUrl: "https://muse.ai",
    lanes: { responses: { url: "https://api.meta.ai/v1/responses", models: /^muse-spark-/ } },
  },
  nanobanana: { name: "NanoBanana API", color: "#FFD700", mark: "NN", format: "openai", baseUrl: "https://api.nanobananaapi.ai/v1", keyUrl: "https://nanobananaapi.ai/dashboard" },
  nebius: { name: "Nebius AI", color: "#6C5CE7", mark: "NB", format: "openai", baseUrl: "https://api.studio.nebius.ai/v1", keyUrl: "https://studio.nebius.com/settings/api-keys" },
  // Subscription login (oauth.ts): using a subscription outside the vendor's own app may be against its terms.
  nous: { name: "Nous Research", color: "#7C3AED", mark: "NR", format: "openai", auth: "oauth", baseUrl: "https://inference-api.nousresearch.com/v1", keyUrl: "https://portal.nousresearch.com" },
  nvidia: { name: "NVIDIA NIM", color: "#76B900", mark: "NV", format: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", keyUrl: "https://build.nvidia.com/settings/api-keys" },
  perplexity: { name: "Perplexity", color: "#20808D", mark: "PP", format: "openai", baseUrl: "https://api.perplexity.ai", keyUrl: "https://www.perplexity.ai/settings/api" },
  // Free, OpenAI-compatible. Anonymous works with any key; a free key from auth.pollinations.ai raises the limit.
  pollinations: { name: "Pollinations", color: "#D6409F", mark: "PL", format: "openai", baseUrl: "https://text.pollinations.ai/openai", keyUrl: "https://auth.pollinations.ai" },
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
  // Ported from an open-source registry and executors (worker/wire.ts): some models in another format (`lanes`), or an
  // endpoint named by the connection's settings (Azure, Cloudflare, Bedrock, Vertex). Untested against the live services.
  "opencode-go": {
    name: "OpenCode Go", color: "#E87040", mark: "OC", format: "openai", baseUrl: "https://opencode.ai/inference/go/openai/v1", keyUrl: "https://opencode.ai/auth",
    lanes: { anthropic: { url: "https://opencode.ai/inference/go/anthropic/v1/messages", models: /^claude-/ }, responses: { url: "https://opencode.ai/inference/go/openai/v1/responses", models: /^(grok-|gpt-|muse-spark-)/ } },
  },
  "opencode-zen": {
    name: "OpenCode Zen", color: "#E87040", mark: "OZ", format: "openai", baseUrl: "https://opencode.ai/zen/v1", keyUrl: "https://opencode.ai/auth",
    lanes: { anthropic: { url: "https://opencode.ai/zen/v1/messages", models: /^claude-/ }, responses: { url: "https://opencode.ai/zen/v1/responses", models: /^(grok-|gpt-|muse-spark-)/ } },
  },
  synthetic: { name: "Synthetic", color: "#111827", mark: "SY", format: "openai", baseUrl: "https://api.synthetic.new/openai/v1", keyUrl: "https://synthetic.new/user-settings/api" },
  "xiaomi-tokenplan": { name: "Xiaomi MiMo (Token Plan)", color: "#FF6700", mark: "XT", format: "openai", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", keyUrl: "https://mimo.xiaomi.com" },
  "api-airforce": { name: "API.airforce", color: "#0EA5E9", mark: "AF", format: "openai", baseUrl: "https://api.airforce/v1", keyUrl: "https://api.airforce" },
  kimchi: { name: "Kimchi", color: "#FF521D", mark: "KC", format: "openai", baseUrl: "https://llm.kimchi.dev/openai/v1", headers: { "user-agent": "kimchi/0.1.50" }, keyUrl: "https://app.kimchi.dev" },
  minimax: {
    name: "Minimax Coding", color: "#7C3AED", mark: "MM", format: "openai", baseUrl: "https://api.minimax.io/v1", keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    lanes: { anthropic: { url: "https://api.minimax.io/anthropic/v1/messages?beta=true", models: /^MiniMax-M3$/ } },
  },
  // Subscription login (oauth.ts): using a subscription outside the vendor's own app may be against its terms.
  // MiniMax's agent gateway; the route adds /v1/messages.
  "minimax-code": { name: "MiniMax Code", color: "#FF4D4F", mark: "MMC", format: "anthropic", auth: "oauth", baseUrl: "https://agent.minimax.cn/mavis/api/v1/llm", keyUrl: "https://agent.minimax.cn" },
  // Subscription login (oauth.ts): using a subscription outside the vendor's own app may be against its terms.
  "minimax-code-global": { name: "MiniMax Code (Global)", color: "#FF4D4F", mark: "MMG", format: "anthropic", auth: "oauth", baseUrl: "https://agent.minimax.io/mavis/api/v1/llm", keyUrl: "https://agent.minimax.io" },
  "minimax-cn": {
    name: "Minimax (China)", color: "#DC2626", mark: "MC", format: "openai", baseUrl: "https://api.minimaxi.com/v1", keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    lanes: { anthropic: { url: "https://api.minimaxi.com/anthropic/v1/messages?beta=true", models: /^MiniMax-M3$/ } },
  },
  "perplexity-agent": {
    name: "Perplexity Agent", color: "#20808D", mark: "PA", format: "openai", baseUrl: "https://api.perplexity.ai", keyUrl: "https://www.perplexity.ai/settings/api",
    lanes: { responses: { url: "https://api.perplexity.ai/v1/responses", models: /./ } },
  },
  ollama: { name: "Ollama Cloud", color: "#FFFFFF", mark: "OL", format: "openai", baseUrl: "https://ollama.com/v1", keyUrl: "https://ollama.com/settings/keys" },
  "cloudflare-ai": { name: "Cloudflare", color: "#F38020", mark: "CF", format: "openai", keyUrl: "https://dash.cloudflare.com/profile/api-tokens" },
  azure: { name: "Azure OpenAI", color: "#0078D4", mark: "AZ", format: "openai", keyUrl: "https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI" },
  bedrock: { name: "AWS Bedrock", color: "#FF9900", mark: "BR", format: "anthropic", keyUrl: "https://console.aws.amazon.com/iam/home#/security_credentials" },
  "bedrock-xai": { name: "AWS Bedrock (xAI)", color: "#FF9900", mark: "BX", format: "openai", keyUrl: "https://console.aws.amazon.com/iam/home#/security_credentials" },
  vertex: { name: "Vertex AI", color: "#4285F4", mark: "VX", format: "openai", keyUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts" },
  "vertex-partner": { name: "Vertex Partner", color: "#34A853", mark: "VP", format: "openai", keyUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts" },
} as const satisfies Record<string, ProviderDef>;

export type BuiltinProviderId = keyof typeof PROVIDERS;
/** A built-in provider, or one the owner added (custom-providers.ts); `isProvider` tells which ids exist now. */
export type ProviderId = BuiltinProviderId | (string & {});
export const isBuiltinProvider = (p: string): p is BuiltinProviderId => Object.hasOwn(PROVIDERS, p);

/** A provider the owner added in the console (table custom_provider): an OpenAI- or Anthropic-compatible endpoint. */
export interface CustomProviderRow {
  id: string;
  name: string;
  format: "openai" | "anthropic";
  /** https, no trailing slash. "openai": includes the version path (`…/v1`); "anthropic": the host, as ANTHROPIC_BASE_URL. */
  base_url: string;
}

// Neutral colours for the owner's providers, picked by id so a provider keeps its colour.
const CUSTOM_COLORS = ["#64748B", "#0EA5E9", "#8B5CF6", "#14B8A6", "#F59E0B", "#EC4899", "#22C55E", "#6366F1"];
const customColor = (id: string) => CUSTOM_COLORS[[...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % CUSTOM_COLORS.length]!;
const customMark = (name: string) => {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const m = words.length > 1 ? words.slice(0, 2).map((w) => [...w][0]).join("") : [...(words[0] ?? "?")].slice(0, 2).join("");
  return m.toUpperCase();
};

/**
 * The owner's providers, read from D1 by `withCustomProviders` (custom-providers.ts) at the start of each gateway
 * and admin request, so the synchronous lookups below (isProvider, providerDef, parseModel) see them. Each request
 * keeps its own map (AsyncLocalStorage), so requests running at once in one isolate never see each other's read.
 * Outside a request (a stream callback the store does not reach) the last map read is used.
 */
let lastRead: ReadonlyMap<string, ProviderDef> = new Map();
const perRequest = new AsyncLocalStorage<ReadonlyMap<string, ProviderDef>>();
const customMap = (): ReadonlyMap<string, ProviderDef> => perRequest.getStore() ?? lastRead;

function toMap(rows: readonly CustomProviderRow[]): ReadonlyMap<string, ProviderDef> {
  return new Map(
    rows
      .filter((r) => !isBuiltinProvider(r.id) && !BUILTIN_PREFIXES.has(r.id))
      .map((r) => [r.id, { name: r.name, color: customColor(r.id), mark: customMark(r.name), format: r.format, baseUrl: r.base_url } satisfies ProviderDef]),
  );
}

/** Replaces the map: for this request's lookups when called inside `runWithCustomProviders`, else the fallback. */
export function setCustomProviders(rows: readonly CustomProviderRow[]): void {
  const map = toMap(rows);
  lastRead = map;
  const store = perRequest.getStore() as Map<string, ProviderDef> | undefined;
  if (store) {
    store.clear();
    for (const [k, v] of map) store.set(k, v);
  }
}

/** Runs `fn` with `rows` as the custom providers every lookup inside it sees. */
export function runWithCustomProviders<T>(rows: readonly CustomProviderRow[], fn: () => T): T {
  const map = toMap(rows);
  lastRead = map;
  return perRequest.run(new Map(map), fn);
}

export const isCustomProvider = (p: string): boolean => customMap().has(p);
/** Built-in ids first (the first six as written, the others by id), then the owner's. */
const BUILTIN_IDS = ((ids: string[]) => [...ids.slice(0, 6), ...ids.slice(6).sort()])(Object.keys(PROVIDERS));
export const providerIds = (): ProviderId[] => [...BUILTIN_IDS, ...customMap().keys()];

export const isProvider = (p: string): p is ProviderId => isBuiltinProvider(p) || customMap().has(p);
export function providerDef(id: ProviderId): ProviderDef {
  const def = isBuiltinProvider(id) ? PROVIDERS[id] : customMap().get(id);
  if (!def) throw new Error(`unknown provider ${id}`);
  return def;
}

/** Where an Anthropic-format provider's Messages API lives, with no trailing slash and no `/v1`. */
export const anthropicBase = (env: Env, provider: ProviderId): string =>
  (provider === "anthropic" ? env.ANTHROPIC_BASE_URL : (providerDef(provider).baseUrl ?? "")).replace(/\/+$/, "");

/** Providers that give a key with free use; the console lists them apart, as good last steps in a Fallback combo. */
// Checked 2026-11-13 (free tiers change; check again before relying on this):
//   groq       https://console.groq.com/docs/rate-limits (Free Plan limits)
//   gemini     https://aistudio.google.com/docs/pricing (Free Tier, "Free of charge" models)
//   openrouter https://openrouter.ai/docs/api/reference/limits (":free" models, 50 req/day with no credits bought)
//   sambanova  https://docs.sambanova.ai/docs/en/models/rate-limits (Free Tier when no payment method is linked)
// Left out: cerebras (https://inference-docs.cerebras.ai/support/rate-limits: a 30-day trial credit only, needs a payment method)
//   and mistral (https://docs.mistral.ai/admin/billing-usage/usage-limits: Free mode has no API access).
// From an open-source provider registry (category "freeTier"), not checked against the providers' pages:
//   api-airforce, kimchi, cloudflare-ai, ollama, vertex.
// Checked live 2026-11-28, keyless: pollinations (OpenAI-compatible; the anonymous tier is 1 reply/45s per IP, a
//   free key from auth.pollinations.ai raises it — a good last step in a Fallback combo).
export const FREE_TIER: ReadonlySet<ProviderId> = new Set<ProviderId>(["groq", "gemini", "openrouter", "sambanova", "pollinations", "api-airforce", "kimchi", "cloudflare-ai", "ollama", "vertex"]);

export type Target = { provider: ProviderId; model: string };
export type ModelRef = { kind: "target"; target: Target } | { kind: "combo"; name: string };

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/@+_-]{0,199}$/;
/** A combo name: letters, numbers, `_`, `.` and `-` (FR-CMB-01), starting with a letter or number, at most 64. */
export const COMBO_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** A model name's shape: what parseModel and a bare name (models.ts) accept, after the markers are taken off. */
export const isModelName = (raw: unknown): raw is string => typeof raw === "string" && MODEL.test(raw);

/** The prefix before "/" to a provider: its id, or its short alias (`cx` for codex, FR-MDL-01). */
const PREFIXES: ReadonlyMap<string, ProviderId> = new Map<string, ProviderId>([
  ...Object.entries(CATALOG).map(([p, c]) => [c!.alias, p as ProviderId] as const),
  // Ids last, so an id always names its own provider.
  ...(Object.keys(PROVIDERS) as ProviderId[]).map((p) => [p, p] as const),
]);
/** Prefixes a custom provider's id may not take: the built-in ids, their aliases and `combo`. */
export const BUILTIN_PREFIXES: ReadonlySet<string> = new Set([...PREFIXES.keys(), "combo"]);
export const providerOfPrefix = (prefix: string): ProviderId | null => PREFIXES.get(prefix) ?? (customMap().has(prefix) ? prefix : null);
/** The prefix /v1/models names a provider's models with: its short alias, or the id. */
export const aliasOf = (p: ProviderId): string => CATALOG[p]?.alias ?? p;

/**
 * `claude-*` (no prefix) and `anthropic/<model>` are Claude; `<provider>/<model>` another provider, where the prefix
 * is the provider id or its alias (the model may itself contain "/", as OpenRouter's do); `combo/<name>` a fallback
 * list. Null when it is none of these. A bare name (no "/") that is a combo or an alias needs the database, so
 * route.ts checks those before calling this (FR-CMB-03, FR-MDL-02).
 */
export function parseModel(raw: unknown): ModelRef | null {
  if (!isModelName(raw)) return null;
  const i = raw.indexOf("/");
  if (i < 0) return raw.startsWith("claude-") ? { kind: "target", target: { provider: "anthropic", model: raw } } : null;
  const head = raw.slice(0, i);
  const rest = raw.slice(i + 1);
  if (!rest) return null;
  if (head === "combo") return COMBO_NAME.test(rest) ? { kind: "combo", name: rest } : null;
  const provider = providerOfPrefix(head);
  return provider ? { kind: "target", target: { provider, model: rest } } : null;
}

export const targetName = (t: Target) => `${t.provider}/${t.model}`;

/**
 * Flattens combo `name` into its targets, in order. A member is `provider/model`, `claude-*`, `combo/<name>` or
 * the bare name of another combo; a nested combo is expanded in place. Each combo is expanded at most once per
 * call, so a loop (a combo that reaches itself) stops instead of recursing (FR-CMB-04). Repeated targets are kept
 * once, at their first place. Members that name nothing are skipped.
 */
export function expandCombo(combos: ReadonlyMap<string, readonly string[]>, name: string, seen = new Set<string>()): Target[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const out: Target[] = [];
  const have = new Set<string>();
  for (const m of combos.get(name) ?? []) {
    const ref: ModelRef | null = !m.includes("/") && combos.has(m) ? { kind: "combo", name: m } : parseModel(m);
    const found = ref === null ? [] : ref.kind === "combo" ? expandCombo(combos, ref.name, seen) : [ref.target];
    for (const t of found) {
      if (have.has(targetName(t))) continue;
      have.add(targetName(t));
      out.push(t);
    }
  }
  return out;
}

/** The combo a member names (`combo/<name>`, or a bare name that is a combo in `known`), else null. */
export function memberCombo(member: string, known: ReadonlySet<string> | ReadonlyMap<string, unknown>): string | null {
  if (member.startsWith("combo/")) return member.slice(6);
  return !member.includes("/") && known.has(member) ? member : null;
}

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

export const PATTERN = /^(\*|[a-z][a-z0-9-]*\/\*|[a-z][a-z0-9-]*\/[A-Za-z0-9._:\/@+_-]{1,200})$/;

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
