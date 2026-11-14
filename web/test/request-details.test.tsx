import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { RequestDetails, detailsPath } from "../pages/RequestDetails";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ROW = {
  id: 7,
  at: Date.UTC(2026, 10, 13, 9, 30, 0),
  system_id: "play",
  model: "claude-opus-5-5",
  path: "/v1/chat/completions",
  status: 200,
  took_ms: 812,
  ttft_ms: 140,
  input_tokens: 12,
  output_tokens: 34,
  cached_tokens: 0,
  request: '{"model":"claude-opus-5-5","messages":[{"role":"user","content":"what is 2+2"}]}',
  response: "Four.",
  thinking: "simple sum",
};

let calls: { method: string; url: string; body: unknown }[];
let routes: Record<string, (body?: unknown) => Response>;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  calls = [];
  routes = {
    "GET /admin/observability": () => json({ enabled: true }),
    "GET /admin/request-details": () => json({ details: [ROW], kept: 200 }),
    "GET /admin/request-details/7": () => json(ROW),
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

describe("Request details (observability)", () => {
  it("builds the list path from the model filter", () => {
    expect(detailsPath("")).toBe("/request-details");
    expect(detailsPath("haiku 5")).toBe("/request-details?model=haiku+5");
  });

  it("lists recorded requests and opens one with its request, reply and thinking", async () => {
    render(<RequestDetails />);
    const table = await screen.findByRole("table", { name: t("details.caption") });
    expect(within(table).getByText("claude-opus-5-5")).toBeTruthy();
    expect(within(table).getByText("12 / 34")).toBeTruthy();
    expect(within(table).getByText("140 ms")).toBeTruthy();

    fireEvent.click(within(table).getByRole("button", { name: t("details.open", { model: "claude-opus-5-5" }) }));
    const drawer = await screen.findByRole("dialog");
    await waitFor(() => expect(within(drawer).getByText("Four.")).toBeTruthy());
    expect(within(drawer).getByText("simple sum")).toBeTruthy();
    expect(drawer.textContent).toContain("what is 2+2");
  });

  it("turns recording on and off", async () => {
    routes["GET /admin/observability"] = () => json({ enabled: false });
    routes["PUT /admin/observability"] = (body) => json(body);
    render(<RequestDetails />);
    const toggle = (await screen.findByRole("switch", { name: t("details.record") })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(t("details.off"))).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url === "/admin/observability")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ enabled: true });
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it("clears every recorded request after asking", async () => {
    routes["DELETE /admin/request-details"] = () => new Response(null, { status: 204 });
    render(<RequestDetails />);
    await screen.findByRole("table", { name: t("details.caption") });
    fireEvent.click(screen.getByRole("button", { name: t("details.clear") }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: t("details.clear") }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/admin/request-details")).toBe(true));
    expect(await screen.findByText(t("details.empty"))).toBeTruthy();
  });

  it("filters by model on the worker", async () => {
    render(<RequestDetails />);
    await screen.findByRole("table", { name: t("details.caption") });
    fireEvent.change(screen.getByRole("searchbox", { name: t("details.filter") }), { target: { value: "haiku" } });
    await waitFor(() => expect(calls.some((c) => c.url === "/admin/request-details?model=haiku")).toBe(true), { timeout: 2000 });
  });
});
