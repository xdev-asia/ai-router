import { useState } from "react";
import { Badge, Banner, Button, Card, CodeBlock, Emblem, EmptyState, Grid, ResourceCard, SearchInput, Select, Stack } from "@xdev-asia/ui";
import { useLoad, type Combo } from "../api";
import { t, useLang, type StringKey } from "../i18n";
import { usePageHead } from "../shell";
import { ui } from "../ui-labels";
import { useHashParams } from "../url-state";
import { baseUrl } from "./Endpoint";

/**
 * CLI tools: a grid with one card per coding tool, each opening its own page (`#/cli-tools/<id>`)
 * with the manual settings pointing it at this gateway. A Worker cannot see the owner's machine, so the "installed" check is a command the owner runs;
 * every tool shows the settings to copy. The token is always the placeholder below, never a real one.
 */

export const TOKEN_PLACEHOLDER = "<your gateway token>";
const MODEL_PLACEHOLDER = "<model>";

type Format = "openai" | "anthropic" | "responses" | "gemini";

/** Where a snippet goes: a file path (shown as is), or a place named in the console's own words. */
interface Snippet {
  where: { path: string } | { key: StringKey };
  language: string;
  code: string;
}

interface Ctx {
  /** The console's origin, which serves the Anthropic paths (/v1/messages). */
  origin: string;
  /** `${origin}/v1`, the OpenAI base URL. */
  v1: string;
  model: string;
}

interface Tool {
  id: string;
  name: string;
  mark: string;
  format: Format;
  /** The tool's own docs or repository. */
  guide: string;
  /** A shell command, or where to get it when it is not a command. */
  install: { command: string } | { from: "extension" | "app" };
  /** The command that prints the installed version: the owner runs it, the gateway cannot see their machine. */
  check?: string;
  /** False: the settings shape is not confirmed by the tool's current docs; the page says so. */
  verified: boolean;
  snippets: (c: Ctx) => Snippet[];
}

const shell = (lines: string[]): Snippet => ({ where: { key: "cli.where.shell" }, language: "bash", code: lines.join("\n") });
const screen = (lines: string[]): Snippet => ({ where: { key: "cli.where.settings" }, language: "text", code: lines.join("\n") });
/** The "OpenAI Compatible" provider of Cline and Roo Code. */
const openAiCompatible = (c: Ctx): Snippet[] => [
  screen(["API Provider: OpenAI Compatible", `Base URL: ${c.v1}`, `API Key: ${TOKEN_PLACEHOLDER}`, `Model ID: ${c.model}`]),
];

