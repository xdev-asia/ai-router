import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AiRouter } from "./ai-router.ts";
import type { Plan, Project, Scene, Step, Store } from "./db.ts";
import { audioSegment, concat, concatList, duration, ffmpeg, finalMux, stillSegment, videoSegment } from "./ffmpeg.ts";
import { parsePlan, planPrompt } from "./planner.ts";
import { cues, srt } from "./srt.ts";

/**
 * A project goes script → voice → assets → render → done. Each step is saved when it ends and skips what is
 * already on disk, so a restart or a retry goes on from where it stopped.
 */
export const STEPS: Step[] = ["script", "voice", "assets", "render", "done"];

export interface PipelineDeps {
  store: Store;
  ai: AiRouter;
  dataDir: string;
  subtitleFont: string;
  /** A folder of font files for the subtitles, besides the system's. */
  fontsDir?: string | null;
  log?: (msg: string) => void;
}

export const projectDir = (dataDir: string, id: string) => join(dataDir, "projects", id);
const pad = (i: number) => String(i + 1).padStart(2, "0");

/** Seconds a scene with no voice lasts: about 15 characters a second, 2.5 at least. */
const readingTime = (text: string) => Math.max(2.5, text.length / 15);
/** Silence after each scene's voice. */
const GAP = 0.35;
/** The clip lengths a video model is asked for. */
const VIDEO_SECONDS = [4, 8, 12];

export async function runProject(d: PipelineDeps, id: string): Promise<void> {
  const dir = projectDir(d.dataDir, id);
  mkdirSync(dir, { recursive: true });
  for (;;) {
    const p = d.store.project(id);
    if (!p || p.step === "done") return;
    d.log?.(`project ${id}: ${p.step}`);
    const plan = await STEP_RUN[p.step](d, p, dir);
    const next = STEPS[STEPS.indexOf(p.step) + 1]!;
    d.store.updateProject(id, { plan, step: next, ...(next === "done" ? { status: "done" as const, error: null } : {}) });
  }
}

type StepRun = (d: PipelineDeps, p: Project, dir: string) => Promise<Plan | null>;

const need = (p: Project): Plan => {
  if (!p.plan) throw new Error("the project has no plan");
  return p.plan;
};

const STEP_RUN: Record<Exclude<Step, "done">, StepRun> = {
  async script(d, p) {
    const text = await d.ai.chat(p.chat_model, planPrompt(p.topic, p.language, p.duration, p.mode));
    return parsePlan(text, p.mode);
  },

  async voice(d, p, dir) {
    const plan = need(p);
    for (const [i, s] of plan.scenes.entries()) {
      if (s.duration) continue;
      if (p.tts_model) {
        const file = `voice-${pad(i)}.mp3`;
        if (!existsSync(join(dir, file))) writeFileSync(join(dir, file), await d.ai.speech(p.tts_model, s.narration, p.voice || "alloy"));
        s.audio = file;
        s.duration = (await duration(file, dir)) + GAP;
      } else s.duration = readingTime(s.narration);
      d.store.updateProject(p.id, { plan });
    }
    return plan;
  },

  async assets(d, p, dir) {
    const plan = need(p);
    for (const [i, s] of plan.scenes.entries()) {
      if (s.kind === "video" && !s.video && p.video_model) {
        const file = `clip-${pad(i)}.mp4`;
        try {
          if (!existsSync(join(dir, file))) {
            const secs = VIDEO_SECONDS.find((n) => n >= (s.duration ?? 4)) ?? VIDEO_SECONDS.at(-1)!;
            writeFileSync(join(dir, file), await d.ai.video(p.video_model, s.visual, secs, "720x1280"));
          }
          s.video = file;
        } catch (e) {
          // A video model that fails leaves the scene as a still; the note says why.
          s.note = `video failed, used an image: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
        }
      }
      if (!s.video && !s.image) {
        const file = `image-${pad(i)}.png`;
        if (!existsSync(join(dir, file))) writeFileSync(join(dir, file), await d.ai.image(p.image_model, s.visual, p.image_size));
        s.image = file;
      }
      d.store.updateProject(p.id, { plan });
    }
    return plan;
  },

  async render(d, p, dir) {
    const plan = need(p);
    const videos: string[] = [];
    const audios: string[] = [];
    for (const [i, s] of plan.scenes.entries()) {
      const len = s.duration ?? readingTime(s.narration);
      const v = `seg-${pad(i)}.mp4`;
      const a = `seg-${pad(i)}.wav`;
      await ffmpeg(s.video ? videoSegment(s.video, len, v) : stillSegment(sceneImage(s), len, v, i), dir);
      await ffmpeg(audioSegment(s.audio ?? null, len, a), dir);
      videos.push(v);
      audios.push(a);
    }
    writeFileSync(join(dir, "video.txt"), concatList(videos));
    writeFileSync(join(dir, "audio.txt"), concatList(audios));
    await ffmpeg(concat("video.txt", "video.mp4"), dir);
    await ffmpeg(concat("audio.txt", "voice.wav"), dir);
    writeFileSync(join(dir, "subs.srt"), srt(cues(plan.scenes.map((s) => ({ text: s.narration, duration: s.duration ?? readingTime(s.narration) })), 30)));
    await ffmpeg(finalMux("video.mp4", "voice.wav", "subs.srt", d.subtitleFont, "final.mp4", d.fontsDir ?? null), dir);
    // The cover for posts that take one: the first scene's still, or a frame of its clip.
    const first = plan.scenes[0]!;
    await ffmpeg(first.image ? ["-y", "-i", first.image, "-vf", "scale=720:-2", "-frames:v", "1", "cover.jpg"] : ["-y", "-ss", "0.5", "-i", "final.mp4", "-frames:v", "1", "cover.jpg"], dir);
    return plan;
  },
};

function sceneImage(s: Scene): string {
  if (!s.image) throw new Error("a scene has no image");
  return s.image;
}

/** Goes back to `step`: what it and the later steps made is thrown away and made again. */
export function rewind(store: Store, dataDir: string, p: Project, step: Step): void {
  const dir = projectDir(dataDir, p.id);
  const drop = (f?: string) => f && rmSync(join(dir, f), { force: true });
  const from = STEPS.indexOf(step);
  const plan = from <= 0 ? null : p.plan;
  for (const s of (from <= 0 ? p.plan : plan)?.scenes ?? []) {
    if (from <= 1) {
      drop(s.audio);
      delete s.audio;
      delete s.duration;
    }
    if (from <= 2) {
      drop(s.image);
      drop(s.video);
      delete s.image;
      delete s.video;
      delete s.note;
    }
  }
  store.updateProject(p.id, { step, status: "queued", error: null, plan });
}
