import main from "../main.tsx?raw";
import html from "../index.html?raw";
import { describe, expect, it } from "vitest";

// data-ground="ocean" sets --font-body to IBM Plex Sans; the tokens use 400 to 700 for interface text (Plex has no 800, the browser uses 700).
const WEIGHTS = [400, 500, 600, 700] as const;
const plexCss = import.meta.glob<string>("/node_modules/@fontsource/ibm-plex-sans/{400,500,600,700}.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("console fonts", () => {
  it("uses the ocean ground, whose body font is IBM Plex Sans", () => {
    expect(html).toContain('data-ground="ocean"');
  });

  it("serves IBM Plex Sans itself at every weight the tokens use, and no longer Roboto", () => {
    for (const w of WEIGHTS) expect(main).toContain(`import "@fontsource/ibm-plex-sans/${w}.css";`);
    expect(main).not.toContain("@fontsource/roboto");
  });

  it("gets the Vietnamese subset with each IBM Plex Sans weight", () => {
    for (const w of WEIGHTS) {
      const css = plexCss[`/node_modules/@fontsource/ibm-plex-sans/${w}.css`];
      expect(css, `${w}`).toMatch(/ibm-plex-sans-vietnamese-\d+-normal\.woff2/);
    }
  });
});
