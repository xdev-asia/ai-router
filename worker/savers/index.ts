/**
 * Token savers, switched on per system (see migrations/0004_savers.sql). The filters and prompt texts are
 * vendored from 9router (see THIRD_PARTY_NOTICES.md); which parts of a request they touch is decided here.
 *
 * - RTK: rewrites successful tool results (Claude `tool_result`, OpenAI `role: "tool"`) longer than 500 bytes
 *   with a filter picked from their first 1 KB (git diff/log/status, grep, find, ls, tree, build output,
 *   repeated log lines, or head+tail truncation). Lossy. Errors and user/assistant text are never touched.
 * - Caveman, Ponytail: append a style instruction to the system prompt (never to user messages).
 *
 * A request can opt out with `x-gateway-token-saver: off`.
 */
import { safeApply } from "./vendor/applyFilter.js";
import { autoDetectFilter } from "./vendor/autodetect.js";
import { CAVEMAN_PROMPTS } from "./vendor/cavemanPrompts.js";
import { MIN_COMPRESS_SIZE, RAW_CAP } from "./vendor/constants.js";
import { PONYTAIL_PROMPTS } from "./vendor/ponytailPrompt.js";

export const LEVELS = ["lite", "full", "ultra"] as const;
export type Level = (typeof LEVELS)[number];
export const isLevel = (v: unknown): v is Level => typeof v === "string" && (LEVELS as readonly string[]).includes(v);

export interface Savers {
  rtk: boolean;
  caveman: Level | null;
  ponytail: Level | null;
  /** The gateway's custom system prompt, appended after the savers' own instructions. */
  custom?: string | null;
  /** URL of the Headroom proxy when it is on (worker/headroom.ts). Not applied by `applySavers`. */
  headroom?: string | null;
}

export const OFF: Savers = { rtk: false, caveman: null, ponytail: null };

/** The gateway-wide part of the savers (worker/settings.ts), in the shape this module needs. */
export interface GatewaySavers {
  rtk: boolean;
  caveman: Level | null;
  ponytail: Level | null;
  custom_prompt: string | null;
  headroom: { enabled: boolean; url: string | null };
}

/**
 * The savers for one request: the system's own level wins over the gateway's, RTK is on when either has it on,
 * the custom prompt and Headroom come from the gateway. `x-gateway-token-saver: off` switches all of it off.
 */
export function saversFor(system: { rtk?: number | boolean; caveman?: string | null; ponytail?: string | null }, req: Request, gateway?: GatewaySavers): Savers {
  if (req.headers.get("x-gateway-token-saver")?.toLowerCase() === "off") return OFF;
  return {
    rtk: system.rtk === 1 || system.rtk === true || gateway?.rtk === true,
    caveman: isLevel(system.caveman) ? system.caveman : (gateway?.caveman ?? null),
    ponytail: isLevel(system.ponytail) ? system.ponytail : (gateway?.ponytail ?? null),
    custom: gateway?.custom_prompt ?? null,
    headroom: gateway?.headroom.enabled ? gateway.headroom.url : null,
  };
}

/** Whether `applySavers` would change the request body. */
export const anyOn = (s: Savers) => s.rtk || s.caveman !== null || s.ponytail !== null || Boolean(s.custom);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** One tool output through RTK; returns the new text and the bytes saved (0 when untouched). */
export function compressText(text: string): [string, number] {
  if (text.length < MIN_COMPRESS_SIZE || text.length > RAW_CAP) return [text, 0];
  const fn = autoDetectFilter(text);
  if (!fn) return [text, 0];
  const out = safeApply(fn, text) as string;
  // Never empty, never longer.
  if (!out || out.length >= text.length) return [text, 0];
  return [out, text.length - out.length];
}

/** RTK over a Claude Messages body, in place. Returns bytes saved. */
function compressAnthropic(body: Json): number {
  let saved = 0;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!isObj(m) || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!isObj(b) || b.type !== "tool_result" || b.is_error === true) continue;
      if (typeof b.content === "string") {
        const [t, n] = compressText(b.content);
        b.content = t;
        saved += n;
      } else if (Array.isArray(b.content)) {
        for (const part of b.content) {
          if (isObj(part) && part.type === "text" && typeof part.text === "string") {
            const [t, n] = compressText(part.text);
            part.text = t;
            saved += n;
          }
        }
      }
    }
  }
  return saved;
}

/** RTK over an OpenAI chat body, in place. Returns bytes saved. */
function compressOpenAI(body: Json): number {
  let saved = 0;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!isObj(m) || m.role !== "tool") continue;
    if (typeof m.content === "string") {
      const [t, n] = compressText(m.content);
      m.content = t;
      saved += n;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (isObj(part) && part.type === "text" && typeof part.text === "string") {
          const [t, n] = compressText(part.text);
          part.text = t;
          saved += n;
        }
      }
    }
  }
  return saved;
}

function instructions(s: Savers): string[] {
  const out: string[] = [];
  if (s.caveman) out.push(CAVEMAN_PROMPTS[s.caveman] as string);
  if (s.ponytail) out.push(PONYTAIL_PROMPTS[s.ponytail] as string);
  if (s.custom) out.push(s.custom);
  return out;
}

/** Appends to Claude's `system` (string or blocks), after any cached prefix. Skips text already there. */
function injectAnthropic(body: Json, texts: string[]): void {
  for (const text of texts) {
    const sys = body.system;
    if (sys === undefined || sys === null || sys === "") body.system = text;
    else if (typeof sys === "string") {
      if (!sys.includes(text)) body.system = `${sys}\n\n${text}`;
    } else if (Array.isArray(sys)) {
      if (!sys.some((b) => isObj(b) && b.text === text)) sys.push({ type: "text", text });
    }
  }
}

/** Appends to the first system/developer message, or adds one at the start. Skips text already there. */
function injectOpenAI(body: Json, texts: string[]): void {
  if (!Array.isArray(body.messages)) return;
  const msgs = body.messages as Json[];
  for (const text of texts) {
    const sys = msgs.find((m) => isObj(m) && (m.role === "system" || m.role === "developer"));
    if (!sys) msgs.unshift({ role: "system", content: text });
    else if (typeof sys.content === "string") {
      if (!sys.content.includes(text)) sys.content = `${sys.content}\n\n${text}`;
    } else if (Array.isArray(sys.content)) {
      if (!sys.content.some((p) => isObj(p) && p.text === text)) sys.content.push({ type: "text", text });
    } else sys.content = text;
  }
}

/** Applies the savers to a request body in `format`, in place. Returns RTK's bytes saved. */
export function applySavers(body: Json, format: "anthropic" | "openai", s: Savers): number {
  if (!anyOn(s)) return 0;
  const saved = s.rtk ? (format === "anthropic" ? compressAnthropic(body) : compressOpenAI(body)) : 0;
  const texts = instructions(s);
  if (texts.length) (format === "anthropic" ? injectAnthropic : injectOpenAI)(body, texts);
  return saved;
}
