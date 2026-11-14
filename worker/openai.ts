import { Hono, type Context } from "hono";
import type { AppEnv } from "./env";
import { mediaRoutes } from "./media";
import { listModels } from "./models";
import { checkSystem, type GateFailure, type Upstream } from "./proxy";
import { runResponses } from "./responses";
import { errorResponse, runChat } from "./route";
import { webToolRoutes } from "./web-tools";

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

  /** The Responses API, for Codex CLI and other clients that speak only it (responses.ts). */
  r.post("/v1/responses", async (c) => {
    const g = await checkSystem(c.env, c.req.raw, true);
    if (!g.ok) return gateError(g);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(400, "body must be JSON", "invalid_request_error");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse(400, "body must be a JSON object", "invalid_request_error");
    return runResponses(c, upstream, g.system, body as Record<string, unknown>);
  });

  /** What this system may call (models.ts listModels). */
  const models = async (c: Context<AppEnv>) => {
    const g = await checkSystem(c.env, c.req.raw, false);
    if (!g.ok) return gateError(g);
    return Response.json({ object: "list", data: await listModels(c.env, upstream, g.system) }, { headers: { "cache-control": "no-store" } });
  };
  r.get("/v1/models", models);
  // GET /v1 answers with the model list too.
  r.get("/v1", models);

  mediaRoutes(r, upstream, gateError);
  webToolRoutes(r, upstream, gateError);

  r.all("*", () => errorResponse(404, "this gateway serves /v1/chat/completions, /v1/responses, /v1/models, media (/v1/embeddings, /v1/images/generations, /v1/videos, /v1/audio/*) and /v1/search, /v1/fetch here", "invalid_request_error", "not_found"));
  return r;
}
