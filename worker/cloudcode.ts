import { chatToGeminiRequest, geminiStreamToChat, geminiToChatResponse } from "./gemini";
import { ANTIGRAVITY_HEADERS } from "./oauth";
import type { Wire } from "./wire";

/**
 * Chat through Google's Cloud Code (Gemini Code Assist), the endpoint Gemini CLI and Antigravity call with the
 * account's Google sign-in (oauth.ts) and its Code Assist project (the connection's account). The request is a
 * chat completion turned into a Gemini request (gemini.ts) inside Cloud Code's envelope; the answer, Gemini's,
 * turned back into a chat completion. Values (paths, headers, limits) from an open-source
 * client (MIT), the code written anew; not called against the live service by this gateway's tests.
 */

type Json = Record<string, unknown>;

const GEMINI_CLI_BASE = "https://cloudcode-pa.googleapis.com/v1internal";
const ANTIGRAVITY_BASE = "https://daily-cloudcode-pa.googleapis.com/v1internal";
const GEMINI_CLI_VERSION = "0.34.0";
/** Antigravity refuses more output tokens than this. */
const ANTIGRAVITY_MAX_OUTPUT = 64000;
const SSE_HEADERS = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" };

function antigravityRequest(g: Json, model: string, project: string): Json {
  const request: Json = { ...g, sessionId: crypto.randomUUID() };
  if (g.tools) request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  const config = (g.generationConfig as Json | undefined) ?? {};
  const max = typeof config.maxOutputTokens === "number" ? config.maxOutputTokens : null;
  if (max !== null && max > ANTIGRAVITY_MAX_OUTPUT) request.generationConfig = { ...config, maxOutputTokens: ANTIGRAVITY_MAX_OUTPUT };
  return {
    project,
    model,
    userAgent: "antigravity",
    requestId: `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/1`,
    request,
  };
}

/** A Gemini answer read whole and sent on as a chat completion; a body that is not JSON ends the stream with an error. */
function completionOf(res: Response, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(geminiToChatResponse(await res.json(), model))));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new Response(body, { status: res.status, headers: { "content-type": "application/json" } });
}

/**
 * The wire for one Gemini CLI or Antigravity request. `model`: the id the endpoint takes (the catalog's `upstream`:
 * Antigravity's `gemini-pro-agent`, `gemini-3.1-pro-low(low)`);
 * `project`: the Code Assist project the sign-in found.
 */
export function cloudCodeWire(provider: string, token: string, project: string, model: string): Wire {
  const antigravity = provider === "antigravity";
  return {
    kind: "openai",
    async request(body: Json) {
      const stream = body.stream === true;
      const g = chatToGeminiRequest(body);
      const base = antigravity ? ANTIGRAVITY_BASE : GEMINI_CLI_BASE;
      const url = stream ? `${base}:streamGenerateContent?alt=sse` : `${base}:generateContent`;
      const accept = stream ? "text/event-stream" : "application/json";
      const headers: Record<string, string> = antigravity
        ? { ...ANTIGRAVITY_HEADERS, authorization: `Bearer ${token}`, "content-type": "application/json", accept }
        : {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept,
            "user-agent": `GeminiCLI/${GEMINI_CLI_VERSION}/${model} (linux; x64; terminal)`,
            "x-goog-api-client": "google-genai-sdk/1.41.0 gl-node/v22.19.0",
          };
      const payload = antigravity ? antigravityRequest(g, model, project) : { model, project, request: g };
      return new Request(url, { method: "POST", headers, body: JSON.stringify(payload) });
    },
    response(res, stream) {
      if (!res.ok || !res.body) return res;
      return stream ? new Response(geminiStreamToChat(res.body, model), { status: res.status, headers: SSE_HEADERS }) : completionOf(res, model);
    },
  };
}
