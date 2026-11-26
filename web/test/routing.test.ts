// @vitest-environment node
import config from "../../wrangler.jsonc?raw";
import { describe, expect, it } from "vitest";
import { API_FORMATS, API_PATHS } from "../pages/Endpoint";

/** The patterns in wrangler.jsonc that reach the worker before the console's files and its index.html fallback. */
function workerFirst(): string[] {
  const list = /"run_worker_first"\s*:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function reaches(pattern: string, path: string): boolean {
  return pattern.endsWith("/*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}

describe("wrangler routing", () => {
  it("sends every path the Endpoint page lists to the worker, not to the console's index.html", () => {
    const patterns = workerFirst();
    const missed = API_FORMATS.flatMap((f) => API_PATHS[f]).filter((path) => !patterns.some((p) => reaches(p, path)));
    expect(missed).toEqual([]);
  });

  it("sends the studio's public clips to the worker (worker/studio.ts), so Instagram and Zalo get the file", () => {
    expect(workerFirst().some((p) => reaches(p, "/studio/files/0f8fad5b-d9cb-469f-a165-70867728950e.mp4"))).toBe(true);
  });
});
