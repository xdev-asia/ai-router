import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { NotifyContext } from "../notify";
import { Clips, clipsRoute, fileUrl, projectBody, validateProject, type ProjectDraft } from "../pages/Clips";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

let calls: { method: string; url: string; body: unknown }[];
let routes: Record<string, (body?: unknown) => Response>;

const PROJECT = {
  id: ID,
  topic: "5 mẹo ChatGPT",
  language: "vi",
  duration: 30,
  mode: "image",
  chat_model: "openai/gpt-5-mini",
  image_model: "openai/gpt-image-1",
  video_model: "",
  tts_model: "",
  voice: "alloy",
  image_size: "1024x1536",
  step: "done",
  status: "done",
  error: null,
  plan: { title: "Mẹo ChatGPT", description: "d", hashtags: ["AI"], scenes: [{ narration: "Xin chào", visual: "an office", kind: "image", duration: 3, image: "image-01.png" }] },
  created_at: 1,
  updated_at: 2,
};

beforeEach(() => {
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  calls = [];
  routes = {
    "GET /admin/studio/status": () => json({ configured: true, reachable: true, connected: true, can_store: true }),
    "GET /admin/studio/api/projects": () => json({ projects: [{ id: ID, topic: PROJECT.topic, title: "Mẹo ChatGPT", step: "done", status: "done", error: null, mode: "image", created_at: 1 }] }),
    [`GET /admin/studio/api/projects/${ID}`]: () => json({ project: PROJECT, final: { video: `/files/${ID}.mp4`, cover: `/files/${ID}.jpg` }, publications: [] }),
    "GET /admin/studio/api/channels": () => json({ channels: [{ id: "c1", kind: "telegram", name: "My channel", config: { chat_id: "@x" }, created_at: 1 }] }),
    [`POST /admin/studio/api/projects/${ID}/publish`]: () => json({ publications: [] }, 201),
    "POST /admin/studio/connect": () => json({ connected: true, system: "studio", created: true }),
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${url.split("?")[0]}`];
    return route ? route(calls[calls.length - 1].body) : json({ error: "not found" }, 404);
  });
});

afterEach(() => {
  cleanup();
  act(() => setAuth(null));
  vi.unstubAllGlobals();
});

const show = (hash: string) =>
  render(
    <NotifyContext.Provider value={() => {}}>
      <Clips hash={hash} />
    </NotifyContext.Provider>,
  );

const draft = (d: Partial<ProjectDraft> = {}): ProjectDraft => ({
  topic: "x",
  language: "vi",
  duration: "30",
  mode: "image",
  chat_model: "openai/gpt-5-mini",
  image_model: "openai/gpt-image-1",
  video_model: null,
  tts_model: null,
  voice: "alloy",
  image_size: "1024x1536",
  ...d,
});

describe("clips", () => {
  it("reads the route", () => {
    expect(clipsRoute("#/clips")).toEqual({ tab: "projects", project: null });
    expect(clipsRoute("#/clips/channels")).toEqual({ tab: "channels", project: null });
    expect(clipsRoute(`#/clips/${ID}`)).toEqual({ tab: "projects", project: ID });
    expect(clipsRoute("#/clips/../x")).toEqual({ tab: "projects", project: null });
    expect(fileUrl(ID, "image-01.png")).toBe(`/admin/studio/api/projects/${ID}/files/image-01.png`);
  });

  it("checks a draft per field and builds the body", () => {
    expect(validateProject(draft())).toEqual({});
    expect(validateProject(draft({ topic: " ", duration: "5", chat_model: null }))).toEqual({ topic: "clips.err.topic", duration: "clips.err.duration", chat_model: "clips.err.model" });
    expect(validateProject(draft({ mode: "mixed" }))).toEqual({ video_model: "clips.err.model" });
    expect(validateProject(draft({ mode: "video", image_model: null, video_model: "openai/sora-2" }))).toEqual({});
    expect(projectBody(draft({ topic: " a ", mode: "image", video_model: "openai/sora-2" }))).toMatchObject({ topic: "a", duration: 30, video_model: "", tts_model: "" });
  });

  it("says when the studio is not set up", async () => {
    routes["GET /admin/studio/status"] = () => json({ configured: false, reachable: false, connected: false });
    show("#/clips");
    expect(await screen.findByText(t("clips.notSetUp"))).toBeTruthy();
  });

  it("connects the studio when it is not connected", async () => {
    let connected = false;
    routes["GET /admin/studio/status"] = () => json({ configured: true, reachable: true, connected, can_store: true });
    routes["POST /admin/studio/connect"] = () => ((connected = true), json({ connected: true }));
    show("#/clips");
    fireEvent.click(await screen.findByRole("button", { name: t("clips.connect") }));
    await screen.findByRole("link", { name: "Mẹo ChatGPT" });
    expect(calls.some((c) => c.method === "POST" && c.url === "/admin/studio/connect")).toBe(true);
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: t("clips.connect") })).toBeNull());
  });

  it("lists the projects with a link to each", async () => {
    show("#/clips");
    const link = await screen.findByRole("link", { name: "Mẹo ChatGPT" });
    expect(link.getAttribute("href")).toBe(`#/clips/${ID}`);
  });

  it("shows a project's clip and scenes, and publishes to the picked channel", async () => {
    show(`#/clips/${ID}`);
    const scene = await screen.findByAltText("an office");
    expect(scene.getAttribute("src")).toBe(fileUrl(ID, "image-01.png"));
    expect(document.querySelector("video.clips-final")?.getAttribute("src")).toBe(fileUrl(ID, "final.mp4"));
    const publish = screen.getByRole("button", { name: t("clips.publishNow") }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    fireEvent.click(await screen.findByLabelText("My channel (telegram)"));
    fireEvent.click(publish);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/publish"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/publish"))!.body).toEqual({ channels: ["c1"] });
  });

  it("adds a channel with the fields its kind asks for", async () => {
    routes["GET /admin/studio/api/channel-kinds"] = () =>
      json({ canStore: true, kinds: [{ kind: "telegram", name: "Telegram", secretFields: [{ key: "bot_token", label: "Bot token" }], configFields: [{ key: "chat_id", label: "Chat id" }] }] });
    routes["POST /admin/studio/api/channels"] = () => json({ channel: { id: "c2" } }, 201);
    show("#/clips/channels");
    fireEvent.change(await screen.findByLabelText(t("clips.channel.add")), { target: { value: "telegram" } });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.save") }));
    expect(await within(dialog).findByText(t("clips.channel.missing", { fields: "Bot token, Chat id" }))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Bot token"), { target: { value: "fake-bot-token" } });
    fireEvent.change(within(dialog).getByLabelText("Chat id"), { target: { value: "@mine" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.save") }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/admin/studio/api/channels")).toBe(true));
    expect(calls.find((c) => c.url === "/admin/studio/api/channels" && c.method === "POST")!.body).toEqual({ kind: "telegram", name: "Telegram", secret: { bot_token: "fake-bot-token" }, config: { chat_id: "@mine" } });
  });
});