// Each entry was checked against the guide it links on 2026-11-13.
export const TOOLS: Tool[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    mark: "CC",
    format: "anthropic",
    guide: "https://code.claude.com/docs/en/llm-gateway",
    install: { command: "curl -fsSL https://claude.ai/install.sh | bash" },
    check: "claude --version",
    verified: true,
    // ANTHROPIC_AUTH_TOKEN is sent as `Authorization: Bearer`, which the gateway takes (worker/auth.ts presentedToken).
    snippets: (c) => [shell([`export ANTHROPIC_BASE_URL="${c.origin}"`, `export ANTHROPIC_AUTH_TOKEN="${TOKEN_PLACEHOLDER}"`, `export ANTHROPIC_MODEL="${c.model}"`])],
  },
  {
    id: "codex",
    name: "Codex CLI",
    mark: "Cx",
    format: "responses",
    // `wire_api`: "responses is the only supported value" (Codex 0.95 removed chat/completions); the gateway
    // serves it at /v1/responses (worker/responses.ts). env_key names the variable Codex sends as the Bearer token.
    guide: "https://developers.openai.com/codex/config-reference",
    install: { command: "npm install -g @openai/codex" },
    check: "codex --version",
    verified: true,
    snippets: (c) => [
      {
        where: { path: "~/.codex/config.toml" },
        language: "toml",
        code: [
          `model = "${c.model}"`,
          `model_provider = "ai-router"`,
          ``,
          `[model_providers.ai-router]`,
          `name = "ai-router"`,
          `base_url = "${c.v1}"`,
          `env_key = "AI_ROUTER_TOKEN"`,
          `wire_api = "responses"`,
        ].join("\n"),
      },
      shell([`export AI_ROUTER_TOKEN="${TOKEN_PLACEHOLDER}"`]),
    ],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    mark: "Gm",
    format: "gemini",
    // GOOGLE_GEMINI_BASE_URL overrides the Gemini API base URL under gemini-api-key auth; it is the origin, the CLI
    // adds /v1beta/models/... (worker/gemini.ts serves it). The key goes in GEMINI_API_KEY.
    guide: "https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md",
    install: { command: "npm install -g @google/gemini-cli" },
    check: "gemini --version",
    verified: true,
    snippets: (c) => [
      shell([`export GOOGLE_GEMINI_BASE_URL="${c.origin}"`, `export GEMINI_API_KEY="${TOKEN_PLACEHOLDER}"`]),
      { where: { key: "cli.where.run" }, language: "bash", code: `gemini -m ${c.model}` },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    mark: "Oc",
    format: "openai",
    guide: "https://opencode.ai/docs/providers/",
    install: { command: "npm install -g @opencode/cli" },
    check: "opencode --version",
    verified: true,
    snippets: (c) => [
      {
        where: { path: "~/.config/opencode/opencode.json" },
        language: "json",
        code: JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            providers: {
              "ai-router": {
                name: "ai-router",
                env: ["AI_ROUTER_TOKEN"],
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: c.v1 },
                models: { [c.model]: { name: c.model } },
              },
            },
          },
          null,
          2,
        ),
      },
      shell([`export AI_ROUTER_TOKEN="${TOKEN_PLACEHOLDER}"`]),
    ],
  },
  {
    id: "cline",
    name: "Cline",
    mark: "Cl",
    format: "openai",
    guide: "https://docs.cline.bot/provider-config/openai-compatible",
    install: { from: "extension" },
    verified: true,
    snippets: openAiCompatible,
  },
  {
    id: "roo-code",
    name: "Roo Code",
    mark: "Rc",
    format: "openai",
    guide: "https://docs.roocode.com/providers/openai-compatible",
    install: { from: "extension" },
    verified: true,
    snippets: openAiCompatible,
  },
  {
    id: "kilo-code",
    name: "Kilo Code",
    mark: "Kc",
    format: "openai",
    guide: "https://kilo.ai/docs/ai-providers/openai-compatible",
    install: { from: "extension" },
    verified: true,
    snippets: (c) => [
      screen([
        "Settings › Providers › Custom provider",
        "Provider ID: ai-router",
        "Display name: ai-router",
        "Provider API: OpenAI Compatible",
        `Base URL: ${c.v1}`,
        `API key: ${TOKEN_PLACEHOLDER}`,
        `Models: ${c.model}`,
      ]),
    ],
  },
  {
    id: "continue",
    name: "Continue",
    mark: "Cn",
    format: "openai",
    guide: "https://docs.continue.dev/customize/model-providers/top-level/openai",
    install: { from: "extension" },
    verified: true,
    snippets: (c) => [
      {
        where: { path: "~/.continue/config.yaml" },
        language: "yaml",
        code: [
          `name: ai-router`,
          `version: 0.0.1`,
          `schema: v1`,
          `models:`,
          `  - name: ai-router`,
          `    provider: openai`,
          `    model: ${c.model}`,
          `    apiBase: ${c.v1}`,
          `    apiKey: ${TOKEN_PLACEHOLDER}`,
        ].join("\n"),
      },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    mark: "Cu",
    format: "openai",
    guide: "https://cursor.com/help/models-and-usage/api-keys",
    install: { from: "app" },
    // [Unverified] Cursor's own page names "Cursor Settings › Models" and an OpenAI key, but not the base URL override.
    verified: false,
    snippets: (c) => [screen(["Cursor Settings › Models", `OpenAI API Key: ${TOKEN_PLACEHOLDER}`, `Override OpenAI Base URL: ${c.v1}`, `Add model: ${c.model}`])],
  },
  {
    id: "aider",
    name: "Aider",
    mark: "Ai",
    format: "openai",
    guide: "https://aider.chat/docs/llms/openai-compat.html",
    install: { command: "python -m pip install aider-install && aider-install" },
    check: "aider --version",
    verified: true,
    snippets: (c) => [
      shell([`export OPENAI_API_BASE="${c.v1}"`, `export OPENAI_API_KEY="${TOKEN_PLACEHOLDER}"`]),
      { where: { key: "cli.where.run" }, language: "bash", code: `aider --model openai/${c.model}` },
    ],
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    mark: "Qw",
    format: "openai",
    guide: "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/",
    install: { command: "npm install -g @qwen-code/qwen-code@latest" },
    check: "qwen --version",
    verified: true,
    snippets: (c) => [shell([`export OPENAI_BASE_URL="${c.v1}"`, `export OPENAI_API_KEY="${TOKEN_PLACEHOLDER}"`, `export OPENAI_MODEL="${c.model}"`])],
  },
  {
    id: "goose",
    name: "Goose",
    mark: "Gs",
    format: "openai",
    guide: "https://goose-docs.ai/docs/getting-started/providers",
    install: { command: "curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash" },
    check: "goose --version",
    verified: true,
    // OPENAI_HOST is the origin with no path; OPENAI_BASE_PATH defaults to v1/chat/completions.
    snippets: (c) => [
      shell([`export GOOSE_PROVIDER="openai"`, `export OPENAI_HOST="${c.origin}"`, `export OPENAI_API_KEY="${TOKEN_PLACEHOLDER}"`, `export GOOSE_MODEL="${c.model}"`]),
    ],
  },
  {
    id: "crush",
    name: "Crush",
    mark: "Cr",
    format: "openai",
    guide: "https://github.com/charmbracelet/crush",
    install: { command: "npm install -g @charmland/crush" },
    check: "crush --version",
    verified: true,
    // crushrc replaces crush.json; type "completions" is the OpenAI-compatible Chat Completions API.
    snippets: (c) => [
      {
        where: { path: "~/.config/crush/crushrc" },
        language: "bash",
        code: [
          `provider add ai-router --type completions \\`,
          `  --base-url "${c.v1}" \\`,
          `  --api-key "$AI_ROUTER_TOKEN"`,
          `model add ai-router/${c.model} --name "${c.model}"`,
        ].join("\n"),
      },
      shell([`export AI_ROUTER_TOKEN="${TOKEN_PLACEHOLDER}"`]),
    ],
  },
  {
    id: "droid",
    name: "Factory Droid",
    mark: "Fd",
    format: "openai",
    guide: "https://docs.factory.com/cli/byok/overview",
    install: { command: "curl -fsSL https://app.factory.ai/cli | sh" },
    check: "droid --version",
    verified: true,
    snippets: (c) => [
      {
        where: { path: "~/.factory/settings.json" },
        language: "json",
        code: JSON.stringify(
          {
            customModels: [{ model: c.model, displayName: "ai-router", baseUrl: c.v1, apiKey: TOKEN_PLACEHOLDER, provider: "generic-chat-completion-api" }],
          },
          null,
          2,
        ),
      },
    ],
  },
  {
    id: "zed",
    name: "Zed",
    mark: "Zd",
    format: "openai",
    guide: "https://zed.dev/docs/ai/use-api-access",
    install: { from: "app" },
    verified: true,
    // Zed reads the key of provider "ai-router" from AI_ROUTER_API_KEY and asks never to put keys in settings.json.
    snippets: (c) => [
      {
        where: { path: "~/.config/zed/settings.json" },
        language: "json",
        code: JSON.stringify(
          { language_models: { openai_compatible: { "ai-router": { api_url: c.v1, available_models: [{ name: c.model, display_name: c.model, max_tokens: 128000 }] } } } },
          null,
          2,
        ),
      },
      shell([`export AI_ROUTER_API_KEY="${TOKEN_PLACEHOLDER}"`]),
    ],
  },
  {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    mark: "Gh",
    format: "openai",
    guide: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-llm-models",
    install: { command: "npm install -g @github/copilot" },
    check: "copilot --version",
    verified: true,
    // The default wireApi is "completions"; providers.json takes values as written, so the key goes in as is.
    snippets: (c) => [
      {
        where: { path: "~/.copilot/providers.json" },
        language: "json",
        code: JSON.stringify(
          { providers: [{ name: "ai-router", type: "openai", baseUrl: c.v1, apiKey: TOKEN_PLACEHOLDER }], models: [{ id: c.model, provider: "ai-router" }] },
          null,
          2,
        ),
      },
    ],
  },
  {
    id: "claude-cowork",
    name: "Claude Cowork",
    mark: "Cw",
    format: "anthropic",
    // Claude Desktop's third-party inference, "Gateway" provider: the base URL is the origin, the key goes as Bearer.
    guide: "https://claude.com/docs/cowork/3p/gateway",
    install: { from: "app" },
    // [Unverified] The guide names the keys but this console has not been tried behind it.
    verified: false,
    snippets: (c) => [
      screen(["Developer › Configure Third-Party Inference › Gateway", `Base URL: ${c.origin}`, `API key: ${TOKEN_PLACEHOLDER}`, "Auth scheme: bearer"]),
      {
        where: { key: "cli.where.managed" },
        language: "json",
        code: JSON.stringify(
          { inferenceProvider: "gateway", inferenceGatewayBaseUrl: c.origin, inferenceGatewayApiKey: TOKEN_PLACEHOLDER, inferenceGatewayAuthScheme: "bearer" },
          null,
          2,
        ),
      },
    ],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    mark: "Ow",
    format: "openai",
    guide: "https://docs.openclaw.ai/gateway/config-tools/custom-providers",
    install: { command: "curl -fsSL https://openclaw.ai/install.sh | bash" },
    check: "openclaw --version",
    verified: true,
    snippets: (c) => [
      {
        where: { path: "~/.openclaw/openclaw.json" },
        language: "json",
        code: JSON.stringify(
          {
            models: {
              mode: "merge",
              providers: { "ai-router": { baseUrl: c.v1, apiKey: TOKEN_PLACEHOLDER, api: "openai-completions", models: [{ id: c.model, name: c.model }] } },
            },
            agents: { defaults: { model: { primary: `ai-router/${c.model}` } } },
          },
          null,
          2,
        ),
      },
    ],
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    mark: "He",
    format: "openai",
    guide: "https://hermes-agent.nousresearch.com/docs/integrations/providers",
    install: { command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash" },
    check: "hermes --version",
    verified: true,
    // key_env names the variable holding the key, so the key stays out of the file.
    snippets: (c) => [
      {
        where: { path: "~/.hermes/config.yaml" },
        language: "yaml",
        code: [`model:`, `  default: ${c.model}`, `  provider: custom`, `  base_url: ${c.v1}`, `  key_env: AI_ROUTER_TOKEN`].join("\n"),
      },
      shell([`export AI_ROUTER_TOKEN="${TOKEN_PLACEHOLDER}"`]),
    ],
  },
  {
    id: "amp",
    name: "Amp",
    mark: "Am",
    format: "openai",
    guide: "https://ampcode.com/docs/customize/model-routing",
    install: { command: "curl -fsSL https://ampcode.com/install.sh | bash" },
    check: "amp version",
    verified: true,
    snippets: (c) => [
      screen([
        "Settings › Model Routing › Custom URL connection",
        "Format: chat-completions",
        `Base URL: ${c.v1}`,
        `Bearer token: ${TOKEN_PLACEHOLDER}`,
        `Route: <provider>/<model> -> ${c.model}`,
      ]),
    ],
  },
  {
    id: "grok-build",
    name: "Grok Build",
    mark: "Gk",
    format: "openai",
    guide: "https://docs.x.ai/build/settings/reference",
    install: { command: "curl -fsSL https://x.ai/cli/install.sh | bash" },
    check: "grok version",
    verified: true,
    snippets: (c) => [
      {
        where: { path: "~/.grok/config.toml" },
        language: "toml",
        code: [
          `[models]`,
          `default = "ai-router"`,
          ``,
          `[model.ai-router]`,
          `name = "ai-router"`,
          `model = "${c.model}"`,
          `base_url = "${c.v1}"`,
          `env_key = "AI_ROUTER_TOKEN"`,
          `api_backend = "chat_completions"`,
        ].join("\n"),
      },
      shell([`export AI_ROUTER_TOKEN="${TOKEN_PLACEHOLDER}"`]),
    ],
  },
  {
    id: "pi",
    name: "Pi",
    mark: "Pi",
    format: "openai",
    guide: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md",
    install: { command: "curl -fsSL https://pi.dev/install.sh | sh" },
    check: "pi --version",
    verified: true,
    snippets: (c) => [
      {
        where: { path: "~/.pi/agent/models.json" },
        language: "json",
        code: JSON.stringify(
          { providers: { "ai-router": { baseUrl: c.v1, api: "openai-completions", apiKey: TOKEN_PLACEHOLDER, models: [{ id: c.model }] } } },
          null,
          2,
        ),
      },
    ],
  },
  {
    id: "oh-my-pi",
    name: "Oh My Pi",
    mark: "Op",
    format: "openai",
    guide: "https://github.com/can1357/oh-my-pi",
    install: { command: "curl -fsSL https://omp.sh/install | sh" },
    check: "omp --version",
    verified: true,
    snippets: (c) => [
      {
        where: { path: "~/.omp/agent/models.yml" },
        language: "yaml",
        code: [
          `providers:`,
          `  ai-router:`,
          `    baseUrl: ${c.v1}`,
          `    api: openai-completions`,
          `    apiKey: "${TOKEN_PLACEHOLDER}"`,
          `    models:`,
          `      - id: ${c.model}`,
        ].join("\n"),
      },
      { where: { path: "~/.omp/agent/config.yml" }, language: "yaml", code: [`modelRoles:`, `  default: ai-router/${c.model}`].join("\n") },
    ],
  },
  {
    id: "codewhale",
    name: "CodeWhale",
    mark: "Wh",
    format: "openai",
    // Formerly DeepSeek TUI.
    guide: "https://github.com/codewhale-hq/Codewhale/blob/main/docs/PROVIDERS.md",
    install: { command: "npm install -g codewhale" },
    check: "codewhale --version",
    verified: true,
    snippets: (c) => [
      {
        where: { path: "~/.codewhale/config.toml" },
        language: "toml",
        code: [
          `provider = "ai-router"`,
          ``,
          `[providers.ai-router]`,
          `kind = "openai-compatible"`,
          `base_url = "${c.v1}"`,
          `api_key_env = "AI_ROUTER_TOKEN"`,
          `model = "${c.model}"`,
        ].join("\n"),
      },
      shell([`export AI_ROUTER_TOKEN="${TOKEN_PLACEHOLDER}"`]),
    ],
  },
  {
    id: "smelt",
    name: "Smelt",
    mark: "Sm",
    format: "openai",
    guide: "https://smeltagent.dev/latest/customize/providers/",
    install: { command: "curl -fsSL https://smeltagent.dev/install.sh | sh" },
    check: "smelt --version",
    // [Unverified] That this is the Smelt agent meant by the name.
    verified: false,
    snippets: (c) => [
      {
        where: { path: "~/.config/smelt/init.lua" },
        language: "lua",
        code: [
          `smelt.provider.register("ai-router", {`,
          `  type = "openai-compatible",`,
          `  api_base = "${c.v1}",`,
          `  api_key_env = "AI_ROUTER_TOKEN",`,
          `  models = { "${c.model}" },`,
          `})`,
          `smelt.defaults.set({ model = "ai-router/${c.model}" })`,
        ].join("\n"),
      },
      shell([`export AI_ROUTER_TOKEN="${TOKEN_PLACEHOLDER}"`]),
    ],
  },
  {
    id: "forgecode",
    name: "ForgeCode",
    mark: "Fg",
    format: "openai",
    guide: "https://github.com/tailcallhq/forgecode",
    install: { command: "curl -fsSL https://forgecode.dev/cli | sh" },
    check: "forge --version",
    // The docs mark the .env route as deprecated in favour of `forge provider login`.
    verified: false,
    snippets: (c) => [
      { where: { path: ".env" }, language: "bash", code: [`OPENAI_URL="${c.v1}"`, `OPENAI_API_KEY="${TOKEN_PLACEHOLDER}"`].join("\n") },
      { where: { path: "forge.yaml" }, language: "yaml", code: `model: ${c.model}` },
    ],
  },
  {
    id: "jcode",
    name: "jcode",
    mark: "Jc",
    format: "openai",
    guide: "https://jcode.sh/docs",
    install: { command: "curl -fsSL https://jcode.sh/install | bash" },
    verified: true,
    // The key goes in on stdin so it never sits in the shell history.
    snippets: (c) => [
      shell([`export AI_ROUTER_TOKEN="${TOKEN_PLACEHOLDER}"`]),
      {
        where: { key: "cli.where.once" },
        language: "bash",
        code: `printf '%s' "$AI_ROUTER_TOKEN" | jcode provider add ai-router --base-url "${c.v1}" --model "${c.model}" --api-key-stdin --set-default`,
      },
    ],
  },
];

/** Tools whose name contains the search text. */
export function filterTools(tools: Tool[], query: string): Tool[] {
  const q = query.trim().toLowerCase();
  return q ? tools.filter((tool) => tool.name.toLowerCase().includes(q)) : tools;
}

/** The snippets for a tool, pointed at this console's origin. */
export function toolSnippets(tool: Tool, origin: string, model: string): Snippet[] {
  const clean = origin.replace(/\/+$/, "");
  return tool.snippets({ origin: clean, v1: baseUrl(clean), model });
}

/**
 * MITM tools: they are pointed at the gateway by a proxy on the owner's machine that rewrites their
 * traffic. A Worker cannot run one there, so these are listed with a note and open nothing.
 */
export const MITM_TOOLS: { id: string; name: string; mark: string }[] = [
  { id: "antigravity", name: "Antigravity", mark: "Ag" },
  { id: "kiro", name: "Kiro", mark: "Ki" },
];

/**
 * The logo file (web/public/cli/) of each tool that has one.
 * Logo files from 9router (MIT); the logos are trademarks of their owners, used only to name the tool. See THIRD_PARTY_NOTICES.md.
 */
const LOGO: Record<string, "png" | "svg"> = {
  "claude-code": "png",
  codex: "png",
  "gemini-cli": "png",
  opencode: "png",
  cline: "png",
  "roo-code": "png",
  "kilo-code": "png",
  continue: "png",
  cursor: "png",
  crush: "png",
  droid: "png",
  zed: "png",
  "copilot-cli": "png",
  "qwen-code": "png",
  openclaw: "png",
  hermes: "png",
  amp: "png",
  "grok-build": "png",
  pi: "svg",
  "oh-my-pi": "png",
  codewhale: "svg",
  smelt: "svg",
  forgecode: "png",
  jcode: "png",
  antigravity: "png",
  kiro: "png",
};

/** The tool's logo, or undefined when there is none and the Emblem shows its letters. */
export const toolLogo = (tool: { id: string }): string | undefined => (LOGO[tool.id] ? `/cli/${tool.id}.${LOGO[tool.id]}` : undefined);

const FORMAT_LABEL: Record<Format, StringKey> = { openai: "cli.format.openai", anthropic: "cli.format.anthropic", responses: "cli.format.responses", gemini: "cli.format.gemini" };
const SPEAKS: Record<Format, StringKey> = { openai: "cli.speaks.openai", anthropic: "cli.speaks.anthropic", responses: "cli.speaks.responses", gemini: "cli.speaks.gemini" };

/** `#/cli-tools` shows the grid; `#/cli-tools/<id>` the tool's page (App passes the id, null on the grid). */
export function CliTools({ tool }: { tool: string | null }) {
  const found = tool ? TOOLS.find((x) => x.id === tool) : undefined;
  return found ? <CliToolPage key={found.id} tool={found} /> : <CliToolGrid />;
}

/** The search lives in the address (`#/cli-tools?q=claude`). */
const SEARCH_DEFAULT = { q: "" };

function CliToolGrid() {
  const [lang] = useLang();
  const [{ q: query }, setParams] = useHashParams("#/cli-tools", SEARCH_DEFAULT);
  const setQuery = (q: string) => setParams({ q });
  const shown = filterTools(TOOLS, query);

  return (
    <Stack gap={6}>
      <section className="providers-section" aria-labelledby="cli-tools-heading">
        <Stack direction="row" justify="between" gap={3}>
          <div className="providers-section-head">
            <h2 className="providers-section-title" id="cli-tools-heading">
              {t("cli.tools")}
            </h2>
            <span className="providers-section-count">{TOOLS.length}</span>
          </div>
          <SearchInput
            size="sm"
            placeholder={t("cli.find")}
            aria-label={t("cli.find")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery("")}
            count={query ? shown.length : undefined}
            labels={ui(lang).searchInput}
          />
        </Stack>
        {shown.length === 0 ? (
          <EmptyState
            icon="search"
            title={t("cli.noMatch", { q: query.trim() })}
            actions={<Button onClick={() => setQuery("")}>{t("cli.clearSearch")}</Button>}
          />
        ) : (
          <Grid minItemWidth="15rem" gap={3}>
            {shown.map((x) => (
              <ResourceCard
                key={x.id}
                href={`#/cli-tools/${x.id}`}
                leading={<Emblem name={x.name} text={x.mark} src={toolLogo(x)} />}
                title={x.name}
                status={t(FORMAT_LABEL[x.format])}
              />
            ))}
          </Grid>
        )}
      </section>
      <section className="providers-section" aria-labelledby="cli-mitm-heading">
        <div className="providers-section-head">
          <h2 className="providers-section-title" id="cli-mitm-heading">
            {t("cli.mitm")}
          </h2>
          <span className="providers-section-count">{MITM_TOOLS.length}</span>
        </div>
        <p className="providers-section-sub">{t("cli.mitmNote")}</p>
        <Grid minItemWidth="15rem" gap={3}>
          {MITM_TOOLS.map((x) => (
            <ResourceCard key={x.id} dimmed leading={<Emblem name={x.name} text={x.mark} src={toolLogo(x)} />} title={x.name} status={<Badge>MITM</Badge>} />
          ))}
        </Grid>
      </section>
    </Stack>
  );
}

function CliToolPage({ tool }: { tool: Tool }) {
  const [lang] = useLang();
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [combos] = useLoad<Combo[]>("/combos");

  usePageHead(
    { parent: { label: t("cli.title"), href: "#/cli-tools" }, title: tool.name, media: <Emblem name={tool.name} text={tool.mark} src={toolLogo(tool)} size="sm" /> },
    `${tool.id}|${lang}`,
  );

  const models = combos.status === "ready" ? combos.data.map((c) => `combo/${c.name}`) : [];
  const model = chosenModel !== null && models.includes(chosenModel) ? chosenModel : (models[0] ?? MODEL_PLACEHOLDER);

  return (
    <Stack gap={4}>
      <Banner tone="info" title={t("cli.notLocal")} />
      <Card title={t("cli.manual")} subtitle={t(SPEAKS[tool.format])} monoSubtitle headingLevel={2}>
        <Stack gap={4}>
          <p>
            {t("cli.step.token")} <a href="#/systems">{t("nav.systems")}</a>.
          </p>
          <Stack gap={2}>
            <label className="filter-field">
              <span>{t("cli.step.model")}</span>
              {models.length > 0 ? (
                <Select aria-label={t("cli.model")} value={model} onChange={(e) => setChosenModel(e.target.value)} options={models.map((m) => ({ value: m, label: m }))} />
              ) : null}
            </label>
            {models.length === 0 && combos.status !== "loading" ? <span className="muted">{t("cli.model.none")}</span> : null}
          </Stack>
          <p>{t("cli.step.config")}</p>
          {toolSnippets(tool, window.location.origin, model).map((s, i) => (
            <Stack key={i} gap={1}>
              <span className="muted">{"path" in s.where ? s.where.path : t(s.where.key)}</span>
              <CodeBlock code={s.code} language={s.language} labels={ui(lang).codeBlock} />
            </Stack>
          ))}
          {!tool.verified && <Banner tone="warn" title={t("cli.unverified")} />}
        </Stack>
      </Card>
      <Card title={t("cli.install")} headingLevel={2}>
        <Stack gap={3}>
          {"command" in tool.install ? (
            <CodeBlock code={tool.install.command} language="bash" labels={ui(lang).codeBlock} />
          ) : (
            <span className="muted">{t(tool.install.from === "extension" ? "cli.install.extension" : "cli.install.app")}</span>
          )}
          {tool.check ? (
            <Stack gap={1}>
              <span className="muted">{t("cli.check")}</span>
              <CodeBlock code={tool.check} language="bash" labels={ui(lang).codeBlock} />
            </Stack>
          ) : null}
          <div>
            <Button variant="link" icon="external" href={tool.guide} target="_blank" rel="noreferrer">
              {t("cli.guide")}
            </Button>
          </div>
        </Stack>
      </Card>
    </Stack>
  );
}
