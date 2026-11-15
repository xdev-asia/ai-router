import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { Settings } from "../pages/Settings";
import { EXAMPLES, Translator, parseBody } from "../pages/Translator";
import { resetTranslatorShown, useTranslatorShown } from "../translator-pref";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: { method: string; url: string; body: any }[];
let routes: Record<string, (body?: any) => Response>;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  resetTranslatorShown();
  calls = [];
  routes = {};
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

describe("translator page", () => {
  it("parses only JSON objects", () => {
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseBody("[1]")).toBeNull();
    expect(parseBody("{nope")).toBeNull();
  });

  it("sends the pasted request with its formats and shows what goes upstream", async () => {
    routes["POST /admin/translate"] = () => json({ result: { model: "openai/gpt-5", max_tokens: 256, messages: [{ role: "user", content: "Hello" }] } });
    render(<Translator />);
    fireEvent.click(screen.getByRole("button", { name: t("translator.run") }));
    await waitFor(() => expect(document.body.textContent).toContain('"max_tokens": 256'));
    expect(calls[0]).toMatchObject({ method: "POST", url: "/admin/translate", body: { from: "responses", to: "anthropic", body: EXAMPLES.responses } });
    expect(calls[0]!.body.model).toBeUndefined();
  });

  it("swaps in the Gemini example and sends the model Gemini keeps in the URL", async () => {
    routes["POST /admin/translate"] = () => json({ result: { model: "anthropic/claude-sonnet-4-5" } });
    render(<Translator />);
    fireEvent.click(screen.getByText(t("translator.format.gemini")));
    expect((screen.getByLabelText(t("translator.body")) as HTMLTextAreaElement).value).toContain("contents");
    fireEvent.click(screen.getByRole("button", { name: t("translator.run") }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ from: "gemini", model: "anthropic/claude-sonnet-4-5", body: EXAMPLES.gemini });
  });

  it("does not send a body that is not JSON, and shows the translator's reason when it refuses", async () => {
    routes["POST /admin/translate"] = () => json({ error: "translate_failed", message: "input is required" }, 400);
    render(<Translator />);
    const box = screen.getByLabelText(t("translator.body"));
    fireEvent.change(box, { target: { value: "{nope" } });
    fireEvent.click(screen.getByRole("button", { name: t("translator.run") }));
    expect(screen.getByText(t("translator.badJson"))).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.change(box, { target: { value: '{"model":"m"}' } });
    fireEvent.click(screen.getByRole("button", { name: t("translator.run") }));
    await waitFor(() => expect(screen.getByText("input is required")).toBeTruthy());
    expect(screen.getByText(t("translator.failed"))).toBeTruthy();
  });
});

describe("translator switch", () => {
  it("is off until turned on in Settings, and stays on in this browser", async () => {
    routes["GET /admin/settings/info"] = () => json({ admin_token: true, oidc: false, console_emails: 0, connections_key: true, codex_relay: false });
    routes["GET /admin/combo-settings"] = () => json({ strategy: "fallback", sticky_limit: 3 });
    routes["GET /admin/timeouts"] = () => json({ first_byte_s: 300, idle_s: 300 });
    const { result } = renderHook(() => useTranslatorShown());
    expect(result.current[0]).toBe(false);
    render(<Settings />);
    const sw = screen.getByRole("switch", { name: t("prefs.translator") }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(result.current[0]).toBe(true));
    expect(localStorage.getItem("ai-router.translator")).toBe("on");
    resetTranslatorShown();
    const again = renderHook(() => useTranslatorShown());
    expect(again.result.current[0]).toBe(true);
  });
});
