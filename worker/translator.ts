import type { Hono } from "hono";
import type { AppEnv } from "./env";
import { geminiToChat } from "./gemini";
import { responsesToChat } from "./responses";
import { chatToMessages } from "./translate/openai-anthropic";

type Json = Record<string, unknown>;

/** Request formats the gateway accepts, and the formats it sends upstream. */
export const SOURCES = ["openai", "responses", "gemini"] as const;
export const TARGETS = ["openai", "anthropic"] as const;
type Source = (typeof SOURCES)[number];
type Target = (typeof TARGETS)[number];

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const HINT = `from: ${SOURCES.join(", ")}; to: ${TARGETS.join(", ")} (not the same); body: a JSON object; model: required when from is gemini`;

/** A request in `from` as the request the gateway sends to a `to` provider. Throws what the translators throw. */
export function translate(from: Source, to: Target, body: Json, model: string | null): Json {
  const chat = from === "openai" ? body : from === "responses" ? responsesToChat(body) : geminiToChat(body, model ?? "", false);
  return to === "openai" ? chat : chatToMessages(chat);
}

/**
 * POST /admin/translate {from, to, body, model?} → {result}: the same translators the routes use, run on a pasted
 * request, so the owner sees what is sent upstream. Nothing is sent and nothing is stored.
 */
export function translatorRoutes(a: Hono<AppEnv>): void {
  a.post("/translate", async (c) => {
    const b: unknown = await c.req.json().catch(() => null);
    if (!isObj(b)) return c.json({ error: "invalid_input", hint: HINT }, 400);
    const { from, to, body, model } = b;
    const okModel = model === undefined || model === null || (typeof model === "string" && model.trim() !== "" && model.length <= 200);
    if (
      !SOURCES.includes(from as Source) ||
      !TARGETS.includes(to as Target) ||
      from === to ||
      !isObj(body) ||
      !okModel ||
      (from === "gemini" && typeof model !== "string")
    ) {
      return c.json({ error: "invalid_input", hint: HINT }, 400);
    }
    try {
      return c.json({ result: translate(from as Source, to as Target, body, typeof model === "string" ? model.trim() : null) });
    } catch (e) {
      return c.json({ error: "translate_failed", message: e instanceof Error ? e.message : "the request could not be translated" }, 400);
    }
  });
}
