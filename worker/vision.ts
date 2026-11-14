import type { Hono } from "hono";
import type { AppEnv } from "./env";
import { allows, parseModel, providerOfPrefix, targetName } from "./providers";

/**
 * Vision adapter (on the console's Combos page): for models that cannot read images, an ordered pool of models
 * that can. When it is on and a request's model is one it applies to, each image in the request is sent to the
 * first adapter model that answers, and replaced by a text part with that model's description
 * (`[Image 1: ...]`). The audio adapter (the second row) does the same for `input_audio` parts: each clip
 * goes to a model that can hear it and is replaced by its transcript (`[Audio 1: ...]`).
 *
 * Stored in the `setting` table under "vision_adapter" and "audio_adapter" (one JSON value each, like "token_saver").
 */
export interface VisionAdapter {
  enabled: boolean;
  /** `provider/model` (or `claude-*`, kept as `anthropic/claude-*`), tried in this order. */
  models: string[];
  /** Exact `provider/model` or `combo/<name>`, `provider/*`, `combo/*`, or `*`; matched against the resolved model. */
  applies_to: string[];
}

export const VISION_OFF: VisionAdapter = { enabled: false, models: [], applies_to: [] };
export const MAX_ADAPTER_MODELS = 10;
export const MAX_APPLIES_TO = 50;
export const VISION_HINT = `enabled: boolean (on needs a model and a target); models: up to ${MAX_ADAPTER_MODELS} distinct provider/model or claude-*, no combo; applies_to: up to ${MAX_APPLIES_TO} distinct provider/model, combo/<name>, provider/*, combo/* or *`;

export type AdapterKind = "vision" | "audio";
const KEYS: Record<AdapterKind, string> = { vision: "vision_adapter", audio: "audio_adapter" };

/** The prompt each image is described with. */
export const DESCRIBE_PROMPT =
  "Describe this image for a model that cannot see it. Copy every piece of text in it word for word, and give the " +
  "details someone would need to answer questions about it. Answer with the description only.";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** An adapter model, normalised to `provider/model`; null when it is not one (a combo is not). */
function adapterModel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ref = parseModel(v.trim());
  return ref?.kind === "target" ? targetName(ref.target) : null;
}

/** An applies-to entry, normalised (`cx/*` → `codex/*`, `claude-x` → `anthropic/claude-x`); null when not valid. */
function appliesEntry(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "*") return s;
  const wild = /^([a-z][a-z0-9-]*)\/\*$/.exec(s);
  if (wild) {
    if (wild[1] === "combo") return s;
    const p = providerOfPrefix(wild[1]);
    return p ? `${p}/*` : null;
  }
  const ref = parseModel(s);
  if (!ref) return null;
  return ref.kind === "combo" ? `combo/${ref.name}` : targetName(ref.target);
}

/** A list of distinct normalised entries, or null. */
function list(v: unknown, max: number, each: (x: unknown) => string | null): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: string[] = [];
  for (const x of v) {
    const n = each(x);
    if (n === null || out.includes(n)) return null;
    out.push(n);
  }
  return out;
}

/** `current` with the fields of `patch` laid over it; null when a field is not valid, or it is on with nothing to use. */
export function mergeVisionAdapter(current: VisionAdapter, patch: Json): VisionAdapter | null {
  const next: VisionAdapter = { ...current };
  if ("enabled" in patch) {
    if (typeof patch.enabled !== "boolean") return null;
    next.enabled = patch.enabled;
  }
  if ("models" in patch) {
    const m = list(patch.models, MAX_ADAPTER_MODELS, adapterModel);
    if (!m) return null;
    next.models = m;
  }
  if ("applies_to" in patch) {
    const a = list(patch.applies_to, MAX_APPLIES_TO, appliesEntry);
    if (!a) return null;
    next.applies_to = a;
  }
  if (next.enabled && (next.models.length === 0 || next.applies_to.length === 0)) return null;
  return next;
}

export const getVisionAdapter = (db: D1Database): Promise<VisionAdapter> => getAdapter(db, "vision");

export async function getAdapter(db: D1Database, kind: AdapterKind): Promise<VisionAdapter> {
  const row = await db.prepare("SELECT value FROM setting WHERE key = ?").bind(KEYS[kind]).first<{ value: string }>();
  if (!row) return VISION_OFF;
  try {
    // Read through the write's validation: a damaged row reads as off.
    const v: unknown = JSON.parse(row.value);
    return (isObj(v) && mergeVisionAdapter(VISION_OFF, v)) || VISION_OFF;
  } catch {
    return VISION_OFF;
  }
}

