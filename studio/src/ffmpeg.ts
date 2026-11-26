import { spawn } from "node:child_process";

/** The ffmpeg calls that make a clip. Each builder returns the arguments; `run` starts ffmpeg in the project's folder. */

export const W = 1080;
export const H = 1920;
export const FPS = 30;

const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS)];

const sec = (n: number) => n.toFixed(3);

/**
 * A still as a moving shot (Ken Burns): scaled to cover 9:16 at twice the size (so zoompan does not jitter), then a
 * slow zoom in, or out on odd scenes, toward the centre.
 */
export function stillSegment(image: string, duration: number, out: string, index = 0): string[] {
  const frames = Math.max(1, Math.round(duration * FPS));
  const step = (0.2 / frames).toFixed(6);
  const zoom = index % 2 === 0 ? `min(1+${step}*on,1.2)` : `max(1.2-${step}*on,1)`;
  const vf = [
    `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase`,
    `crop=${W * 2}:${H * 2}`,
    `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`,
    "format=yuv420p",
  ].join(",");
  return ["-y", "-i", image, "-vf", vf, "-frames:v", String(frames), "-an", ...X264, out];
}

/** A video clip cut or looped to `duration`, cropped to fill 9:16, without its sound. */
export function videoSegment(clip: string, duration: number, out: string): string[] {
  const vf = [`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`, `fps=${FPS}`, "setsar=1", "format=yuv420p"].join(",");
  return ["-y", "-stream_loop", "-1", "-i", clip, "-t", sec(duration), "-vf", vf, "-an", ...X264, out];
}

/** One scene's voice padded with silence to the scene's length, as 44.1 kHz stereo WAV; no voice: silence. */
export function audioSegment(voice: string | null, duration: number, out: string): string[] {
  if (!voice) return ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", sec(duration), "-c:a", "pcm_s16le", out];
  return ["-y", "-i", voice, "-af", "apad", "-t", sec(duration), "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", out];
}

/** The concat demuxer's list: one `file` line per segment, quotes escaped. */
export function concatList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

export function concat(list: string, out: string): string[] {
  return ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out];
}

/** An ASS colour/style for the burned-in subtitles: white, black outline, low in the frame. */
export function subtitleStyle(font: string): string {
  return [`FontName=${font}`, "FontSize=13", "PrimaryColour=&H00FFFFFF", "OutlineColour=&H00000000", "BorderStyle=1", "Outline=2", "Shadow=0", "Alignment=2", "MarginV=60"].join(",");
}

/** Escapes a value for an ffmpeg filter argument (inside single quotes). */
const filterQuote = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "'\\''")}'`;

/**
 * The final MP4: video, voice, subtitles burned in (`subs` null: none), ready for streaming (faststart).
 * `fontsDir`: a folder of font files libass reads besides the system's (a machine without fontconfig fonts).
 */
export function finalMux(video: string, audio: string, subs: string | null, font: string, out: string, fontsDir: string | null = null): string[] {
  const args = ["-y", "-i", video, "-i", audio];
  const dir = fontsDir ? `:fontsdir=${filterQuote(fontsDir)}` : "";
  if (subs) args.push("-vf", `subtitles=${filterQuote(subs)}${dir}:force_style=${filterQuote(subtitleStyle(font))}`, ...X264);
  else args.push("-c:v", "copy");
  args.push("-c:a", "aac", "-b:a", "160k", "-map", "0:v:0", "-map", "1:a:0", "-shortest", "-movflags", "+faststart", out);
  return args;
}

export class FfmpegError extends Error {}

export function run(bin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    p.on("error", (e) => reject(new FfmpegError(`${bin}: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new FfmpegError(`${bin} exited ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`))));
  });
}

export const ffmpeg = (args: string[], cwd: string) => run(process.env.FFMPEG ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], cwd);

/** A media file's length in seconds. */
export async function duration(file: string, cwd: string): Promise<number> {
  const out = await run(process.env.FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], cwd);
  const d = Number(out.trim());
  if (!Number.isFinite(d) || d <= 0) throw new FfmpegError(`could not read the length of ${file}`);
  return d;
}
