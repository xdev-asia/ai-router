import type { ChatMessage } from "./ai-router.ts";
import type { Mode, Plan, Scene } from "./db.ts";

/** About how long one scene lasts, in seconds. */
export const SCENE_SECONDS = 5;

export function planPrompt(topic: string, language: "vi" | "en", duration: number, mode: Mode): ChatMessage[] {
  const scenes = Math.max(2, Math.min(20, Math.round(duration / SCENE_SECONDS)));
  const lang = language === "vi" ? "Vietnamese" : "English";
  const kind =
    mode === "mixed"
      ? `Set "kind" to "video" for the 1 to ${Math.max(1, Math.floor(scenes / 3))} scenes that need motion most, "image" for the others.`
      : `Set "kind" to "${mode}" for every scene.`;
  return [
    {
      role: "system",
      content:
        "You write short vertical videos (YouTube Shorts, TikTok, Reels). Answer with one JSON object and nothing else, in this shape: " +
        '{"title": string, "description": string, "hashtags": string[], "scenes": [{"narration": string, "visual": string, "kind": "image" | "video"}]}.',
    },
    {
      role: "user",
      content: [
        `Topic: ${topic}`,
        `Length: about ${duration} seconds, ${scenes} scenes.`,
        `title, description, hashtags and narration in ${lang}. The title at most 90 characters; 3 to 6 hashtags without "#".`,
        "narration: what the voice says in that scene, one or two short sentences, spoken naturally. The first scene hooks the viewer.",
        "visual: an English prompt for an image or video model: subject, setting, light, style, vertical 9:16 framing. No text or letters in the picture.",
        kind,
      ].join("\n"),
    },
  ];
}

/** The plan in a model's answer: the JSON object, even inside a code fence or with words around it. */
export function parsePlan(text: string, mode: Mode): Plan {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the model answered no JSON object");
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("the model's JSON is not valid");
  }
  const o = raw as Record<string, unknown>;
  const scenesRaw = Array.isArray(o.scenes) ? o.scenes : [];
  const scenes: Scene[] = scenesRaw.flatMap((s): Scene[] => {
    if (!s || typeof s !== "object") return [];
    const r = s as Record<string, unknown>;
    const narration = typeof r.narration === "string" ? r.narration.trim() : "";
    const visual = typeof r.visual === "string" ? r.visual.trim() : "";
    if (!narration || !visual) return [];
    const kind = mode === "mixed" ? (r.kind === "video" ? "video" : "image") : mode;
    return [{ narration, visual, kind }];
  });
  if (!scenes.length) throw new Error("the plan has no scenes");
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, 100) : scenes[0]!.narration.slice(0, 90);
  const hashtags = (Array.isArray(o.hashtags) ? o.hashtags : [])
    .flatMap((h) => (typeof h === "string" ? [h.replace(/^#+/, "").replace(/\s+/g, "").trim()] : []))
    .filter(Boolean)
    .slice(0, 10);
  return { title, description: typeof o.description === "string" ? o.description.trim() : "", hashtags, scenes };
}

/** The text a post carries: description and hashtags. */
export function caption(plan: Plan, max = 2200): string {
  const tags = plan.hashtags.map((h) => `#${h}`).join(" ");
  return [plan.description, tags].filter(Boolean).join("\n\n").slice(0, max);
}
