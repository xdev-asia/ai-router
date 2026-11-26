import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AiRouter } from "../src/ai-router.ts";
import { Store } from "../src/db.ts";
import { audioSegment, concatList, duration, finalMux, stillSegment, videoSegment } from "../src/ffmpeg.ts";
import { projectDir } from "../src/pipeline.ts";
import { Queue } from "../src/queue.ts";
import { fakeServer } from "./fake-server.ts";

describe("ffmpeg commands", () => {
  it("makes a still into a 9:16 Ken Burns shot of the scene's length", () => {
    const a = stillSegment("image-01.png", 2, "seg-01.mp4", 0);
    expect(a.slice(0, 3)).toEqual(["-y", "-i", "image-01.png"]);
    const vf = a[a.indexOf("-vf") + 1]!;
    expect(vf).toContain("zoompan=z='min(1+");
    expect(vf).toContain("d=60:s=1080x1920:fps=30");
    expect(a[a.indexOf("-frames:v") + 1]).toBe("60");
    expect(stillSegment("i.png", 2, "o.mp4", 1)[4]).toContain("max(1.2-");
    expect(a.at(-1)).toBe("seg-01.mp4");
  });

  it("loops or cuts a video clip to the scene's length, without sound", () => {
    const a = videoSegment("clip-01.mp4", 4.25, "seg.mp4");
    expect(a).toEqual(expect.arrayContaining(["-stream_loop", "-1", "-t", "4.250", "-an"]));
    expect(a[a.indexOf("-vf") + 1]).toContain("crop=1080:1920");
  });

  it("pads a voice with silence, or makes silence", () => {
    expect(audioSegment("v.mp3", 3, "a.wav")).toEqual(expect.arrayContaining(["-i", "v.mp3", "-af", "apad", "-t", "3.000"]));
    expect(audioSegment(null, 3, "a.wav")).toEqual(expect.arrayContaining(["lavfi", "anullsrc=r=44100:cl=stereo"]));
  });

  it("escapes quotes in the concat list", () => {
    expect(concatList(["a.mp4", "it's.mp4"])).toBe("file 'a.mp4'\nfile 'it'\\''s.mp4'\n");
  });

  it("burns subtitles in with the configured font", () => {
    const a = finalMux("video.mp4", "voice.wav", "subs.srt", "DejaVu Sans", "final.mp4");
    expect(a[a.indexOf("-vf") + 1]).toBe("subtitles='subs.srt':force_style='FontName=DejaVu Sans,FontSize=13,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=60'");
    expect(a).toEqual(expect.arrayContaining(["-movflags", "+faststart", "-shortest"]));
    expect(finalMux("v", "a", null, "f", "o")).toEqual(expect.arrayContaining(["-c:v", "copy"]));
    const withDir = finalMux("v", "a", "s.srt", "Arial", "o", "/fonts");
    expect(withDir[withDir.indexOf("-vf") + 1]).toMatch(/^subtitles='s.srt':fontsdir='\/fonts':force_style=/);
  });
});

const hasFfmpeg = spawnSync(process.env.FFMPEG ?? "ffmpeg", ["-version"]).status === 0;
const tmp = mkdtempSync(join(tmpdir(), "clip-studio-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function make(args: string[], out: string): Buffer {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, join(tmp, out)]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return readFileSync(join(tmp, out));
}

describe.runIf(hasFfmpeg)("the whole pipeline, with a fake ai-router and real ffmpeg", () => {
  it("writes the script, voices, draws, renders a 1080x1920 clip with sound", async () => {
    const red = make(["-f", "lavfi", "-i", "color=c=red:s=256x384", "-frames:v", "1"], "red.png");
    const blue = make(["-f", "lavfi", "-i", "color=c=blue:s=384x256", "-frames:v", "1"], "blue.png");
    const tone = make(["-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-c:a", "libmp3lame"], "tone.mp3");
    const clip = make(["-f", "lavfi", "-i", "testsrc=s=320x240:r=24:d=1.5", "-pix_fmt", "yuv420p"], "clip.mp4");
    let images = 0;
    const ai = await fakeServer((r) => {
      if (r.path === "/v1/chat/completions")
        return {
          json: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "Thử nghiệm",
                    description: "Một clip thử",
                    hashtags: ["test"],
                    scenes: [
                      { narration: "Cảnh đầu tiên, có tiếng Việt.", visual: "red", kind: "image" },
                      { narration: "Cảnh video.", visual: "motion", kind: "video" },
                      { narration: "Cảnh cuối.", visual: "blue", kind: "image" },
                    ],
                  }),
                },
              },
            ],
          },
        };
      if (r.path === "/v1/images/generations") return { json: { data: [{ b64_json: (images++ % 2 ? blue : red).toString("base64") }] } };
      if (r.path === "/v1/audio/speech") return { body: tone, headers: { "content-type": "audio/mpeg" } };
      if (r.path === "/v1/videos") return { body: clip, headers: { "content-type": "video/mp4" } };
      return { status: 404 };
    });
    try {
      const store = new Store(":memory:");
      const queue = new Queue({ store, ai: new AiRouter({ baseUrl: ai.url, token: "t" }), dataDir: tmp, subtitleFont: process.env.SUBTITLE_FONT ?? "DejaVu Sans", fontsDir: process.env.SUBTITLE_FONTS_DIR ?? null, channelsKey: null, publicBaseUrl: null });
      const now = Date.now();
      store.insertProject({
        id: "00000000-0000-4000-8000-000000000001",
        topic: "test",
        language: "vi",
        duration: 15,
        mode: "mixed",
        chat_model: "a/chat",
        image_model: "a/img",
        video_model: "a/vid",
        tts_model: "a/tts",
        voice: "alloy",
        image_size: "1024x1536",
        step: "script",
        status: "queued",
        error: null,
        plan: null,
        created_at: now,
        updated_at: now,
      });
      await queue.tick();
      const p = store.project("00000000-0000-4000-8000-000000000001")!;
      expect(p.error).toBeNull();
      expect(p.status).toBe("done");
      expect(p.plan!.scenes.map((s) => [s.kind, !!s.image, !!s.video, !!s.audio])).toEqual([
        ["image", true, false, true],
        ["video", false, true, true],
        ["image", true, false, true],
      ]);
      const dir = projectDir(tmp, p.id);
      expect(existsSync(join(dir, "cover.jpg"))).toBe(true);
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "csv=p=0", join(dir, "final.mp4")]).stdout.toString();
      expect(probe).toContain("video,1080,1920");
      expect(probe).toContain("audio");
      const total = p.plan!.scenes.reduce((n, s) => n + s.duration!, 0);
      expect(Math.abs((await duration("final.mp4", dir)) - total)).toBeLessThan(0.3);
      expect(readFileSync(join(dir, "subs.srt"), "utf8")).toContain("Cảnh đầu tiên, có tiếng Việt.");
      // SAMPLE_OUT=<path>: keep the clip to look at.
      if (process.env.SAMPLE_OUT) copyFileSync(join(dir, "final.mp4"), process.env.SAMPLE_OUT);
    } finally {
      await ai.close();
    }
  });
});
