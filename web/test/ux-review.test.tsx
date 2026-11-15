import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Icon } from "@xdev-asia/ui";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { ProviderModelsCard } from "../pages/ProviderModels";
import { ProviderDetail, Providers } from "../pages/Providers";
import { SignIn } from "../pages/SignIn";
import { Systems } from "../pages/Systems";

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
/** The drawing of an icon, whatever its size. */
const drawing = (svg: string) => svg.replace(/^<svg[^>]*>/, "");
const hasIcon = (el: Element, name: Parameters<typeof Icon>[0]["name"]) => drawing(el.querySelector("svg")?.outerHTML ?? "") === drawing(iconSvg(name));

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

describe("systems", () => {
  const SYSTEM = { id: "chat", name: "Chat", monthly_token_cap: 1000, disabled: false, created_at: 1, allowed_models: null, rtk: false, caveman: null, ponytail: null };
  const USAGE = {
    month: "2026-11",
    rows: [{ system_id: "chat", provider: "anthropic", model: "m", requests: 3, input_tokens: 400, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }],
  };

  beforeEach(() => {
    routes["GET /admin/systems"] = () => json([SYSTEM]);
    routes["GET /admin/usage"] = () => json(USAGE);
  });

  const openMenu = async (item: string) => {
    fireEvent.click(await screen.findByRole("button", { name: `${t("systems.col.actions")}: chat` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  };

  it("keeps the rotate dialog open with the error when rotating fails", async () => {
    routes["POST /admin/systems/chat/rotate"] = () => json({ error: "boom" }, 500);
    render(<Systems />);
    await openMenu(t("systems.rotate"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: t("systems.rotate") }));
    expect(await within(dialog).findByText(t("error.generic"))).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("keeps the disable dialog open with the error when disabling fails", async () => {
    routes["PATCH /admin/systems/chat"] = () => json({ error: "boom" }, 500);
    render(<Systems />);
    await openMenu(t("systems.disable"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: t("systems.disable") }));
    expect(await within(dialog).findByText(t("error.generic"))).toBeTruthy();
  });

  it("says the month's usage did not load instead of showing zero", async () => {
    routes["GET /admin/usage"] = () => json({ error: "boom" }, 500);
    render(<Systems />);
    expect(await screen.findByText(t("ux.systems.usageFailed"))).toBeTruthy();
    expect(screen.getByRole("button", { name: t("common.retry") })).toBeTruthy();
    const row = screen.getByText("Chat").closest("tr")!;
    expect(row.textContent).not.toContain("0 / 1,000");
    expect(row.textContent).toContain("—");
  });

  it("offers to add the first system from the empty table", async () => {
    routes["GET /admin/systems"] = () => json([]);
    render(<Systems />);
    const empty = (await screen.findByText(t("systems.empty"))).closest(".x-empty")!;
    expect(hasIcon(empty, "key")).toBe(true);
    fireEvent.click(within(empty as HTMLElement).getByRole("button", { name: t("systems.add") }));
    expect(await screen.findByRole("heading", { name: t("create.title") })).toBeTruthy();
  });

  it("says what is wrong with the name", async () => {
    render(<Systems />);
    fireEvent.click(await screen.findByRole("button", { name: t("systems.add") }));
    fireEvent.change(screen.getByLabelText(t("create.id")), { target: { value: "web" } });
    fireEvent.click(screen.getByRole("button", { name: t("create.submit") }));
    expect(await screen.findByText(t("ux.systems.nameBad"))).toBeTruthy();
  });

  it("saves a cap only once it changed (systems)", async () => {
    render(<Systems />);
    await openMenu(t("systems.editCap"));
    const save = screen.getByRole("button", { name: t("common.save") }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(t("create.cap")), { target: { value: "2000" } });
    expect(save.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(t("create.cap")), { target: { value: " 1000 " } });
    expect(save.disabled).toBe(true);
  });
});

describe("providers", () => {
  const builtin = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    format: "openai",
    auth: ["api_key"],
    env_key: false,
    key_url: null,
    strategy: "fill-first",
    color: "#333333",
    mark: name.slice(0, 2),
    ...extra,
  });
  const conn = (id: string, provider: string, extra: Record<string, unknown> = {}) => ({
    id,
    provider,
    auth_type: "api_key",
    name: `Conn ${id}`,
    hint: "0042",
    disabled: false,
    cooldown_until: 0,
    priority: 1,
    last_error: null,
    proxy_pool: null,
    ...extra,
  });
  const GITHUB = builtin("github", "GitHub Copilot", { auth: ["oauth"] });
  const CODEX = builtin("codex", "OpenAI Codex", { format: "codex", auth: ["oauth"] });

  beforeEach(() => {
    routes["GET /admin/providers"] = () => json([builtin("openai", "OpenAI"), GITHUB, CODEX]);
    routes["GET /admin/connections"] = () => json([conn("c1", "openai"), conn("o1", "codex", { auth_type: "oauth", hint: null })]);
  });

  const openMenu = async (name: string, item: string) => {
    fireEvent.click(await screen.findByRole("button", { name: `${t("systems.col.actions")}: ${name}` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  };

  it("keeps the delete dialog open with the error when deleting a connection fails", async () => {
    routes["DELETE /admin/connections/c1"] = () => json({ error: "boom" }, 500);
    render(<ProviderDetail id="openai" />);
    await openMenu("Conn c1", t("providers.delete"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: t("providers.delete") }));
    expect(await within(dialog).findByText(t("error.generic"))).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("says in plain words that a key failed its test, with what the provider answered under it", async () => {
    routes["POST /admin/connections/c1/test"] = () => json({ ok: false, status: 401, message: "Invalid API Key" });
    render(<ProviderDetail id="openai" />);
    await openMenu("Conn c1", t("providers.test"));
    const title = await screen.findByText(t("ux.providers.testFailed", { name: "Conn c1" }));
    const banner = title.closest(".banner")!;
    expect(banner.textContent).toContain(t("ux.providers.testAnswer", { answer: "401 Invalid API Key" }));
    // The headline is plain words: the code is in the line under it.
    expect(title.textContent).not.toContain("401");
  });

  it("names the add button of the add-connection dialog for what it does", async () => {
    render(<ProviderDetail id="openai" />);
    await screen.findByText("Conn c1");
    fireEvent.click(screen.getAllByRole("button", { name: t("providers.add") })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: t("providers.add") })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: t("common.save") })).toBeNull();
  });

  it("names the add button of the custom provider dialog for what it does", async () => {
    render(<Providers />);
    const heading = await screen.findByRole("heading", { name: t("providers.section.custom") });
    fireEvent.click(within(heading.closest("section")!).getAllByRole("button", { name: t("providers.custom.addOpenai") })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: t("ux.providers.custom.create") })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: t("common.save") })).toBeNull();
  });

  it("names the search that matched nothing and offers to clear it", async () => {
    const clear = vi.fn();
    render(<Providers query="zzz" onClearQuery={clear} />);
    const empty = (await screen.findByText(t("ux.providers.noMatchQuery", { query: "zzz" }))).closest(".x-empty")!;
    fireEvent.click(within(empty as HTMLElement).getByRole("button", { name: t("ux.clearSearch") }));
    expect(clear).toHaveBeenCalled();
  });

  it("saves custom headers only once they changed, with a plain headline when the gateway refuses", async () => {
    routes["GET /admin/providers/codex/headers"] = () => json({ headers: { "x-team": "core" } });
    routes["PUT /admin/providers/codex/headers"] = () => json({ error: "invalid_request", message: "header name x bad is not allowed" }, 400);
    render(<ProviderDetail id="codex" />);
    const name = (await screen.findByLabelText(t("providers.headerName"))) as HTMLInputElement;
    const save = screen.getByRole("button", { name: t("providers.headerSave") }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "x bad" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const title = await screen.findByText(t("ux.providers.headersFailed"));
    expect(title.closest(".banner")!.textContent).toContain("header name x bad is not allowed");
    fireEvent.change(name, { target: { value: "x-team" } });
    expect(save.disabled).toBe(true);
  });

  it("offers a new code when the device sign-in code expires", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    let starts = 0;
    routes["POST /admin/oauth/github/start"] = () =>
      json({ flow: "device", id: `dev-${++starts}`, user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", interval: 1, expires_in: starts === 1 ? 0 : 600 });
    routes["POST /admin/oauth/github/poll"] = () => json({ status: "pending", interval: 5 }, 202);
    routes["GET /admin/connections"] = () => json([]);
    render(<ProviderDetail id="github" />);
    fireEvent.click((await screen.findAllByRole("button", { name: t("providers.add") }))[0]);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(t("providers.device.expired"), undefined, { timeout: 3000 })).toBeTruthy();
    const restart = within(dialog).getByRole("button", { name: t("ux.providers.device.restart") }) as HTMLButtonElement;
    expect(restart.disabled).toBe(false);
    fireEvent.click(restart);
    await waitFor(() => expect(starts).toBe(2));
    expect(await screen.findByText(t("providers.device.waiting"))).toBeTruthy();
    open.mockRestore();
  });
});
