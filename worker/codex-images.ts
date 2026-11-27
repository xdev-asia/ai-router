import type { Context } from "hono";
import type { System } from "./auth";
import { BLOCKED_MESSAGE, RELAY_ERROR_HEADER, RELAY_SECRET_HEADER, codexEvents, codexHeaders, codexModel, isBlockPage } from "./codex";
import { accountFailure, candidatesFor, noteFailure, noteSuccess, type Candidate } from "./connections";
import type { AppEnv } from "./env";
import { errorBody } from "./errors";
import { providerHeaders } from "./provider-headers";
import { allowedPatterns, allows } from "./providers";
import { codexDestinationFor } from "./proxy-pools";
import { record, type Upstream } from "./proxy";
import { errorResponse } from "./route";
import { EMPTY, type Usage } from "./usage";

/**
 * Images through a ChatGPT account (`codex/<model>` on /v1/images/generations): the Codex backend's Responses API
 * with its hosted `image_generation` tool, forced, one request per image. The answer is OpenAI's images shape,
 * always `b64_json`. The image counts against the ChatGPT plan's limits, not an API balance.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const INSTRUCTIONS =
  "You make images. Call the image_generation tool exactly once, with the user's description as the prompt. Do not ask questions and do not answer with text.";
const MAX_PROMPT = 32_000;
const MAX_N = 4;
const QUALITY = ["low", "medium", "high", "auto"];
const BACKGROUND = ["transparent", "opaque", "auto"];
const FORMATS = ["png", "jpeg", "webp"];

class BadRequest extends Error {}

/** The tool settings from an OpenAI images body; a field it cannot honour is a 400, not dropped. */
function toolOf(data: Json): { prompt: string; n: number; tool: Json } {
  const prompt = typeof data.prompt === "string" ? data.prompt.trim() : "";
  if (!prompt) throw new BadRequest("prompt: what to draw");
  if (prompt.length > MAX_PROMPT) throw new BadRequest(`prompt: at most ${MAX_PROMPT} characters`);
  const n = data.n === undefined || data.n === null ? 1 : data.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_N) throw new BadRequest(`n: 1 to ${MAX_N} images through a ChatGPT account`);
  if (data.response_format !== undefined && data.response_format !== null && data.response_format !== "b64_json")
    throw new BadRequest("response_format: a ChatGPT account answers b64_json only");
  const tool: Json = { type: "image_generation" };
  const pick = (field: string, ok: (v: string) => boolean, hint: string) => {
    const v = data[field];
    if (v === undefined || v === null) return;
    if (typeof v !== "string" || !ok(v)) throw new BadRequest(`${field}: ${hint}`);
    tool[field] = v;
  };
  pick("size", (v) => v === "auto" || /^\d{3,4}x\d{3,4}$/.test(v), "auto or <width>x<height>, such as 1024x1536");
  pick("quality", (v) => QUALITY.includes(v), QUALITY.join(", "));
  pick("background", (v) => BACKGROUND.includes(v), BACKGROUND.join(", "));
  const format = data.output_format ?? "png";
  if (typeof format !== "string" || !FORMATS.includes(format)) throw new BadRequest(`output_format: ${FORMATS.join(", ")}`);
  tool.output_format = format;
  return { prompt, n, tool };
}

function codexImageRequest(model: string, prompt: string, tool: Json): Json {
  const { model: name, effort } = codexModel(model);
  const body: Json = {
    model: name,
    instructions: INSTRUCTIONS,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [tool],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false,
  };
  if (effort) body.reasoning = { effort };
  return body;
}

type Drawn = { ok: true; image: string; revised: string | null; usage: unknown; model: string | null } | { ok: false; message: string };

