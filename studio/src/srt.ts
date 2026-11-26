/** Subtitles: each scene's narration cut into short lines shown over that scene's time. */

export interface Timed {
  text: string;
  /** Seconds. */
  duration: number;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Splits text into pieces of at most `max` characters, at sentence ends first, then between words. */
export function chunks(text: string, max = 42): string[] {
  const out: string[] = [];
  for (const sentence of text.replace(/\s+/g, " ").trim().split(/(?<=[.!?…;:])\s+/)) {
    let line = "";
    for (const word of sentence.split(" ")) {
      if (!word) continue;
      if (line && line.length + 1 + word.length > max) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out;
}

/** Cues for scenes played one after the other; a scene's time is shared by its pieces by their length. */
export function cues(scenes: Timed[], max = 42): Cue[] {
  const out: Cue[] = [];
  let t = 0;
  for (const s of scenes) {
    const parts = chunks(s.text, max);
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let at = t;
    for (const p of parts) {
      const d = (s.duration * p.length) / total;
      out.push({ start: at, end: at + d, text: p });
      at += d;
    }
    t += s.duration;
  }
  return out;
}

export function timestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function srt(list: Cue[]): string {
  return list.map((c, i) => `${i + 1}\n${timestamp(c.start)} --> ${timestamp(c.end)}\n${c.text}\n`).join("\n");
}
