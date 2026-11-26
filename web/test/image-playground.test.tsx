import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { Media } from "../pages/Media";
import { imageModelOptions, imagesOf } from "../pages/ImagePlayground";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: { method: string; url: string; body: unknown }[];
let routes: Record<string, (body?: unknown) => Response>;

beforeEach(() => {
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  window.location.hash = "";
  calls = [];
  routes = {
    "GET /admin/media": () =>
      json({
        kinds: [{ kind: "images", path: "/v1/images/generations", body: "json" }],
        providers: [],
        media_providers: [{ id: "bfl", name: "Black Forest Labs", color: "#000", mark: "BF", alias: null, key_url: "https://bfl.example", key_format: "plain", kinds: ["images"], models: { images: ["flux-dev"] }, connections: 1, env_key: false, configured: true }],
        unsupported: [],
      }),
    "GET /admin/providers": () => json([]),
    "GET /admin/connections": () => json([]),
    "GET /admin/systems": () => json([{ id: "art", name: "Art", disabled: false }]),
    "POST /admin/images/generations": () => json({ created: 1, data: [{ b64_json: "iVBORw0KGgo=" }] }),
  };
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

describe("image playground", () => {
  it("reads b64_json and https URLs, and nothing else", () => {
    expect(imagesOf({ data: [{ b64_json: "QUJD" }, { url: "https://cdn.example/a.png" }, { url: "javascript:alert(1)" }, {}] })).toEqual([
      "data:image/png;base64,QUJD",
      "https://cdn.example/a.png",
    ]);
    expect(imagesOf(null)).toEqual([]);
  });

  it("offers OpenAI's models and each media provider's image models", () => {
    const values = imageModelOptions([{ id: "bfl", name: "BFL", models: { images: ["flux-dev"], speech: ["x"] } }]).map((o) => o.value);
    expect(values).toEqual(["openai/gpt-image-1", "openai/dall-e-3", "bfl/flux-dev"]);
  });

  it("asks for a prompt, then draws as the chosen system and shows the image", async () => {
    render(<Media tab="images" />);
    const card = (await screen.findByRole("heading", { name: t("imgplay.title") })).closest("section, article, div.x-card") as HTMLElement;
    const drawButton = await within(card).findByRole("button", { name: t("imgplay.draw") });
    fireEvent.click(drawButton);
    expect(await within(card).findByText(t("imgplay.promptRequired"))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.change(within(card).getByLabelText(t("imgplay.prompt")), { target: { value: "a lighthouse" } });
    fireEvent.click(drawButton);
    const img = await within(card).findByAltText("a lighthouse");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/admin/images/generations");
    expect(post.body).toMatchObject({ system: "art", model: "openai/gpt-image-1", prompt: "a lighthouse", size: "1024x1024", n: 1 });

    fireEvent.click(within(card).getByRole("button", { name: t("imgplay.view", { prompt: "a lighthouse" }) }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: t("imgplay.download") }).getAttribute("href")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("shows the provider's error", async () => {
    routes["POST /admin/images/generations"] = () => json({ error: { message: "this system may not use this model" } }, 403);
    render(<Media tab="images" />);
    const prompt = await screen.findByLabelText(t("imgplay.prompt"));
    fireEvent.change(prompt, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: t("imgplay.draw") }));
    expect(await screen.findByText("this system may not use this model")).toBeTruthy();
  });
});
