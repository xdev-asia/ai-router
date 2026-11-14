import { beforeEach, describe, expect, it } from "vitest";
import type { Connection, Provider, UsageSummary } from "../api";
import { resetLang } from "../i18n";
import { flowNodes } from "../pages/Usage";

const conn = (provider: string) => ({ id: `c-${provider}`, provider }) as Connection;
const prov = (id: string, name: string) => ({ id, name, color: "#123456", mark: name.slice(0, 2).toUpperCase() }) as Provider;
const served = (provider: string, requests: number) => ({ provider, requests }) as UsageSummary["by_provider"][number];

describe("flowNodes", () => {
  beforeEach(() => resetLang());

  it("has one node per provider with an account or with traffic, by name", () => {
    const nodes = flowNodes(
      [conn("openai"), conn("openai"), conn("groq")],
      [prov("openai", "OpenAI"), prov("groq", "Groq"), prov("gone", "Gone Inc")],
      [served("gone", 3)],
    );
    expect(nodes.map((n) => n.id)).toEqual(["gone", "groq", "openai"]);
  });

  it("marks a provider that served the period and says how many requests", () => {
    const [node] = flowNodes([conn("openai")], [prov("openai", "OpenAI")], [served("openai", 1200)]);
    expect(node.active).toBe(true);
    expect(node.detail).toBe("1,200 requests");
    expect(node.text).toBe("OP");
    expect(node.src).toBe("/providers/openai.png");
  });

  it("leaves an idle provider plain, and falls back to the id without catalogue data", () => {
    const [node] = flowNodes([conn("custom")], [], []);
    expect(node).toMatchObject({ id: "custom", name: "custom", active: false, detail: undefined });
  });
});
