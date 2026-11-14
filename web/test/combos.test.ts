import { beforeEach, describe, expect, it } from "vitest";
import type { Combo } from "../api";
import { resetLang } from "../i18n";
import { filterCombos, pickerItems, previewModels, strategyBody, strategyDraft } from "../pages/Combos";

const combo = (name: string, targets: string[]): Combo => ({ name, targets, updated_at: 1 });
const ALL = [combo("fast", ["groq/llama", "claude-haiku-5-5"]), combo("Smart.v2", ["openai/gpt-5", "combo/fast"])];

describe("filterCombos", () => {
  it("keeps every combo for an empty query", () => {
    expect(filterCombos(ALL, "  ")).toEqual(ALL);
  });

  it("matches the name or a model, ignoring case", () => {
    expect(filterCombos(ALL, "smart").map((c) => c.name)).toEqual(["Smart.v2"]);
    expect(filterCombos(ALL, "LLAMA").map((c) => c.name)).toEqual(["fast"]);
    expect(filterCombos(ALL, "nothing")).toEqual([]);
  });
});

describe("previewModels", () => {
  it("shows the first three and counts the rest", () => {
    expect(previewModels(["a/1", "b/2"])).toEqual({ shown: ["a/1", "b/2"], more: 0 });
    expect(previewModels(["a/1", "b/2", "c/3", "d/4", "e/5"])).toEqual({ shown: ["a/1", "b/2", "c/3"], more: 2 });
  });
});

describe("pickerItems", () => {
  beforeEach(() => resetLang());

  it("offers a typed model when it is valid", () => {
    const ids = pickerItems("openai/gpt-5-mini", [], ALL, null).map((i) => i.id);
    expect(ids[0]).toBe("openai/gpt-5-mini");
  });

  it("does not offer a typed value that is not a model", () => {
    expect(pickerItems("Not A Model", [], ALL, null).map((i) => i.id)).toEqual([]);
  });

  it("offers other combos and known models, minus the list and the combo itself", () => {
    const ids = pickerItems("", ["groq/llama"], ALL, "fast").map((i) => i.id);
    expect(ids).toContain("combo/Smart.v2");
    expect(ids).not.toContain("combo/fast");
    expect(ids).toContain("openai/gpt-5");
    expect(ids).toContain("claude-haiku-5-5");
    expect(ids).not.toContain("groq/llama");
  });

  it("filters the suggestions by the query", () => {
    expect(pickerItems("gpt", [], ALL, null).map((i) => i.id)).toEqual(["openai/gpt-5"]);
  });

  it("does not offer a combo already in the list under its bare name", () => {
    const ids = pickerItems("", ["Smart.v2"], ALL, "fast").map((i) => i.id);
    expect(ids).not.toContain("combo/Smart.v2");
  });
});

describe("strategyDraft and strategyBody", () => {
  const draft = (patch: Partial<ReturnType<typeof strategyDraft>>) => ({ ...strategyDraft(null), ...patch });

  it("starts a new combo on the gateway default", () => {
    expect(strategyDraft(null)).toEqual({ strategy: "", router: "", policy: "smart", threshold: "0.8", judge: "" });
    expect(strategyBody(strategyDraft(null))).toEqual({ strategy: null, config: null });
  });
  it("reads a saved smart combo back", () => {
    const c: Combo = { name: "s", targets: [], updated_at: 1, strategy: "smart", config: { router_model: "groq/llama", policy: "custom", threshold: 0.7 } };
    expect(strategyDraft(c)).toMatchObject({ strategy: "smart", router: "groq/llama", policy: "custom", threshold: "0.7" });
  });
  it("sends no config for fallback and round robin", () => {
    expect(strategyBody(draft({ strategy: "round-robin", router: "x/y", judge: "a/b" }))).toEqual({ strategy: "round-robin", config: null });
  });
  it("sends the router and policy for smart, the threshold only for custom", () => {
    expect(strategyBody(draft({ strategy: "smart", router: " groq/llama " }))).toEqual({ strategy: "smart", config: { router_model: "groq/llama", policy: "smart" } });
    expect(strategyBody(draft({ strategy: "smart", policy: "custom", threshold: "0.9" }))).toEqual({ strategy: "smart", config: { router_model: null, policy: "custom", threshold: 0.9 } });
  });
  it("names the wrong field", () => {
    expect(strategyBody(draft({ strategy: "smart", router: "combo/fast" }))).toEqual({ bad: "router" });
    expect(strategyBody(draft({ strategy: "smart", router: "no slash" }))).toEqual({ bad: "router" });
    expect(strategyBody(draft({ strategy: "smart", policy: "custom", threshold: "0.99" }))).toEqual({ bad: "threshold" });
    expect(strategyBody(draft({ strategy: "smart", policy: "custom", threshold: "" }))).toEqual({ bad: "threshold" });
    expect(strategyBody(draft({ strategy: "fusion", judge: "combo/fast" }))).toEqual({ bad: "judge" });
  });
  it("sends the judge for fusion, null when empty", () => {
    expect(strategyBody(draft({ strategy: "fusion" }))).toEqual({ strategy: "fusion", config: { judge_model: null } });
    expect(strategyBody(draft({ strategy: "fusion", judge: "openai/gpt-5" }))).toEqual({ strategy: "fusion", config: { judge_model: "openai/gpt-5" } });
  });
});
