import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageFromHash } from "../App";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { BasicChat, CHAT_KEY, deltaText, loadSessions } from "../pages/BasicChat";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sseText = (parts: string[]) => parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join("") + "data: [DONE]\n\n";

let calls: { method: string; url: string; body: unknown }[];
let routes: Record<string, (body?: unknown) => Response>;

const SYSTEM = { id: "play", name: "Playground", monthly_token_cap: null, disabled: false, created_at: 0, allowed_models: null, rtk: null, caveman: null, ponytail: null };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  calls = [];
  routes = {
    "GET /admin/systems": () => json([SYSTEM]),
    "GET /admin/chat/models": () => json({ data: [{ id: "combo/fast" }, { id: "openai/gpt-5" }] }),
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${url.split("?")[0]}`];
    return route ? route(calls[calls.length - 1]!.body) : json({ error: "not_found" }, 404);
  });
});

afterEach(() => {
  cleanup();
  act(() => setAuth(null));
  vi.unstubAllGlobals();
});

describe("Basic chat", () => {
  it("is a page of its own", () => {
    expect(pageFromHash("#/chat")).toBe("chat");
  });

  it("sends the conversation as the chosen system and shows the streamed reply", async () => {
    routes["POST /admin/chat/completions"] = () => new Response(sseText(["Hel", "lo!"]), { headers: { "content-type": "text/event-stream" } });
    render(<BasicChat />);
    const model = await screen.findByRole("combobox", { name: t("chat.model") });
    await waitFor(() => expect((model as HTMLSelectElement).value).toBe("combo/fast"));
    expect(calls.some((c) => c.url === "/admin/chat/models?system=play")).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: t("chat.input") }), { target: { value: "Hi there" } });
    fireEvent.click(screen.getByRole("button", { name: t("chat.send") }));

    expect(await screen.findByText("Hello!")).toBeTruthy();
    const sent = calls.find((c) => c.method === "POST")!;
    expect(sent.url).toBe("/admin/chat/completions");
    expect(sent.body).toEqual({ system: "play", model: "combo/fast", stream: true, messages: [{ role: "user", content: "Hi there" }] });

    // The session is kept in this browser, named after its first message.
    const saved = loadSessions();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.title).toBe("Hi there");
    expect(saved[0]!.messages.map((m) => m.content)).toEqual(["Hi there", "Hello!"]);
    expect(localStorage.getItem(CHAT_KEY)).toContain("Hello!");
  });

  it("shows the gateway's error and keeps the question", async () => {
    routes["POST /admin/chat/completions"] = () => json({ error: { message: "this system may not use openai/gpt-5", type: "permission_error" } }, 403);
    render(<BasicChat />);
    await screen.findByRole("combobox", { name: t("chat.model") });
    fireEvent.change(screen.getByRole("textbox", { name: t("chat.input") }), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: t("chat.send") }));
    expect(await screen.findByText("this system may not use openai/gpt-5")).toBeTruthy();
    expect(screen.getAllByText("Hi").some((el) => el.classList.contains("chat-text"))).toBe(true);
  });

  it("starts a new chat and deletes one", async () => {
    localStorage.setItem(CHAT_KEY, JSON.stringify({ active: "a", sessions: [{ id: "a", title: "Old one", at: 1, messages: [{ role: "user", content: "Old one" }] }] }));
    render(<BasicChat />);
    const list = await screen.findByRole("region", { name: t("chat.sessions") });
    expect(within(list).getByText("Old one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("chat.new") }));
    expect(loadSessions()).toHaveLength(2);
    fireEvent.click(within(list).getByRole("button", { name: t("chat.delete", { title: "Old one" }) }));
    expect(loadSessions().map((s) => s.title)).toEqual([t("chat.untitled")]);
  });

  it("points to Endpoint & Key when there is no system to chat as", async () => {
    routes["GET /admin/systems"] = () => json([]);
    render(<BasicChat />);
    expect(await screen.findByText(t("chat.noSystem"))).toBeTruthy();
  });

  it("reads the text of a stream chunk", () => {
    expect(deltaText('{"choices":[{"delta":{"content":"x"}}]}')).toBe("x");
    expect(deltaText('{"choices":[{"delta":{}}]}')).toBe("");
    expect(deltaText("not json")).toBe("");
  });
});
