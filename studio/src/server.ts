import { Hono, type Context } from "hono";
import { createReadStream, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import type { AiRouter } from "./ai-router.ts";
import type { Config } from "./config.ts";
import { open, seal } from "./crypto.ts";
import type { Mode, Project, Step, Store } from "./db.ts";
import { STEPS, projectDir, rewind } from "./pipeline.ts";
import { PUBLISHERS, publisherOf } from "./publishers/index.ts";

export interface ServerDeps {
  store: Store;
  ai: AiRouter;
  config: Config;
  /** Wakes the queue after a change. */
  kick?: () => void;
  /** Takes new settings at once (the queue's public base URL). */
  applySettings?: (s: { publicBaseUrl: string | null }) => void;
}

/**
 * Settings ai-router's console sends: the gateway token of the studio's system (sealed with CHANNELS_KEY when there
 * is one) and the public base URL. A stored value wins over the environment's. Read at start by `loadSettings`.
 */
export function loadSettings(store: Store, config: Config, ai: AiRouter): void {
  const token = store.setting("ai_router_token");
  if (token) {
    try {
      ai.setToken(config.channelsKey && token.startsWith("sealed:") ? open<{ t: string }>(config.channelsKey, token.slice(7)).t : token.replace(/^plain:/, ""));
    } catch {
      // A changed CHANNELS_KEY: the stored token is unreadable; the console connects again.
    }
  }
  const base = store.setting("public_base_url");
  if (base) config.publicBaseUrl = base;
}

const FILE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav", srt: "text/plain; charset=utf-8" };
const SAFE_FILE = /^[a-z0-9-]+\.(png|jpg|mp4|mp3|wav|srt)$/;
const ID = /^[0-9a-f-]{36}$/;

const sha = (s: string) => createHash("sha256").update(s).digest();

export function createApp(d: ServerDeps): Hono {
  const app = new Hono();
  const want = sha(d.config.secret);
  const signedIn = (c: Context) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    return !!bearer && timingSafeEqual(sha(bearer), want);
  };

  app.get("/", (c) => c.text("clip-studio: JSON API under /api (README)\n"));
  app.get("/health", (c) => c.json({ ok: true }));

  // Without sign-in, for previews and for Instagram and Zalo: the finished clip and its cover. Ids are random UUIDs.
  app.get("/files/:name{[0-9a-f-]{36}\\.(mp4|jpg)}", (c) => {
    const [id, ext] = c.req.param("name").split(".");
    return sendFile(c, d.config.dataDir, id!, ext === "mp4" ? "final.mp4" : "cover.jpg");
  });

  app.use("/api/*", async (c, next) => (signedIn(c) ? next() : c.json({ error: "unauthorized" }, 401)));

  app.get("/api/models", async (c) => {
    try {
      return c.json({ models: await d.ai.models() });
    } catch (e) {
      return c.json({ models: [], error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/projects", (c) => c.json({ projects: d.store.projects().map(summary) }));

  app.post("/api/projects", async (c) => {
    const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const str = (k: string, def = "") => (typeof b[k] === "string" ? (b[k] as string).trim() : def);
    const topic = str("topic");
    if (!topic) return c.json({ error: "topic: what the clip is about" }, 400);
    const mode = (["image", "video", "mixed"].includes(str("mode")) ? str("mode") : "image") as Mode;
    const p: Project = {
      id: randomUUID(),
      topic: topic.slice(0, 2000),
      language: str("language") === "en" ? "en" : "vi",
      duration: Math.max(10, Math.min(180, Number(b.duration) || 30)),
      mode,
      chat_model: str("chat_model"),
      image_model: str("image_model"),
      video_model: mode === "image" ? "" : str("video_model"),
      tts_model: str("tts_model"),
      voice: str("voice", "alloy"),
      image_size: /^\d+x\d+$/.test(str("image_size")) ? str("image_size") : "1024x1536",
      step: "script",
      status: "queued",
      error: null,
      plan: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    if (!p.chat_model) return c.json({ error: "chat_model: the model that writes the script" }, 400);
    if (!p.image_model) return c.json({ error: "image_model: the model that draws the scenes (also the fallback of video scenes)" }, 400);
    if (mode !== "image" && !p.video_model) return c.json({ error: "video_model: needed for video or mixed clips" }, 400);
    d.store.insertProject(p);
    d.kick?.();
    return c.json({ project: p }, 201);
  });

  app.get("/api/projects/:id", (c) => {
    const p = d.store.project(c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const dir = projectDir(d.config.dataDir, p.id);
    return c.json({
      project: p,
      // Paths on this service; the clip and cover need no sign-in.
      final: existsSync(join(dir, "final.mp4")) && p.step === "done" ? { video: `/files/${p.id}.mp4`, cover: `/files/${p.id}.jpg` } : null,
      publications: d.store.publications(p.id),
    });
  });

  /** Edits the plan (title, description, hashtags, scenes' narration and visual) before the later steps run again. */
  app.put("/api/projects/:id/plan", async (c) => {
    const p = d.store.project(c.req.param("id"));
    if (!p?.plan) return c.json({ error: "not found" }, 404);
    if (p.status === "running") return c.json({ error: "the project is running" }, 409);
    const b = (await c.req.json().catch(() => null)) as { title?: unknown; description?: unknown; hashtags?: unknown; scenes?: { narration?: unknown; visual?: unknown }[] } | null;
    if (!b) return c.json({ error: "body must be JSON" }, 400);
    const plan = p.plan;
    if (typeof b.title === "string" && b.title.trim()) plan.title = b.title.trim().slice(0, 100);
    if (typeof b.description === "string") plan.description = b.description.slice(0, 4000);
    if (Array.isArray(b.hashtags)) plan.hashtags = b.hashtags.filter((h): h is string => typeof h === "string").map((h) => h.replace(/^#+/, "").trim()).filter(Boolean).slice(0, 10);
    d.store.updateProject(p.id, { plan });
    let from: Step | null = null;
    if (Array.isArray(b.scenes)) {
      const changed = b.scenes.map((s, i) => {
        const sc = plan.scenes[i];
        if (!sc) return { said: false, drawn: false };
        const said = typeof s.narration === "string" && s.narration.trim() !== sc.narration;
        const drawn = typeof s.visual === "string" && s.visual.trim() !== sc.visual;
        if (said) sc.narration = (s.narration as string).trim();
        if (drawn) sc.visual = (s.visual as string).trim();
        return { said, drawn };
      });
      if (changed.some((x) => x.said)) from = "voice";
      else if (changed.some((x) => x.drawn)) from = "assets";
      if (from) {
        rewind(d.store, d.config.dataDir, { ...p, plan }, from);
        d.kick?.();
      }
    }
    return c.json({ project: d.store.project(p.id), rerun: from });
  });

  /** Runs again from `step` (default: the step that failed). */
  app.post("/api/projects/:id/retry", async (c) => {
    const p = d.store.project(c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    if (p.status === "running") return c.json({ error: "the project is running" }, 409);
    const b = (await c.req.json().catch(() => ({}))) as { step?: unknown };
    const step = typeof b.step === "string" && STEPS.includes(b.step as Step) && b.step !== "done" ? (b.step as Step) : p.step === "done" ? "render" : p.step;
    rewind(d.store, d.config.dataDir, p, step);
    d.kick?.();
    return c.json({ project: d.store.project(p.id) });
  });

  app.delete("/api/projects/:id", (c) => {
    const p = d.store.project(c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    if (p.status === "running") return c.json({ error: "the project is running" }, 409);
    d.store.deleteProject(p.id);
    rmSync(projectDir(d.config.dataDir, p.id), { recursive: true, force: true });
    return c.body(null, 204);
  });

  /** Puts the clip in line for channels, now or at `at` (ms since epoch). */
  app.post("/api/projects/:id/publish", async (c) => {
    const p = d.store.project(c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    if (p.step !== "done") return c.json({ error: "the clip is not rendered yet" }, 409);
    const b = (await c.req.json().catch(() => null)) as { channels?: unknown; at?: unknown } | null;
    const ids = Array.isArray(b?.channels) ? b.channels.filter((x): x is string => typeof x === "string") : [];
    if (!ids.length) return c.json({ error: "channels: at least one" }, 400);
    const at = typeof b?.at === "number" && b.at > Date.now() ? b.at : Date.now();
    for (const id of ids) {
      if (!d.store.channel(id)) return c.json({ error: `no channel ${id}` }, 400);
      d.store.insertPublication({ id: randomUUID(), project_id: p.id, channel_id: id, status: "pending", scheduled_at: at, external_id: null, url: null, error: null, updated_at: Date.now() });
    }
    d.kick?.();
    return c.json({ publications: d.store.publications(p.id) }, 201);
  });

  app.post("/api/publications/:id/retry", (c) => {
    const pub = d.store.publication(c.req.param("id"));
    if (!pub) return c.json({ error: "not found" }, 404);
    if (pub.status !== "failed") return c.json({ error: "only a failed publication is retried" }, 409);
    d.store.updatePublication(pub.id, { status: "pending", error: null, scheduled_at: Date.now() });
    d.kick?.();
    return c.json({ publication: d.store.publication(pub.id) });
  });

  // Channels: credentials go in, never out. The answer says which secret fields are set, not their values.
  app.get("/api/channel-kinds", (c) =>
    c.json({ kinds: PUBLISHERS.map((p) => ({ kind: p.kind, name: p.name, secretFields: p.secretFields, configFields: p.configFields })), canStore: !!d.config.channelsKey }),
  );

  app.get("/api/channels", (c) => c.json({ channels: d.store.channels().map(({ secret: _s, ...rest }) => rest) }));

  app.post("/api/channels", async (c) => {
    if (!d.config.channelsKey) return c.json({ error: "CHANNELS_KEY is not set: credentials cannot be stored" }, 500);
    const b = (await c.req.json().catch(() => null)) as { kind?: unknown; name?: unknown; secret?: unknown; config?: unknown } | null;
    const pub = typeof b?.kind === "string" ? publisherOf(b.kind) : undefined;
    if (!pub) return c.json({ error: "kind: one of " + PUBLISHERS.map((p) => p.kind).join(", ") }, 400);
    const pick = (o: unknown, fields: { key: string; optional?: boolean }[]) => {
      const out: Record<string, string> = {};
      for (const f of fields) {
        const v = o && typeof o === "object" ? (o as Record<string, unknown>)[f.key] : undefined;
        if (typeof v === "string" && v.trim()) out[f.key] = v.trim();
        else if (!f.optional) return f.key;
      }
      return out;
    };
    const secret = pick(b?.secret, pub.secretFields);
    if (typeof secret === "string") return c.json({ error: `secret.${secret} is needed` }, 400);
    const config = pick(b?.config, pub.configFields);
    if (typeof config === "string") return c.json({ error: `config.${config} is needed` }, 400);
    const name = typeof b?.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : pub.name;
    const ch = { id: randomUUID(), kind: pub.kind, name, secret: seal(d.config.channelsKey, secret), config, created_at: Date.now() };
    d.store.insertChannel(ch);
    const { secret: _s, ...shown } = ch;
    return c.json({ channel: shown }, 201);
  });

  app.delete("/api/channels/:id", (c) => {
    d.store.deleteChannel(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/settings", (c) =>
    c.json({ ai_router_url: d.config.aiRouterUrl, has_token: d.ai.hasToken, public_base_url: d.config.publicBaseUrl, can_store: !!d.config.channelsKey }),
  );

  app.put("/api/settings", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { ai_router_token?: unknown; public_base_url?: unknown } | null;
    if (!b || typeof b !== "object") return c.json({ error: "body must be a JSON object" }, 400);
    if (b.ai_router_token !== undefined) {
      if (typeof b.ai_router_token !== "string" || !b.ai_router_token.trim() || b.ai_router_token.length > 512) return c.json({ error: "ai_router_token: a gateway token" }, 400);
      const t = b.ai_router_token.trim();
      d.store.setSetting("ai_router_token", d.config.channelsKey ? `sealed:${seal(d.config.channelsKey, { t })}` : `plain:${t}`);
      d.ai.setToken(t);
    }
    if (b.public_base_url !== undefined) {
      const u = b.public_base_url;
      if (u !== null && (typeof u !== "string" || !/^https?:\/\/[^\s]+$/.test(u) || u.length > 300)) return c.json({ error: "public_base_url: an http(s) URL or null" }, 400);
      const base = u === null ? null : u.replace(/\/+$/, "");
      d.store.setSetting("public_base_url", base);
      d.config.publicBaseUrl = base;
      d.applySettings?.({ publicBaseUrl: base });
    }
    return c.json({ ai_router_url: d.config.aiRouterUrl, has_token: d.ai.hasToken, public_base_url: d.config.publicBaseUrl, can_store: !!d.config.channelsKey });
  });

  /** A project's files: scene images, clips, voices, subtitles, the final MP4 (Range requests for seeking). */
  app.get("/api/projects/:id/files/:file", (c) => sendFile(c, d.config.dataDir, c.req.param("id"), c.req.param("file")));

  return app;
}

const summary = (p: Project) => ({ id: p.id, topic: p.topic, title: p.plan?.title ?? null, step: p.step, status: p.status, error: p.error, mode: p.mode, created_at: p.created_at });

/** A file of a project's folder, with Range support so the browser can seek in videos. */
function sendFile(c: Context, dataDir: string, id: string, file: string): Response {
  if (!ID.test(id) || !SAFE_FILE.test(file)) return c.text("not found", 404);
  const path = join(projectDir(dataDir, id), file);
  if (!existsSync(path)) return c.text("not found", 404);
  const size = statSync(path).size;
  const type = FILE_TYPES[file.split(".").pop()!]!;
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, {
      status: 206,
      headers: { "content-type": type, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" },
    });
  }
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    headers: { "content-type": type, "content-length": String(size), "accept-ranges": "bytes", "cache-control": "no-cache" },
  });
}
