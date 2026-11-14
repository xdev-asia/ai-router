import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { Combos } from "../pages/Combos";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: { method: string; url: string; body: unknown }[];
let routes: Record<string, (body?: unknown) => Response>;

beforeEach(() => {
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  window.location.hash = "";
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${url.split("?")[0]}`];
    return route ? route(calls[calls.length - 1].body) : json({ error: "not_found" }, 404);
  });
});

afterEach(() => {
  cleanup();
  act(() => setAuth(null));
  vi.unstubAllGlobals();
});

describe("audio adapter row", () => {
  it("shows a Vision and an Audio row, each saving to its own adapter", async () => {
    let audio = { enabled: false, models: ["openai/ear-a"], applies_to: ["groq/*"] };
    routes["GET /admin/combos"] = () => json([]);
    routes["GET /admin/vision-adapter"] = () => json({ enabled: false, models: [], applies_to: [] });
    routes["GET /admin/audio-adapter"] = () => json(audio);
    routes["PUT /admin/audio-adapter"] = (body) => {
      audio = { ...audio, ...(body as object) };
      return json(audio);
    };
    render(<Combos />);
    const vision = (await screen.findByRole("heading", { name: t("combos.vision.title") })).closest("section") as HTMLElement;
    const audioCard = (await screen.findByRole("heading", { name: t("combos.audio.title") })).closest("section") as HTMLElement;
    expect(vision).toBeTruthy();
    expect(audioCard).toBeTruthy();
    expect(await within(audioCard).findByText("openai/ear-a")).toBeTruthy();

    const on = within(audioCard).getByRole("switch", { name: t("combos.audio.enabled") });
    fireEvent.click(on);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url === "/admin/audio-adapter")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: true });
    expect(calls.some((c) => c.method === "PUT" && c.url === "/admin/vision-adapter")).toBe(false);
  });
});
