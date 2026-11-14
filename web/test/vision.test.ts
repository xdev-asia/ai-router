import { beforeEach, describe, expect, it } from "vitest";
import type { Combo } from "../api";
import { resetLang } from "../i18n";
import { visionBody, visionChanged, visionPickerItems, type VisionAdapter } from "../pages/Combos";

const combo = (name: string, targets: string[]): Combo => ({ name, targets, updated_at: 1 });
const ALL = [combo("fast", ["groq/llama", "claude-haiku-5-5"]), combo("team", ["openai/gpt-5", "combo/fast"])];
const ids = (items: { id: string }[]) => items.map((i) => i.id);
const ON: VisionAdapter = { enabled: true, models: ["openai/vis-a"], applies_to: ["groq/*"] };

beforeEach(() => resetLang());

describe("visionPickerItems", () => {
  it("offers a typed model and the models combos use for the pool, never a combo", () => {
    expect(ids(visionPickerItems("", [], ALL, "pool"))).toEqual(["claude-haiku-5-5", "groq/llama", "openai/gpt-5"]);
    expect(ids(visionPickerItems("openai/vis-a", [], ALL, "pool"))).toEqual(["openai/vis-a"]);
    expect(ids(visionPickerItems("combo/fast", [], ALL, "pool"))).toEqual([]);
    expect(ids(visionPickerItems("groq/*", [], ALL, "pool"))).toEqual([]);
  });

  it("offers *, provider/*, combos and models for the applies-to list", () => {
    expect(ids(visionPickerItems("", [], ALL, "targets"))).toEqual(["*", "combo/fast", "combo/team", "claude-haiku-5-5", "groq/llama", "openai/gpt-5"]);
    expect(ids(visionPickerItems("groq/*", [], ALL, "targets"))).toEqual(["groq/*"]);
    expect(ids(visionPickerItems("not valid", [], ALL, "targets"))).toEqual([]);
  });

  it("leaves out what the list already holds", () => {
    expect(ids(visionPickerItems("", ["*", "combo/fast", "groq/llama"], ALL, "targets"))).toEqual(["combo/team", "claude-haiku-5-5", "openai/gpt-5"]);
    expect(ids(visionPickerItems("openai/gpt-5", ["openai/gpt-5"], ALL, "pool"))).toEqual([]);
  });
});

describe("visionBody and visionChanged", () => {
  it("sees a reorder, an add and a removal as a change", () => {
    expect(visionChanged(ON, ON.models, ON.applies_to)).toBe(false);
    expect(visionChanged(ON, ["openai/vis-a", "openai/vis-b"], ON.applies_to)).toBe(true);
    expect(visionChanged({ ...ON, models: ["a/x", "b/y"] }, ["b/y", "a/x"], ON.applies_to)).toBe(true);
    expect(visionChanged(ON, ON.models, [])).toBe(true);
  });

  it("keeps the switch while both lists have an entry, and turns it off when one is empty", () => {
    expect(visionBody(ON, ["openai/vis-b"], ["*"])).toEqual({ enabled: true, models: ["openai/vis-b"], applies_to: ["*"] });
    expect(visionBody(ON, [], ["*"])).toEqual({ enabled: false, models: [], applies_to: ["*"] });
    expect(visionBody(ON, ["openai/vis-a"], [])).toEqual({ enabled: false, models: ["openai/vis-a"], applies_to: [] });
    expect(visionBody({ ...ON, enabled: false }, ["openai/vis-a"], ["*"]).enabled).toBe(false);
  });
});
