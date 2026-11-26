import { describe, expect, it } from "vitest";
import { chunks, cues, srt, timestamp } from "../src/srt.ts";

describe("subtitles", () => {
  it("formats SRT timestamps", () => {
    expect(timestamp(0)).toBe("00:00:00,000");
    expect(timestamp(3661.5)).toBe("01:01:01,500");
  });

  it("cuts text at sentence ends, then between words", () => {
    expect(chunks("Một hai ba. Bốn năm sáu bảy tám chín mười mười một mười hai", 20)).toEqual(["Một hai ba.", "Bốn năm sáu bảy tám", "chín mười mười một", "mười hai"]);
  });

  it("spreads each scene's time over its pieces and follows the scenes one after the other", () => {
    const c = cues(
      [
        { text: "aaaa. bbbb.", duration: 2 },
        { text: "cc", duration: 3 },
      ],
      10,
    );
    expect(c).toEqual([
      { start: 0, end: 1, text: "aaaa." },
      { start: 1, end: 2, text: "bbbb." },
      { start: 2, end: 5, text: "cc" },
    ]);
    expect(srt(c)).toBe("1\n00:00:00,000 --> 00:00:01,000\naaaa.\n\n2\n00:00:01,000 --> 00:00:02,000\nbbbb.\n\n3\n00:00:02,000 --> 00:00:05,000\ncc\n");
  });
});
