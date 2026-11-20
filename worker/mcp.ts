/**
 * A Model Context Protocol server at POST /mcp (Streamable HTTP, stateless, JSON answers only), so any AI client can
 * check and change this gateway: Claude Code, Codex, Cursor and others. Every tool calls the admin API
 * (`adminRoutes`) with the caller's admin token, so validation and answers are the console's own.
 *
 * Nothing that carries or returns a secret is a tool: adding a key, signing in to a provider, creating a system or
 * turning its token (both return the token), SSO, proxy pools, media and web-tool keys, backup import. The Headroom
 * address is left out too: it receives every conversation, so an AI talked into changing it could send them away.
 * Those stay in the console.
 */
import { Hono, type Context } from "hono";
import { isAdmin } from "./auth";
import { STRATEGIES } from "./combo-strategy";
import type { AppEnv } from "./env";
import { ALL, allows, mcpTokenAccess, type Group, type Scopes } from "./mcp-tokens";

type Json = Record<string, unknown>;
type Schema = Json;

/** Newest first: the first one is offered when the client asks for one this server does not know. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS =
  "ai-router is an LLM gateway: systems (callers with a token), providers and their connections (accounts), combos (ordered model lists), " +
  "models, aliases, usage and settings. Read before you change: list_* and get_* tools are safe. Models are named provider/model, claude-*, " +
  "combo/<name> or an alias. API keys, provider sign-ins and new systems are added by the owner in the console, not here.";

interface Call {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Json;
}

interface Tool {
  name: string;
  /** The group whose level a token needs (mcp-tokens.ts); none: any token may use it. */
  group?: Group;
  description: string;
  properties?: Record<string, Schema>;
  required?: string[];
  readOnly: boolean;
  destructive?: boolean;
  /** Sends a request to a provider (a test). */
  openWorld?: boolean;
  /** One admin call, or several whose answers are merged into one object. */
  calls: (a: Json) => Call | Record<string, Call>;
}

const str = { type: "string" } as const;
const strs = { type: "array", items: { type: "string" } } as const;
const bool = { type: "boolean" } as const;
const int = { type: "integer" } as const;
const num = { type: "number" } as const;
const level = { type: ["string", "null"], enum: ["lite", "full", "ultra", null] } as const;

const enc = encodeURIComponent;
const query = (a: Json, keys: string[]) => {
  const p = new URLSearchParams();
  for (const k of keys) if (a[k] !== undefined && a[k] !== null && a[k] !== "") p.set(k, String(a[k]));
  const s = p.toString();
  return s ? `?${s}` : "";
};
/** `a` with only `keys` (those present). */
const pick = (a: Json, keys: string[]): Json => Object.fromEntries(keys.filter((k) => k in a).map((k) => [k, a[k]]));

