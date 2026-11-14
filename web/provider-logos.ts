/**
 * Providers that have a logo file in `public/providers/`: an SVG, or a 128 px PNG where no SVG exists. A provider
 * without a file shows its letters instead.
 * SVG logos from @lobehub/icons-static-svg (MIT); PNG logos from 9router (MIT). The logos are trademarks of their
 * owners, used only to name the provider. See THIRD_PARTY_NOTICES.md.
 */
const SVG: ReadonlySet<string> = new Set([
  "anthropic",
  "antigravity",
  "azure",
  "baidu",
  "bedrock",
  "bedrock-xai",
  "byteplus",
  "cerebras",
  "chutes",
  "claude",
  "cloudflare-ai",
  "codex",
  "cohere",
  "deepseek",
  "featherless",
  "fireworks",
  "gemini",
  "gemini-cli",
  "github",
  "glm-cn",
  "groq",
  "hyperbolic",
  "kilocode",
  "kimi",
  "minimax",
  "minimax-cn",
  "minimax-code",
  "minimax-code-global",
  "mistral",
  "morph",
  "nanobanana",
  "nebius",
  "nous",
  "nvidia",
  "ollama",
  "openai",
  "opencode-go",
  "opencode-zen",
  "openrouter",
  "perplexity",
  "perplexity-agent",
  "poolside",
  "sambanova",
  "sensenova",
  "sensenova-intl",
  "siliconflow",
  "tencent",
  "together",
  "venice",
  "vercel-ai-gateway",
  "vertex",
  "vertex-partner",
  "volcengine-ark",
  "xiaomi-tokenplan",
]);

const PNG: ReadonlySet<string> = new Set([
  "agnes",
  "alicode",
  "alicode-intl",
  "alims-intl",
  "alitp-intl",
  "atria",
  "bai",
  "bazaarlink",
  "blackbox",
  "bluesminds",
  "dahl",
  "kilo-gateway",
  "llm7",
  "tokenharbor",
  "tokenrouter",
]);

/** The logo's address for a provider id, or null when there is no file for it. */
export const providerLogo = (id: string): string | null =>
  SVG.has(id) ? `/providers/${id}.svg` : PNG.has(id) ? `/providers/${id}.png` : null;

/** Tools and apps a system is often named after, the words that name them, and their logo (the CLI tools' own files). */
const CLIENTS: ReadonlyArray<readonly [pattern: RegExp, file: string]> = [
  [/\bclaude\b/, "/cli/claude-code.png"],
  [/\bcursor\b/, "/cli/cursor.png"],
  [/\bcodex\b/, "/cli/codex.png"],
  [/\bcline\b/, "/cli/cline.png"],
  [/\bopen ?code\b/, "/cli/opencode.png"],
  [/\bcopilot\b/, "/cli/copilot-cli.png"],
  [/\bgemini\b/, "/cli/gemini-cli.png"],
  [/\broo\b/, "/cli/roo-code.png"],
  [/\bkilo\b/, "/cli/kilo-code.png"],
  [/\bkiro\b/, "/cli/kiro.png"],
  [/\bqwen\b/, "/cli/qwen-code.png"],
  [/\bzed\b/, "/cli/zed.png"],
  [/\bcontinue\b/, "/cli/continue.png"],
  [/\bantigravity\b/, "/cli/antigravity.png"],
  [/\bn8n\b/, "/clients/n8n.svg"],
];

/** A logo for a system whose name says which tool it is ("Claude Code", "n8n flows"), or null. */
export function clientLogo(name: string): string | null {
  const n = name.toLowerCase();
  return CLIENTS.find(([re]) => re.test(n))?.[1] ?? null;
}
