import { Hono, type Context } from "hono";
import type { AppEnv } from "./env";
import { allowedPatterns, allows, providerKey } from "./providers";
import { checkSystem, type GateFailure, type Upstream } from "./proxy";
import { ANTHROPIC_VERSION, errorResponse, runChat } from "./route";

const GATE_TYPE: Record<GateFailure["kind"], [string, string]> = {
  authentication: ["invalid_request_error", "invalid_api_key"],
  permission: ["permission_error", "system_disabled"],
  not_configured: ["server_error", "not_configured"],
  cap: ["insufficient_quota", "monthly_token_cap"],
};
const gateError = (g: GateFailure) =>
  errorResponse(g.status, g.message, GATE_TYPE[g.kind][0], GATE_TYPE[g.kind][1], g.noRetry ? { "x-should-retry": "false" } : {});

/**
 * OpenAI-compatible surface: `new OpenAI({ apiKey: <gateway token>, baseURL: "https://<host>/openai/v1" })`.
 * `model` is `claude-*`, `<provider>/<model>` or `combo/<name>` (see providers.ts and route.ts). Metering
 * and caps are the same as /anthropic, whatever the provider.
 */
export function openaiRoutes(upstream: Upstream): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/v1/chat/completions", async (c) => {
    const g = await checkSystem(c.env, c.req.raw, true);
    if (!g.ok) return gateError(g);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(400, "body must be JSON", "invalid_request_error");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse(400, "body must be a JSON object", "invalid_request_error");
    return runChat(c, upstream, g.system, body as Record<string, unknown>);
  });

  /** Claude models (from Anthropic), then the combos and exact provider/model entries this system may use. */
  r.get("/v1/models", async (c: Context<AppEnv>) => {
    const g = await checkSystem(c.env, c.req.raw, false);
    if (!g.ok) return gateError(g);
    const patterns = allowedPatterns(g.system.allowed_models);
    const data: { id: string; object: "model"; created: number; owned_by: string }[] = [];

    const key = providerKey(c.env, "anthropic", g.system.id);
    if (key && allows(patterns, "anthropic/")) {
      const up = await upstream(
        new Request(c.env.ANTHROPIC_BASE_URL.replace(/\/+$/, "") + "/v1/models?limit=1000", {
          headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
        }),
      );
      if (up.ok) {
        const list = (await up.json()) as { data?: { id?: unknown; created_at?: unknown }[] };
        for (const m of list.data ?? []) {
          if (typeof m.id !== "string" || !allows(patterns, `anthropic/${m.id}`)) continue;
          const created = typeof m.created_at === "string" ? Math.floor(Date.parse(m.created_at) / 1000) || 0 : 0;
          data.push({ id: m.id, object: "model", created, owned_by: "anthropic" });
        }
      }
    }
    const combos = await c.env.DB.prepare("SELECT name, updated_at FROM combo ORDER BY name").all<{ name: string; updated_at: number }>();
    for (const cb of combos.results) {
      if (allows(patterns, `combo/${cb.name}`)) data.push({ id: `combo/${cb.name}`, object: "model", created: cb.updated_at, owned_by: "gateway" });
    }
    for (const p of patterns) {
      if (!p.includes("*") && !p.startsWith("combo/") && !p.startsWith("anthropic/")) {
        data.push({ id: p, object: "model", created: 0, owned_by: p.slice(0, p.indexOf("/")) });
      }
    }
    return Response.json({ object: "list", data }, { headers: { "cache-control": "no-store" } });
  });

  r.all("*", () => errorResponse(404, "this gateway serves /v1/chat/completions and /v1/models here", "invalid_request_error", "not_found"));
  return r;
}