/** Reads the stream to its end: the finished image, or why there is none (a failure, or the text it said instead). */
async function readImage(body: ReadableStream<Uint8Array>): Promise<Drawn> {
  let image: string | null = null;
  let revised: string | null = null;
  let text = "";
  for await (const ev of codexEvents(body)) {
    const item = isObj(ev.item) ? ev.item : null;
    const response = isObj(ev.response) ? ev.response : null;
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") text += ev.delta;
    else if (ev.type === "response.output_item.done" && item?.type === "image_generation_call" && typeof item.result === "string" && item.result) {
      image ??= item.result;
      if (typeof item.revised_prompt === "string") revised ??= item.revised_prompt;
    } else if (ev.type === "response.failed" || ev.type === "error") {
      const e = isObj(response?.error) ? response.error : isObj(ev.error) ? ev.error : ev;
      return { ok: false, message: typeof e.message === "string" ? e.message : "the provider reported a failure" };
    } else if (ev.type === "response.completed" || ev.type === "response.done" || ev.type === "response.incomplete") {
      if (!image) return { ok: false, message: text.trim() ? `no image came back; the model said: ${text.trim().slice(0, 500)}` : "no image came back" };
      return { ok: true, image, revised, usage: response?.usage, model: typeof response?.model === "string" ? response.model : null };
    }
  }
  return { ok: false, message: "the stream from the provider ended early" };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

async function refusal(up: Response): Promise<string> {
  const body = (errorBody(await up.json().catch(() => null)) ?? {}) as { error?: { message?: unknown } | string; detail?: unknown };
  const e = body.error;
  return typeof e === "string" ? e : typeof e?.message === "string" ? e.message : typeof body.detail === "string" ? body.detail : `upstream error ${up.status}`;
}

type One = { ok: true; drawn: Extract<Drawn, { ok: true }> } | { ok: false; res: Response; status: number; message: string; gateway?: boolean };

/** One image through one account. `up` is recorded as a usage row whatever happens. */
async function drawOnce(c: Context<AppEnv>, upstream: Upstream, system: System, token: string, cand: Candidate, model: string, prompt: string, tool: Json): Promise<One> {
  const dest = await codexDestinationFor(c.env, cand.proxyPool);
  if (!dest.ok) return { ok: false, res: errorResponse(500, dest.message, "server_error", "not_configured"), status: 500, message: dest.message, gateway: true };
  const headers = codexHeaders(token, cand.account);
  for (const [k, v] of Object.entries(await providerHeaders(c.env.DB, "codex"))) if (!headers.has(k)) headers.set(k, v);
  if (dest.secret) headers.set(RELAY_SECRET_HEADER, dest.secret);
  const up = await (dest.fetch ?? upstream)(new Request(dest.url, { method: "POST", headers, body: JSON.stringify(codexImageRequest(model, prompt, tool)) }));
  const requestId = up.headers.get("x-request-id") ?? up.headers.get("request-id");
  const meter = (status: number, usage: Usage = { ...EMPTY, model }) => record(c, system, new Response(null, { status, headers: requestId ? { "request-id": requestId } : {} }), false, Promise.resolve(usage), "codex");
  if (dest.secret && up.headers.get(RELAY_ERROR_HEADER) === "relay_unauthorized") {
    meter(up.status);
    const m = "not_configured: the Codex relay refused CODEX_RELAY_SECRET";
    return { ok: false, res: errorResponse(500, m, "server_error", "not_configured"), status: 500, message: m, gateway: true };
  }
  if (isBlockPage(up)) {
    meter(up.status);
    await up.body?.cancel();
    return { ok: false, res: errorResponse(502, BLOCKED_MESSAGE, "api_error", "codex_blocked"), status: 502, message: BLOCKED_MESSAGE, gateway: true };
  }
  if (!up.ok || !up.body) {
    meter(up.status);
    const message = await refusal(up);
    const extra: Record<string, string> = {};
    const ra = up.headers.get("retry-after");
    if (ra) extra["retry-after"] = ra;
    const type = up.status === 401 ? "authentication_error" : up.status === 429 ? "rate_limit_error" : up.status < 500 ? "invalid_request_error" : "api_error";
    return { ok: false, res: errorResponse(up.status, message, type, null, extra), status: up.status, message };
  }
  const drawn = await readImage(up.body);
  if (!drawn.ok) {
    meter(502);
    return { ok: false, res: errorResponse(502, drawn.message, "api_error"), status: 502, message: drawn.message };
  }
  const u = isObj(drawn.usage) ? drawn.usage : {};
  const cached = isObj(u.input_tokens_details) ? num(u.input_tokens_details.cached_tokens) : 0;
  meter(200, { ...EMPTY, model: drawn.model ?? model, input_tokens: Math.max(0, num(u.input_tokens) - cached), output_tokens: num(u.output_tokens), cache_read_input_tokens: cached });
  return { ok: true, drawn };
}

/** POST /v1/images/generations (and the console's playground) for a `codex/<model>`. */
export async function sendCodexImages(c: Context<AppEnv>, upstream: Upstream, system: System, data: Json, model: string): Promise<Response> {
  if (!allows(allowedPatterns(system.allowed_models), `codex/${model}`)) return errorResponse(403, "this system may not use this model", "permission_error", "model_not_allowed");
  let req: ReturnType<typeof toolOf>;
  try {
    req = toolOf(data);
  } catch (e) {
    if (e instanceof BadRequest) return errorResponse(400, e.message, "invalid_request_error");
    throw e;
  }
  const now = Math.floor(Date.now() / 1000);
  const cands = await candidatesFor(c.env, "codex", system.id, now, upstream);
  const images: Json[] = [];
  let input = 0;
  let output = 0;
  let last: Response | null = null;
  for (let i = 0; i < req.n; i++) {
    let done = false;
    for (const cand of cands) {
      let key = await cand.key();
      if (key === null) continue;
      if (typeof key !== "string") {
        last = errorResponse(key.status, key.error, key.status === 401 ? "authentication_error" : "api_error", "provider_auth");
        continue;
      }
      c.set("connection", cand.connection);
      let one: One;
      try {
        one = await drawOnce(c, upstream, system, key, cand, model, req.prompt, req.tool);
        // A token refused before it expired: renew it once and send again.
        if (!one.ok && one.status === 401 && !one.gateway) {
          key = await cand.key(true);
          if (typeof key === "string") one = await drawOnce(c, upstream, system, key, cand, model, req.prompt, req.tool);
        }
      } catch {
        one = { ok: false, res: errorResponse(502, "could not reach codex", "api_error"), status: 502, message: "could not reach codex" };
      }
      if (one.ok) {
        c.executionCtx.waitUntil(noteSuccess(c.env.DB, cand, now).catch(() => undefined));
        const u = isObj(one.drawn.usage) ? one.drawn.usage : {};
        input += num(u.input_tokens);
        output += num(u.output_tokens);
        images.push(one.drawn.revised ? { b64_json: one.drawn.image, revised_prompt: one.drawn.revised } : { b64_json: one.drawn.image });
        done = true;
        break;
      }
      last = one.res;
      if (one.gateway || !accountFailure(one.status)) return one.res;
      const ra = Number(one.res.headers.get("retry-after"));
      await noteFailure(c.env.DB, cand, one.status, one.message, Number.isFinite(ra) && ra > 0 ? ra : null, now);
    }
    if (!done) {
      // Images already drawn are not thrown away: answer them, or the last failure when there are none.
      if (images.length > 0) break;
      return last ?? errorResponse(500, "not_configured: no codex connection; sign in from the console", "server_error", "not_configured", { "x-should-retry": "false" });
    }
  }
  return Response.json(
    { created: Math.floor(Date.now() / 1000), data: images, usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } },
    { headers: { "cache-control": "no-store" } },
  );
}
