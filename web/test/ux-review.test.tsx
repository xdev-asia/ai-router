import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Icon } from "@xdev-asia/ui";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { ProviderModelsCard } from "../pages/ProviderModels";
import { SignIn } from "../pages/SignIn";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: { method: string; url: string; body: unknown }[];
let routes: Record<string, (body?: unknown) => Response | Promise<Response>>;

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

/** The svg an IconButton draws for `name`. */
const iconSvg = (name: Parameters<typeof Icon>[0]["name"]) => renderToStaticMarkup(<Icon name={name} />);
const svgOf = (el: HTMLElement) => el.querySelector("svg")?.outerHTML ?? "";

describe("sign-in", () => {
  it("lets a password manager fill the admin token", () => {
    render(<SignIn sso={false} />);
    expect(screen.getByLabelText(t("signin.token")).getAttribute("autocomplete")).toBe("current-password");
  });

  it("drops ?signin_error= from the address once it is shown", async () => {
    window.history.replaceState({}, "", "/?signin_error=expired&keep=1#/usage");
    render(<SignIn sso />);
    expect(screen.getByText(t("signin.error.expired"))).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe("?keep=1"));
    expect(window.location.hash).toBe("#/usage");
    // The message stays on screen after the address changed.
    expect(screen.getByText(t("signin.error.expired"))).toBeTruthy();
    window.history.replaceState({}, "", "/");
  });
});

describe("provider models", () => {
  const MODELS = {
    provider: "openai",
    alias: "oa",
    thinking: null,
    models: [
      { id: "gpt-x", name: "GPT X", custom: false, disabled: false },
      { id: "gpt-off", name: "GPT Off", custom: false, disabled: true },
      { id: "mine", name: "Mine", custom: true, disabled: false },
    ],
  };

  beforeEach(() => {
    routes["GET /admin/providers/openai/models"] = () => json(MODELS);
    routes["GET /admin/models/aliases"] = () => json({ aliases: { fast: "oa/gpt-x" } });
  });

  it("asks before removing a custom model, and names it", async () => {
    routes["DELETE /admin/models/custom"] = () => json({ ok: true });
    render(<ProviderModelsCard provider="openai" />);
    fireEvent.click(await screen.findByRole("button", { name: t("models.remove", { name: "oa/mine" }) }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(t("ux.models.removeTitle", { name: "oa/mine" }))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: t("ux.models.removeConfirm") }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/models/custom"))).toBe(true));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("keeps the remove dialog open with the error when the removal fails", async () => {
    routes["DELETE /admin/models/custom"] = () => json({ error: "boom" }, 500);
    render(<ProviderModelsCard provider="openai" />);
    fireEvent.click(await screen.findByRole("button", { name: t("models.remove", { name: "oa/mine" }) }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: t("ux.models.removeConfirm") }));
    expect(await within(dialog).findByText(t("error.generic"))).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("saves a renamed alias before deleting the old one", async () => {
    routes["PUT /admin/models/aliases"] = () => json({ ok: true });
    routes["DELETE /admin/models/aliases"] = () => json({ ok: true });
    render(<ProviderModelsCard provider="openai" />);
    await screen.findByText("GPT X · fast");
    fireEvent.click(screen.getByRole("button", { name: t("models.alias", { name: "oa/gpt-x" }) }));
    const field = await screen.findByLabelText(t("models.aliasField"));
    fireEvent.change(field, { target: { value: "quick" } });
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith("/admin/models/aliases") && c.method !== "GET")).toHaveLength(2));
    const writes = calls.filter((c) => c.url.startsWith("/admin/models/aliases") && c.method !== "GET").map((c) => c.method);
    expect(writes).toEqual(["PUT", "DELETE"]);
  });

  it("keeps the old alias when saving the new one fails", async () => {
    routes["PUT /admin/models/aliases"] = () => json({ error: "boom" }, 500);
    routes["DELETE /admin/models/aliases"] = () => json({ ok: true });
    render(<ProviderModelsCard provider="openai" />);
    await screen.findByText("GPT X · fast");
    fireEvent.click(screen.getByRole("button", { name: t("models.alias", { name: "oa/gpt-x" }) }));
    fireEvent.change(await screen.findByLabelText(t("models.aliasField")), { target: { value: "quick" } });
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    await screen.findByText(t("error.generic"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("shows loading and load errors inside the card, under its title", async () => {
    routes["GET /admin/providers/openai/models"] = () => json({ error: "boom" }, 500);
    render(<ProviderModelsCard provider="openai" />);
    expect(screen.getByRole("heading", { name: t("models.title") })).toBeTruthy();
    const retry = await screen.findByRole("button", { name: t("common.retry") });
    expect(retry.closest(".x-card")).toBeTruthy();
    expect(screen.getByRole("heading", { name: t("models.title") })).toBeTruthy();
  });

  it("draws the action each model button does: eye-off hides, eye shows", async () => {
    render(<ProviderModelsCard provider="openai" />);
    const hide = await screen.findByRole("button", { name: t("models.hide", { name: "oa/gpt-x" }) });
    const show = screen.getByRole("button", { name: t("models.show", { name: "oa/gpt-off" }) });
    expect(svgOf(hide)).toBe(iconSvg("eye-off"));
    expect(svgOf(show)).toBe(iconSvg("eye"));
    // Same meaning as the card's own buttons.
    expect(svgOf(screen.getByRole("button", { name: t("models.activeAll") }))).toBe(iconSvg("eye"));
    expect(svgOf(screen.getByRole("button", { name: t("models.disableAll") }))).toBe(iconSvg("eye-off"));
  });
});
