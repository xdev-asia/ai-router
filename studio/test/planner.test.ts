import { describe, expect, it } from "vitest";
import { caption, parsePlan, planPrompt } from "../src/planner.ts";

const answer = {
  title: "5 mẹo ChatGPT",
  description: "Mẹo nhanh cho dân văn phòng.",
  hashtags: ["#ChatGPT", "AI tips", ""],
  scenes: [
    { narration: "Bạn có biết?", visual: "office desk at dawn", kind: "video" },
    { narration: "Mẹo một.", visual: "laptop screen glow", kind: "image" },
    { narration: "", visual: "dropped: no narration" },
  ],
};

describe("parsePlan", () => {
  it("reads JSON inside a code fence and words around it", () => {
    const p = parsePlan("Here you go:\n```json\n" + JSON.stringify(answer) + "\n```\nEnjoy", "mixed");
    expect(p.title).toBe("5 mẹo ChatGPT");
    expect(p.hashtags).toEqual(["ChatGPT", "AItips"]);
    expect(p.scenes.map((s) => s.kind)).toEqual(["video", "image"]);
  });

  it("forces the project's mode unless it is mixed", () => {
    expect(parsePlan(JSON.stringify(answer), "image").scenes.every((s) => s.kind === "image")).toBe(true);
    expect(parsePlan(JSON.stringify(answer), "video").scenes.every((s) => s.kind === "video")).toBe(true);
  });

  it("refuses an answer with no scenes or no JSON", () => {
    expect(() => parsePlan("sorry, I can't", "image")).toThrow(/no JSON/);
    expect(() => parsePlan('{"title":"x","scenes":[]}', "image")).toThrow(/no scenes/);
    expect(() => parsePlan("{not json}", "image")).toThrow(/not valid/);
  });

  it("falls back to the first narration for a missing title", () => {
    expect(parsePlan(JSON.stringify({ scenes: answer.scenes }), "image").title).toBe("Bạn có biết?");
  });
});

describe("planPrompt", () => {
  it("asks about one scene per 5 seconds, in the project's language", () => {
    const [, user] = planPrompt("topic", "vi", 30, "mixed");
    expect(user!.content).toContain("6 scenes");
    expect(user!.content).toContain("Vietnamese");
    expect(user!.content).toContain('"video"');
  });
});

describe("caption", () => {
  it("joins description and hashtags", () => {
    expect(caption({ title: "t", description: "d", hashtags: ["a", "b"], scenes: [] })).toBe("d\n\n#a #b");
  });
});
