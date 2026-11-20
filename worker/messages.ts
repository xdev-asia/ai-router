/**
 * POST /v1/messages for a model that is not Anthropic-format, or a combo: the Claude request is translated to chat,
 * routed like any chat request (runChat: aliases, combos, allow-list, accounts, savers, metering), and its answer
 * translated back (translate/anthropic-openai.ts). Anthropic-format targets do not come here: proxy.ts forwards
 * them as sent, which keeps prompt caching and thinking signatures.
 */
import type { Context } from "hono";
import type { System } from "./auth";
import type { AppEnv } from "./env";
import type { Upstream } from "./proxy";
import { runChat } from "./route";
import { anthropicErrorFrom, anthropicErrorType, chatStreamToMessages, chatToMessage, messageAsEvents, messagesToChat } from "./translate/anthropic-openai";
import { TranslateError } from "./translate/openai-anthropic";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const invalid = (message: string) =>
  new Response(JSON.stringify({ type: "error", error: { type: anthropicErrorType(400), message } }), { status: 400, headers: { "content-type": "application/json" } });

export async function runMessages(c: Context<AppEnv>, upstream: Upstream, system: System, req: Json): Promise<Response> {
  let chat: Json;
  try {
    chat = messagesToChat(req);
  } catch (e) {
    if (e instanceof TranslateError) return invalid(e.message);
    throw e;
  }
  const res = await runChat(c, upstream, system, chat);
  if (res.status !== 200 || !res.body) return anthropicErrorFrom(res);

  const model = typeof req.model === "string" ? req.model : "";
  const headers = new Headers({ "cache-control": "no-store" });
  const target = res.headers.get("x-gateway-target");
  if (target) headers.set("x-gateway-target", target);
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(chatStreamToMessages(model, res.body), { status: 200, headers });
  }
  let completion: unknown;
  try {
    completion = await res.json();
  } catch {
    return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "the provider answer was not JSON" } }), { status: 502, headers: { "content-type": "application/json" } });
  }
  const msg = chatToMessage(isObj(completion) ? completion : {}, model);
  if (req.stream === true) {
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(messageAsEvents(msg), { status: 200, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(msg), { status: 200, headers });
}