export async function saveAdapter(db: D1Database, kind: AdapterKind, value: VisionAdapter): Promise<void> {
  await db
    .prepare("INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(KEYS[kind], JSON.stringify(value), Math.floor(Date.now() / 1000))
    .run();
}

/** Whether the adapter takes over images for a request whose model resolved to `name` (`provider/model` or `combo/x`). */
export const appliesTo = (cfg: VisionAdapter, name: string): boolean => cfg.enabled && cfg.models.length > 0 && allows(cfg.applies_to, name);

export interface Image {
  url: string;
  detail?: string;
}

/** The image an `image_url` part carries (`{url, detail}` or a bare string), or null for any other part. */
function imageOf(part: unknown): Image | null {
  if (!isObj(part) || part.type !== "image_url") return null;
  const iu = part.image_url;
  if (typeof iu === "string") return { url: iu };
  if (isObj(iu) && typeof iu.url === "string") return typeof iu.detail === "string" ? { url: iu.url, detail: iu.detail } : { url: iu.url };
  return null;
}

const messagesOf = (req: Json): unknown[] => (Array.isArray(req.messages) ? req.messages : []);

/** The distinct images of a chat request, in the order they first appear. */
export function imagesIn(req: Json): Image[] {
  const seen = new Map<string, Image>();
  for (const m of messagesOf(req)) {
    if (!isObj(m) || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      const img = imageOf(p);
      if (img && !seen.has(img.url)) seen.set(img.url, img);
    }
  }
  return [...seen.values()];
}

/** The non-streamed request that asks an adapter model (`model`: `provider/model`) to describe one image. */
export function describeRequest(model: string, image: Image): Json {
  return {
    model,
    stream: false,
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: DESCRIBE_PROMPT }, { type: "image_url", image_url: image }] }],
  };
}

/** `req` with each image part replaced by `[Image n: <description>]`, n counting distinct images from 1. */
export function replaceImages(req: Json, descriptions: ReadonlyMap<string, string>): Json {
  const order = [...descriptions.keys()];
  const messages = messagesOf(req).map((m) => {
    if (!isObj(m) || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((p) => {
        const img = imageOf(p);
        const text = img ? descriptions.get(img.url) : undefined;
        return img && text !== undefined ? { type: "text", text: `[Image ${order.indexOf(img.url) + 1}: ${text}]` } : p;
      }),
    };
  });
  return { ...req, messages };
}

/** The prompt each audio clip is transcribed with. */
export const TRANSCRIBE_PROMPT =
  "Transcribe this audio for a model that cannot hear it, word for word, in its own language. Note any sound that " +
  "matters to its meaning in square brackets. Answer with the transcript only.";

export interface Audio {
  data: string;
  format?: string;
}

/** The clip an `input_audio` part carries, or null for any other part. */
function audioOf(part: unknown): Audio | null {
  if (!isObj(part) || part.type !== "input_audio" || !isObj(part.input_audio)) return null;
  const { data, format } = part.input_audio;
  if (typeof data !== "string") return null;
  return typeof format === "string" ? { data, format } : { data };
}

/** The distinct audio clips of a chat request, in the order they first appear. */
export function audiosIn(req: Json): Audio[] {
  const seen = new Map<string, Audio>();
  for (const m of messagesOf(req)) {
    if (!isObj(m) || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      const a = audioOf(p);
      if (a && !seen.has(a.data)) seen.set(a.data, a);
    }
  }
  return [...seen.values()];
}

/** The non-streamed request that asks an adapter model to transcribe one clip. */
export function transcribeRequest(model: string, audio: Audio): Json {
  return {
    model,
    stream: false,
    max_tokens: 4096,
    messages: [{ role: "user", content: [{ type: "text", text: TRANSCRIBE_PROMPT }, { type: "input_audio", input_audio: audio }] }],
  };
}

/** `req` with each audio part replaced by `[Audio n: <transcript>]`, n counting distinct clips from 1. */
export function replaceAudio(req: Json, transcripts: ReadonlyMap<string, string>): Json {
  const order = [...transcripts.keys()];
  const messages = messagesOf(req).map((m) => {
    if (!isObj(m) || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((p) => {
        const a = audioOf(p);
        const text = a ? transcripts.get(a.data) : undefined;
        return a && text !== undefined ? { type: "text", text: `[Audio ${order.indexOf(a.data) + 1}: ${text}]` } : p;
      }),
    };
  });
  return { ...req, messages };
}

/** GET and PUT /admin/vision-adapter and /admin/audio-adapter. PUT takes any of the fields and keeps the others. */
export function visionAdapterRoutes(a: Hono<AppEnv>): void {
  for (const kind of ["vision", "audio"] as const) adapterRoutes(a, kind);
}

function adapterRoutes(a: Hono<AppEnv>, kind: AdapterKind): void {
  a.get(`/${kind}-adapter`, async (c) => c.json(await getAdapter(c.env.DB, kind)));

  a.put(`/${kind}-adapter`, async (c) => {
    let b: unknown = null;
    try {
      b = await c.req.json();
    } catch {
      b = null;
    }
    const next = isObj(b) ? mergeVisionAdapter(await getAdapter(c.env.DB, kind), b) : null;
    if (!next) return c.json({ error: "invalid_input", hint: VISION_HINT }, 400);
    await saveAdapter(c.env.DB, kind, next);
    return c.json(next);
  });
}
