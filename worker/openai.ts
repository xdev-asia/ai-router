import { Hono, type Context } from "hono";
import type { AppEnv } from "./env";
import { checkGate, record, type GateFailure, type Upstream } from "./proxy";
import { TranslateError, chatToMessages, messageToChat, openaiErrorBody, streamToChat } from "./translate/openai-anthropic";
import { EMPTY, usageOfMessage, usageOfStream } from "./usage";

/** The Messages API version this gateway speaks when it builds the upstream request itself. */
export const ANTHROPIC_VERSION = "2023-06-01";

type Status = 400 | 401 | 403 | 404 | 429 | 500 | 502;

function openaiError(c: Context<AppEnv>, status: Status, message: string, type: string, code: string | null = null, noRetry = false): Response {
  if (noRetry) c.header("x-should-retry", "false");
  c.header("cache-control", "no-store");
  return c.json(openaiErrorBody(message, type, code), status);
}

const GATE_TYPE: Record<GateFailure["kind"], [string, string]> = {
  authentication: ["invalid_request_error", "invalid_api_key"],
  permission: ["permission_error", "system_disabled"],
  not_configured: ["server_error", "not_configured"],
  cap: ["insufficient_quota", "monthly_token_cap"],
};
const gateError = (c: Context<AppEnv>, g: GateFailure) => openaiError(c, g.status, g.message, GATE_TYPE[g.kind][0], GATE_TYPE[g.kind][1], g.noRetry);

function upstreamRequest(c: Context<AppEnv>, path: string, key: string, init: { method: string; body?: string }): Request {
  return new Request(c.env.ANTHROPIC_BASE_URL.replace(/\/+$/, "") + path, {
    method: init.method,
    headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body,
  });
}

/** Passes an Anthropic error on in the OpenAI envelope, with the same status. */
async function upstreamError(c: Context<AppEnv>, up: Response): Promise<Response> {
  const body = (await up.json().catch(() => ({}))) as { error?: { type?: unknown; message?: unknown } };
  const message = typeof body.error?.message === "string" ? body.error.message : `upstream error ${up.status}`;
  const type = typeof body.error?.type === "string" ? body.error.type : "api_error";
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const h of ["retry-after", "x-should-retry"]) {
    const v = up.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(JSON.stringify(openaiErrorBody(message, type)), { status: up.status, headers });
}

/**
 * OpenAI-compatible surface for systems that only have an OpenAI SDK:
 * `new OpenAI({ apiKey: <gateway token>, baseURL: "https://<host>/openai/v1" })`.
 * Requests are translated to Claude's Messages API; metering and caps are the same as /anthropic.
 */
export function openaiRoutes(upstream: Upstream): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/v1/chat/completions", async (c) => {
    const g = await checkGate(c.env, c.req.raw, true);
    if (!g.ok) return gateError(c, g);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return openaiError(c, 400, "body must be JSON", "invalid_request_error");
    }
    let messages: Record<string, unknown>;
    try {
      messages = chatToMessages(body);
    } catch (e) {
      if (e instanceof TranslateError) return openaiError(c, 400, e.message, "invalid_request_error");
      throw e;
    }
    const model = messages.model as string;
    const stream = messages.stream === true;
    const includeUsage = stream && (body as { stream_options?: { include_usage?: unknown } }).stream_options?.include_usage === true;

    const up = await upstream(upstreamRequest(c, "/v1/messages", g.key, { method: "POST", body: JSON.stringify(messages) }));
    if (!up.ok || !up.body) {
      record(c, g.system, up, false, Promise.resolve(EMPTY));
      return upstreamError(c, up);
    }

    const [toClient, toMeter] = up.body.tee();
    if (stream) {
      record(c, g.system, up, true, usageOfStream(toMeter));
      return new Response(toClient.pipeThrough(streamToChat(model, includeUsage)), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const msg: unknown = await new Response(toClient).json();
    record(c, g.system, up, false, new Response(toMeter).json().then(usageOfMessage));
    c.header("cache-control", "no-store");
    return c.json(messageToChat(msg, model));
  });

  r.get("/v1/models", async (c) => {
    const g = await checkGate(c.env, c.req.raw, false);
    if (!g.ok) return gateError(c, g);
    const up = await upstream(upstreamRequest(c, "/v1/models?limit=1000", g.key, { method: "GET" }));
    if (!up.ok) return upstreamError(c, up);
    const list = (await up.json()) as { data?: { id?: unknown; created_at?: unknown }[] };
    c.header("cache-control", "no-store");
    return c.json({
      object: "list",
      data: (list.data ?? [])
        .filter((m) => typeof m.id === "string")
        .map((m) => ({
          id: m.id,
          object: "model",
          created: typeof m.created_at === "string" ? Math.floor(Date.parse(m.created_at) / 1000) || 0 : 0,
          owned_by: "anthropic",
        })),
    });
  });

  r.all("*", (c) => openaiError(c, 404, "this gateway serves /v1/chat/completions and /v1/models here", "invalid_request_error", "not_found"));
  return r;
}