const TOOLS: Tool[] = [
  // ---- Read ------------------------------------------------------------------------------------------------------
  {
    name: "get_status",
    description: "The gateway's build (version, built_at) and what is set up: admin token, xDev ID sign-in, connections key, Codex relay.",
    readOnly: true,
    calls: () => ({ build: { method: "GET", path: "/__build" }, setup: { method: "GET", path: "/settings/info" } }),
  },
  {
    name: "list_systems",
    group: "systems",
    description: "Systems: the callers of the gateway, each with its own token (never shown), monthly token cap, allow-list of models (null: Claude only) and savers.",
    readOnly: true,
    calls: () => ({ method: "GET", path: "/systems" }),
  },
  {
    name: "list_providers",
    group: "connections",
    description: "Providers the gateway can reach: id, name, format, auth (api_key or oauth), whether the environment holds a key, and the account strategy.",
    readOnly: true,
    calls: () => ({ method: "GET", path: "/providers" }),
  },
  {
    name: "list_connections",
    group: "connections",
    description: "Connections (provider accounts) by provider and priority: name, auth type, last 4 characters of the key (hint), disabled, cooldown and last error. Never a key.",
    readOnly: true,
    calls: () => ({ method: "GET", path: "/connections" }),
  },
  {
    name: "test_connection",
    group: "connections",
    description: "Asks the provider for its model list with one connection's key and reports {ok} or {ok: false, status, message}.",
    properties: { id: { ...str, description: "Connection id (list_connections)" } },
    required: ["id"],
    readOnly: true,
    openWorld: true,
    calls: (a) => ({ method: "POST", path: `/connections/${enc(String(a.id))}/test` }),
  },
  {
    name: "list_combos",
    group: "combos",
    description: "Combos: name, ordered targets (provider/model, claude-*, or other combos), strategy and its settings.",
    readOnly: true,
    calls: () => ({ method: "GET", path: "/combos" }),
  },
  {
    name: "list_models",
    group: "models",
    description: "One provider's models: catalog and custom ones, which are disabled, context sizes, thinking modes and the provider's thinking mode.",
    properties: { provider: { ...str, description: "Provider id (list_providers)" } },
    required: ["provider"],
    readOnly: true,
    calls: (a) => ({ method: "GET", path: `/providers/${enc(String(a.provider))}/models` }),
  },
  {
    name: "list_aliases",
    group: "models",
    description: "Model aliases: a short name and the provider/model (or combo) it stands for.",
    readOnly: true,
    calls: () => ({ method: "GET", path: "/models/aliases" }),
  },
  {
    name: "test_model",
    group: "models",
    description: 'Sends "hi" to a model (or combo) with the gateway\'s own keys and reports whether it answered and how fast. No usage row.',
    properties: { model: { ...str, description: "provider/model, claude-*, combo/<name> or an alias" } },
    required: ["model"],
    readOnly: true,
    openWorld: true,
    calls: (a) => ({ method: "POST", path: "/models/test", body: { model: a.model } }),
  },
  {
    name: "usage_summary",
    group: "usage",
    description: "Token and cost totals for a period, by provider, model and system, plus the last 10 requests.",
    properties: { period: { type: "string", enum: ["today", "24h", "7d", "30d", "60d", "all"], description: "Default 24h" } },
    readOnly: true,
    calls: (a) => ({ method: "GET", path: `/usage/summary${query(a, ["period"])}` }),
  },
  {
    name: "usage_requests",
    group: "usage",
    description: "Single requests, newest first: status, tokens, latency. Filters are optional; from and to are unix seconds; before is a row id for the next page.",
    properties: { provider: str, system: str, from: int, to: int, limit: { ...int, minimum: 1, maximum: 200 }, before: int },
    readOnly: true,
    calls: (a) => ({ method: "GET", path: `/usage/requests${query(a, ["provider", "system", "from", "to", "limit", "before"])}` }),
  },
  {
    name: "usage_by_month",
    group: "usage",
    description: "Token sums for one month per system, provider and model.",
    properties: { month: { ...str, pattern: "^\\d{4}-\\d{2}$", description: "YYYY-MM; default this month" } },
    readOnly: true,
    calls: (a) => ({ method: "GET", path: `/usage${query(a, ["month"])}` }),
  },
  {
    name: "get_quota",
    group: "connections",
    description: "Without id: the connections whose provider reports what is left. With id: that connection's quota windows and credits, asked from the provider.",
    properties: { id: { ...str, description: "Connection id" } },
    readOnly: true,
    openWorld: true,
    calls: (a) => ({ method: "GET", path: a.id ? `/quota/${enc(String(a.id))}` : "/quota" }),
  },
  {
    name: "get_logs",
    group: "usage",
    description: "Gateway log lines, newest first (no bodies, keys or tokens). level filters; q matches path, model, system or message; after returns lines newer than an id.",
    properties: { level: { type: "string", enum: ["info", "warn", "error"] }, q: str, after: int },
    readOnly: true,
    calls: (a) => ({ method: "GET", path: `/logs${query(a, ["level", "q", "after"])}` }),
  },
  {
    name: "get_settings",
    group: "settings",
    description: "Gateway-wide settings: token savers, upstream timeouts, the combo strategy and sticky limit, and whether request details are kept.",
    readOnly: true,
    calls: () => ({
      token_saver: { method: "GET", path: "/token-saver" },
      timeouts: { method: "GET", path: "/timeouts" },
      combo_settings: { method: "GET", path: "/combo-settings" },
      observability: { method: "GET", path: "/observability" },
    }),
  },
  {
    name: "list_pricing",
    group: "settings",
    description: "Prices in US dollars per million tokens (input, output, cache_read, cache_write) per provider/model target.",
    readOnly: true,
    calls: () => ({ method: "GET", path: "/pricing" }),
  },
  {
    name: "list_custom_providers",
    group: "connections",
    description: "Providers the owner added: id, name, format (openai or anthropic) and base URL.",
    readOnly: true,
    calls: () => ({ method: "GET", path: "/custom-providers" }),
  },

  // ---- Change ----------------------------------------------------------------------------------------------------
  {
    name: "save_combo",
    group: "combos",
    description: "Creates or replaces a combo. targets: 1 or more of provider/model, claude-*, combo/<name>, tried in order. new_name renames it (other combos follow). strategy null follows the gateway setting.",
    properties: {
      name: str,
      targets: strs,
      strategy: { type: ["string", "null"], enum: [...STRATEGIES, null] },
      config: { type: ["object", "null"], description: "Strategy settings (router_model, judge_model, ...); see the console" },
      new_name: str,
    },
    required: ["name", "targets"],
    readOnly: false,
    calls: (a) => ({ method: "PUT", path: `/combos/${enc(String(a.name))}`, body: { ...pick(a, ["targets", "strategy", "config"]), ...(a.new_name ? { name: a.new_name } : {}) } }),
  },
  {
    name: "delete_combo",
    group: "combos",
    description: "Deletes a combo.",
    properties: { name: str },
    required: ["name"],
    readOnly: false,
    destructive: true,
    calls: (a) => ({ method: "DELETE", path: `/combos/${enc(String(a.name))}` }),
  },
  {
    name: "set_combo_settings",
    group: "combos",
    description: "The strategy of combos without their own, and how many requests round robin keeps one model (1-1000).",
    properties: { strategy: { type: "string", enum: [...STRATEGIES] }, sticky_limit: { ...int, minimum: 1, maximum: 1000 } },
    readOnly: false,
    calls: (a) => ({ method: "PUT", path: "/combo-settings", body: pick(a, ["strategy", "sticky_limit"]) }),
  },
  {
    name: "update_system",
    group: "systems",
    description: 'Changes a system: name, monthly_token_cap (null: none), disabled, allowed_models (up to 50 of "*", "provider/*", "provider/model", "combo/name"; null: Claude only), and its savers.',
    properties: { id: str, name: str, monthly_token_cap: { type: ["integer", "null"], minimum: 0 }, disabled: bool, allowed_models: { type: ["array", "null"], items: str }, rtk: bool, caveman: level, ponytail: level },
    required: ["id"],
    readOnly: false,
    calls: (a) => ({ method: "PATCH", path: `/systems/${enc(String(a.id))}`, body: pick(a, ["name", "monthly_token_cap", "disabled", "allowed_models", "rtk", "caveman", "ponytail"]) }),
  },
  {
    name: "update_connection",
    group: "connections",
    description: "Renames a connection, turns it off or on, or sets its priority (1 is tried first). Its key is changed only in the console.",
    properties: { id: str, name: str, disabled: bool, priority: { ...int, minimum: 1 } },
    required: ["id"],
    readOnly: false,
    calls: (a) => ({ method: "PATCH", path: `/connections/${enc(String(a.id))}`, body: pick(a, ["name", "disabled", "priority"]) }),
  },
  {
    name: "reorder_connections",
    group: "connections",
    description: "Sets the order a provider's connections are tried in. ids: every connection id of the provider, once each, first to last.",
    properties: { provider: str, ids: strs },
    required: ["provider", "ids"],
    readOnly: false,
    calls: (a) => ({ method: "PUT", path: `/providers/${enc(String(a.provider))}/order`, body: { ids: a.ids } }),
  },
  {
    name: "set_provider_strategy",
    group: "connections",
    description: "How a provider's connections are used: fill-first (in priority order) or round-robin.",
    properties: { provider: str, strategy: { type: "string", enum: ["fill-first", "round-robin"] } },
    required: ["provider", "strategy"],
    readOnly: false,
    calls: (a) => ({ method: "PUT", path: `/providers/${enc(String(a.provider))}/strategy`, body: { strategy: a.strategy } }),
  },
  {
    name: "disable_models",
    group: "models",
    description: "Turns models off: they are refused in requests and left out of combos and /v1/models.",
    properties: { provider: str, ids: { ...strs, description: "Model ids without the provider prefix" } },
    required: ["provider", "ids"],
    readOnly: false,
    calls: (a) => ({ method: "POST", path: "/models/disabled", body: { provider: a.provider, ids: a.ids } }),
  },
  {
    name: "enable_models",
    group: "models",
    description: "Turns a model on again, or every model of the provider when id is left out.",
    properties: { provider: str, id: str },
    required: ["provider"],
    readOnly: false,
    calls: (a) => ({ method: "DELETE", path: `/models/disabled${query(a, ["provider", "id"])}` }),
  },
  {
    name: "set_alias",
    group: "models",
    description: "Creates or changes an alias: a short model name that stands for provider/model or combo/name, possibly with a (level) suffix.",
    properties: { alias: str, model: str },
    required: ["alias", "model"],
    readOnly: false,
    calls: (a) => ({ method: "PUT", path: "/models/aliases", body: { alias: a.alias, model: a.model } }),
  },
  {
    name: "delete_alias",
    group: "models",
    description: "Deletes an alias.",
    properties: { alias: str },
    required: ["alias"],
    readOnly: false,
    destructive: true,
    calls: (a) => ({ method: "DELETE", path: `/models/aliases${query(a, ["alias"])}` }),
  },
  {
    name: "add_custom_model",
    group: "models",
    description: "Adds a model id the provider's catalog does not list, with an optional display name.",
    properties: { provider: str, id: str, name: str },
    required: ["provider", "id"],
    readOnly: false,
    calls: (a) => ({ method: "POST", path: "/models/custom", body: pick(a, ["provider", "id", "name"]) }),
  },
  {
    name: "remove_custom_model",
    group: "models",
    description: "Removes a custom model.",
    properties: { provider: str, id: str },
    required: ["provider", "id"],
    readOnly: false,
    destructive: true,
    calls: (a) => ({ method: "DELETE", path: `/models/custom${query(a, ["provider", "id"])}` }),
  },
  {
    name: "sync_models",
    group: "models",
    description: "Fetches a provider's own model list now (Codex: what Codex CLI sees; OpenAI-format providers: their /models) and keeps it, so models the provider added show up. Answers count, added and removed.",
    properties: { provider: { ...str, description: "Provider id, such as codex or groq" } },
    required: ["provider"],
    readOnly: false,
    openWorld: true,
    calls: (a) => ({ method: "POST", path: `/providers/${enc(String(a.provider))}/models/sync` }),
  },
  {
    name: "set_thinking_mode",
    group: "models",
    description: "A provider's thinking mode for requests that set none; the modes are listed by list_models. auto clears it.",
    properties: { provider: str, mode: str },
    required: ["provider", "mode"],
    readOnly: false,
    calls: (a) => ({ method: "PUT", path: "/models/thinking", body: { provider: a.provider, mode: a.mode } }),
  },
  {
    name: "set_token_saver",
    group: "settings",
    description: "Gateway-wide token savers: rtk (trims tool output), caveman and ponytail (lite, full, ultra or null), custom_prompt (added to every system prompt, up to 4000 chars, or null). The Headroom address is set in the console.",
    properties: { rtk: bool, caveman: level, ponytail: level, custom_prompt: { type: ["string", "null"], maxLength: 4000 } },
    readOnly: false,
    calls: (a) => ({ method: "PUT", path: "/token-saver", body: pick(a, ["rtk", "caveman", "ponytail", "custom_prompt"]) }),
  },
  {
    name: "set_timeouts",
    group: "settings",
    description: "How long the gateway waits for a provider's first byte and between two chunks: 0 (off) or 10 to 3600 seconds.",
    properties: { first_byte_s: int, idle_s: int },
    readOnly: false,
    calls: (a) => ({ method: "PUT", path: "/timeouts", body: pick(a, ["first_byte_s", "idle_s"]) }),
  },
  {
    name: "set_price",
    group: "settings",
    description: "Price of a provider/model target in US dollars per million tokens. A target also prices every model whose name starts with it.",
    properties: { target: str, input: num, output: num, cache_read: num, cache_write: num },
    required: ["target", "input", "output"],
    readOnly: false,
    calls: (a) => ({ method: "PUT", path: "/pricing", body: pick(a, ["target", "input", "output", "cache_read", "cache_write"]) }),
  },
  {
    name: "delete_price",
    group: "settings",
    description: "Deletes a price; the default price, if any, applies again.",
    properties: { target: str },
    required: ["target"],
    readOnly: false,
    destructive: true,
    calls: (a) => ({ method: "DELETE", path: `/pricing${query(a, ["target"])}` }),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Fields a tool never takes, with the reason given to the AI. */
const REFUSED: Record<string, string> = {
  api_key: "keys are added and changed in the console, never through MCP",
  settings: "connection settings are sealed with the key and changed in the console",
  headroom: "the Headroom address receives every conversation and is set in the console",
};

const listed = (t: Tool) => ({
  name: t.name,
  description: t.description,
  inputSchema: { type: "object", properties: t.properties ?? {}, ...(t.required?.length ? { required: t.required } : {}), additionalProperties: false },
  annotations: { readOnlyHint: t.readOnly, destructiveHint: t.destructive === true, idempotentHint: t.readOnly || t.destructive !== true, openWorldHint: t.openWorld === true },
});

type Admin = Hono<AppEnv>;

/** Whether a token with `scopes` may use `tool`: its group at read for a read tool, at write for a change. */
const permitted = (scopes: Scopes, tool: Tool) => !tool.group || allows(scopes[tool.group], tool.readOnly ? "read" : "write");

async function runCall(c: Context<AppEnv>, admin: Admin, call: Call): Promise<{ status: number; body: unknown }> {
  if (call.path === "/__build") return { status: 200, body: { version: c.env.APP_VERSION?.trim() || "dev", built_at: c.env.APP_BUILT_AT?.trim() || null } };
  // `admin` is the trusted copy (no auth of its own): the caller's token and levels were checked before this.
  const headers = new Headers();
  if (call.body !== undefined) headers.set("content-type", "application/json");
  const res = await admin.fetch(new Request(`https://gateway${call.path}`, { method: call.method, headers, body: call.body === undefined ? undefined : JSON.stringify(call.body) }), c.env, c.executionCtx);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: the text
  }
  return { status: res.status, body };
}

const textResult = (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

async function callTool(c: Context<AppEnv>, admin: Admin, tool: Tool, args: Json, scopes: Scopes): Promise<Json> {
  if (!permitted(scopes, tool)) return textResult(`this token may not use ${tool.name}: it needs ${tool.readOnly ? "read" : "write"} on ${tool.group}`, true);
  for (const k of Object.keys(args)) if (REFUSED[k]) return textResult(`${k}: ${REFUSED[k]}`, true);
  const missing = (tool.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length) return textResult(`missing argument: ${missing.join(", ")}`, true);
  const plan = tool.calls(args);
  if ("method" in plan && "path" in plan) {
    const r = await runCall(c, admin, plan as Call);
    if (r.status >= 400) return textResult(`HTTP ${r.status}: ${typeof r.body === "string" ? r.body : JSON.stringify(r.body)}`, true);
    return textResult(r.status === 204 ? { ok: true } : r.body);
  }
  const out: Json = {};
  for (const [key, call] of Object.entries(plan as Record<string, Call>)) {
    const r = await runCall(c, admin, call);
    if (r.status >= 400) return textResult(`HTTP ${r.status} from ${key}: ${JSON.stringify(r.body)}`, true);
    out[key] = r.body;
  }
  // get_status reads as one object: the build, then what is set up.
  if (tool.name === "get_status") return textResult({ ...(out.build as Json), ...(out.setup as Json) });
  return textResult(out);
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(c: Context<AppEnv>, admin: Admin, msg: unknown, scopes: Scopes): Promise<Json | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcError(null, -32600, "invalid request");
  const m = msg as Json;
  const id = m.id;
  // A notification (no id) or a response from the client: nothing to answer.
  if (id === undefined || typeof m.method !== "string") return null;
  const params = (m.params && typeof m.params === "object" ? m.params : {}) as Json;
  switch (m.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ai-router", title: "ai-router gateway", version: c.env.APP_VERSION?.trim() || "dev" },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS.filter((t) => permitted(scopes, t)).map(listed) } };
    case "tools/call": {
      const tool = typeof params.name === "string" ? BY_NAME.get(params.name) : undefined;
      if (!tool) return rpcError(id, -32602, `unknown tool: ${String(params.name)}`);
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Json) : {};
      return { jsonrpc: "2.0", id, result: await callTool(c, admin, tool, args, scopes) };
    }
    default:
      return rpcError(id, -32601, `method not found: ${m.method}`);
  }
}

/**
 * POST /mcp, with an MCP token (mcp-tokens.ts: its levels decide the tools) or the admin token (every tool). A console
 * cookie is not accepted. GET (a server-sent stream) and DELETE (sessions) are not offered. `admin` is the trusted
 * copy of the admin routes, with no auth of its own.
 */
export function mcpRoutes(admin: Admin): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // The levels of the token on each request, set by the check below.
  const levels = new WeakMap<Request, Scopes>();
  r.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    let scopes: Scopes | null = null;
    if (bearer) {
      const t = await mcpTokenAccess(c.env.DB, bearer, (p) => c.executionCtx.waitUntil(p));
      scopes = t ? t.scopes : (await isAdmin(c.env, c.req.raw)) ? ALL : null;
    }
    if (!scopes) return c.json({ error: "unauthorized", hint: "Authorization: Bearer <MCP token or admin token>" }, 401, { "www-authenticate": 'Bearer realm="ai-router"' });
    levels.set(c.req.raw, scopes);
    await next();
  });
  r.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "parse error"), 400);
    }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(c, admin, m, levels.get(c.req.raw)!)))).filter((x): x is Json => x !== null);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await handle(c, admin, body, levels.get(c.req.raw)!);
    return out ? c.json(out) : c.body(null, 202);
  });
  r.all("/", (c) => c.json({ error: "method_not_allowed", hint: "POST JSON-RPC messages to /mcp" }, 405, { allow: "POST" }));
  return r;
}
