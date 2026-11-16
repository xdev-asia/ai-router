import main from "../main.tsx?raw";
import { describe, expect, it } from "vitest";

// The tokens use 400 to 800 for interface text (@xdev-asia/ui --font-body is Roboto).
const WEIGHTS = [400, 500, 600, 700, 800] as const;
const robotoCss = import.meta.glob<string>("/node_modules/@fontsource/roboto/{400,500,600,700,800}.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("console fonts", () => {
  it("serves Roboto itself at every weight the tokens use, and no longer Be Vietnam Pro", () => {
    for (const w of WEIGHTS) expect(main).toContain(`import "@fontsource/roboto/${w}.css";`);
    expect(main).not.toContain("be-vietnam-pro");
  });

  it("gets the Vietnamese subset with each Roboto weight", () => {
    for (const w of WEIGHTS) {
      const css = robotoCss[`/node_modules/@fontsource/roboto/${w}.css`];
      expect(css, `${w}`).toMatch(/roboto-vietnamese-\d+-normal\.woff2/);
    }
  });
});
