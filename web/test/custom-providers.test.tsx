import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { ProviderDetail, Providers, runLimited, validateCustomProvider } from "../pages/Providers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: { method: string; url: string; body: unknown }[];
let routes: Record<string, (body?: unknown) => Response | Promise<Response>>;

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
const CORP = builtin("corp", "Corp LLM", { custom: true, base_url: "https://llm.corp.test/v1" });
const conn = (id: string, provider: string, disabled = false) => ({
  id,
  provider,
  auth_type: "api_key",
  name: `Conn ${id}`,
  hint: "0042",
  disabled,
  cooldown_until: 0,
  priority: 1,
  last_error: null,
  proxy_pool: null,
});

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

describe("validateCustomProvider", () => {
  const ok = { id: "corp", name: "Corp", format: "openai" as const, base_url: "https://llm.corp.test/v1" };

  it("takes a slug, a name and an https URL", () => {
    expect(validateCustomProvider(ok, true)).toEqual({});
    expect(validateCustomProvider({ ...ok, base_url: "https://llm.corp.test:8443/v1/" }, true)).toEqual({});
    // A local server (Ollama, LM Studio) speaks plain http.
    for (const base_url of ["http://host.docker.internal:11434/v1", "http://localhost:1234/v1", "http://192.168.1.20:11434/v1", "http://ollama:11434/v1"]) expect(validateCustomProvider({ ...ok, base_url }, true), base_url).toEqual({});
  });

  it("names each bad field", () => {
    expect(validateCustomProvider({ ...ok, id: "C" }, true).id).toBe("providers.custom.idBad");
    expect(validateCustomProvider({ ...ok, id: "1corp" }, true).id).toBe("providers.custom.idBad");
    expect(validateCustomProvider({ ...ok, id: "corp_llm" }, true).id).toBe("providers.custom.idBad");
    expect(validateCustomProvider({ ...ok, name: "  " }, true).name).toBe("providers.nameRequired");
    expect(validateCustomProvider({ ...ok, name: "x".repeat(101) }, true).name).toBe("providers.custom.nameLong");
    expect(validateCustomProvider({ ...ok, base_url: "http://llm.corp.test/v1" }, true).base_url).toBe("providers.custom.baseUrlBad");
    expect(validateCustomProvider({ ...ok, base_url: "http://8.8.8.8/v1" }, true).base_url).toBe("providers.custom.baseUrlBad");
    for (const base_url of ["https://169.254.169.254/v1", "http://169.254.169.254/v1", "https://0.0.0.0/v1"]) expect(validateCustomProvider({ ...ok, base_url }, true).base_url, base_url).toBe("providers.custom.baseUrlBad");
    expect(validateCustomProvider({ ...ok, base_url: "https://user:pw@llm.corp.test" }, true).base_url).toBe("providers.custom.baseUrlBad");
    expect(validateCustomProvider({ ...ok, base_url: "https://llm.corp.test/v1?x=1" }, true).base_url).toBe("providers.custom.baseUrlBad");
    expect(validateCustomProvider({ ...ok, base_url: "not a url" }, true).base_url).toBe("providers.custom.baseUrlBad");
  });

  it("does not check the id of a provider being edited", () => {
    expect(validateCustomProvider({ ...ok, id: "" }, false)).toEqual({});
  });
});

describe("runLimited", () => {
  it("runs at most `limit` at a time, counts each outcome and reports progress", async () => {
    let running = 0;
    let most = 0;
    const progress: number[] = [];
    const result = await runLimited(
      [1, 2, 3, 4, 5, 6, 7],
      3,
      async (n) => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        if (n === 4) throw new Error("boom");
        return n % 2 === 1;
      },
      (done) => progress.push(done),
    );
    expect(most).toBe(3);
    // 1, 3, 5, 7 work; 2 and 6 fail; 4 throws, which counts as failed.
    expect(result).toEqual({ ok: 4, failed: 3 });
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("answers at once for nothing to run", async () => {
    expect(await runLimited([], 3, async () => true)).toEqual({ ok: 0, failed: 0 });
  });
});

describe("providers page: custom providers", () => {
  it("shows the custom section first with an empty state, and adds an OpenAI compatible provider", async () => {
    let providers = [builtin("openai", "OpenAI")];
    routes["GET /admin/providers"] = () => json(providers);
    routes["GET /admin/connections"] = () => json([]);
    routes["POST /admin/custom-providers"] = (body) => {
      const b = body as { id: string; name: string; format: string; base_url: string };
      providers = [...providers, builtin(b.id, b.name, { custom: true, base_url: b.base_url })];
      return json({ ...b, created_at: 1, updated_at: 1 }, 201);
    };
    render(<Providers />);

    const heading = await screen.findByRole("heading", { name: t("providers.section.custom") });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toBe(t("providers.section.custom"));
    const section = heading.closest("section")!;
    expect(within(section).getByText(t("providers.custom.empty"))).toBeTruthy();

    fireEvent.click(within(section).getAllByRole("button", { name: t("providers.custom.addOpenai") })[0]);
    const dialog = await screen.findByRole("dialog");
    // Nothing is sent while a field is wrong.
    fireEvent.click(within(dialog).getByRole("button", { name: t("ux.providers.custom.create") }));
    expect(within(dialog).getByText(t("providers.custom.idBad"))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.change(within(dialog).getByLabelText(t("providers.custom.id")), { target: { value: "corp" } });
    fireEvent.change(within(dialog).getByLabelText(t("providers.name")), { target: { value: "Corp LLM" } });
    fireEvent.change(within(dialog).getByLabelText(t("providers.custom.baseUrl")), { target: { value: "https://llm.corp.test/v1/" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("ux.providers.custom.create") }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ id: "corp", name: "Corp LLM", format: "openai", base_url: "https://llm.corp.test/v1/" });
    expect(await within(section).findByText("Corp LLM")).toBeTruthy();
    expect(screen.getByText("Corp LLM").closest("a")?.getAttribute("href")).toBe("#/providers/corp");
  });

  it("presets the format from the button, and shows a taken id on its field", async () => {
    routes["GET /admin/providers"] = () => json([builtin("openai", "OpenAI")]);
    routes["GET /admin/connections"] = () => json([]);
    routes["POST /admin/custom-providers"] = () => json({ error: "taken", message: "corp already exists" }, 409);
    render(<Providers />);
    const heading = await screen.findByRole("heading", { name: t("providers.section.custom") });
    fireEvent.click(within(heading.closest("section")!).getAllByRole("button", { name: t("providers.custom.addAnthropic") })[0]);
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText(t("providers.custom.format")) as HTMLSelectElement).value).toBe("anthropic");
    fireEvent.change(within(dialog).getByLabelText(t("providers.custom.id")), { target: { value: "corp" } });
    fireEvent.change(within(dialog).getByLabelText(t("providers.name")), { target: { value: "Corp" } });
    fireEvent.change(within(dialog).getByLabelText(t("providers.custom.baseUrl")), { target: { value: "https://claude.corp.test" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("ux.providers.custom.create") }));
    expect(await within(dialog).findByText(t("providers.custom.idTaken"))).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ format: "anthropic" });
  });
});

describe("providers page: test all", () => {
  it("tests every enabled connection of the section, a few at a time, and sums up", async () => {
    routes["GET /admin/providers"] = () => json([builtin("openai", "OpenAI"), builtin("groq", "Groq"), CORP]);
    routes["GET /admin/connections"] = () => json([conn("c1", "openai"), conn("c2", "openai", true), conn("c3", "groq"), conn("c4", "groq"), conn("c5", "corp")]);
    routes["POST /admin/connections/c1/test"] = () => json({ ok: true });
    routes["POST /admin/connections/c3/test"] = () => json({ ok: false, status: 401, message: "bad key" });
    routes["POST /admin/connections/c4/test"] = () => json({ ok: true });
    routes["POST /admin/connections/c5/test"] = () => json({ ok: true });
    render(<Providers />);

    const heading = await screen.findByRole("heading", { name: t("providers.section.api_key") });
    const section = heading.closest("section")!;
    fireEvent.click(within(section).getByRole("button", { name: t("providers.testAllLabel", { section: t("providers.section.api_key") }) }));

    expect(await screen.findByText(t("providers.testAllSome", { ok: "2", failed: "1" }))).toBeTruthy();
    const tested = calls.filter((c) => c.method === "POST").map((c) => c.url).sort();
    // The disabled connection (c2) and the custom section's (c5) are not tested.
    expect(tested).toEqual(["/admin/connections/c1/test", "/admin/connections/c3/test", "/admin/connections/c4/test"]);
  });

  it("has no Test all button for a section with no enabled connection", async () => {
    routes["GET /admin/providers"] = () => json([builtin("openai", "OpenAI"), CORP]);
    routes["GET /admin/connections"] = () => json([conn("c1", "openai", true)]);
    render(<Providers />);
    const heading = await screen.findByRole("heading", { name: t("providers.section.api_key") });
    expect(within(heading.closest("section")!).queryByRole("button", { name: t("providers.testAllLabel", { section: t("providers.section.api_key") }) })).toBeNull();
  });
});

describe("provider detail: a custom provider", () => {
  beforeEach(() => {
    routes["GET /admin/providers"] = () => json([CORP]);
  });

  it("shows the base URL and saves an edit", async () => {
    routes["GET /admin/connections"] = () => json([]);
    routes["PATCH /admin/custom-providers/corp"] = (body) => json({ ...CORP, ...(body as object) });
    render(<ProviderDetail id="corp" />);
    expect(await screen.findByText("https://llm.corp.test/v1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("providers.custom.edit") }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText(t("providers.custom.id"))).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(t("providers.name")), { target: { value: "Corp 2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.save") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Corp 2", format: "openai", base_url: "https://llm.corp.test/v1" });
  });

  it("says why a provider with connections cannot be deleted", async () => {
    routes["GET /admin/connections"] = () => json([conn("c5", "corp")]);
    routes["DELETE /admin/custom-providers/corp"] = () => json({ error: "in_use", message: "delete its 1 connection(s) first", connections: 1 }, 409);
    render(<ProviderDetail id="corp" />);
    fireEvent.click(await screen.findByRole("button", { name: t("providers.custom.delete") }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(t("providers.deleteTitle", { name: "Corp LLM" }))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: t("providers.delete") }));
    expect(await within(dialog).findByText(t("providers.custom.inUse", { n: "1" }))).toBeTruthy();
    expect(window.location.hash).toBe("");
  });

  it("deletes it and goes back to the providers", async () => {
    routes["GET /admin/connections"] = () => json([]);
    routes["DELETE /admin/custom-providers/corp"] = () => new Response(null, { status: 204 });
    render(<ProviderDetail id="corp" />);
    fireEvent.click(await screen.findByRole("button", { name: t("providers.custom.delete") }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: t("providers.delete") }));
    await waitFor(() => expect(window.location.hash).toBe("#/providers"));
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/admin/custom-providers/corp")).toBe(true);
  });

  it("has no edit or delete for a built-in provider", async () => {
    routes["GET /admin/providers"] = () => json([builtin("openai", "OpenAI")]);
    routes["GET /admin/connections"] = () => json([]);
    render(<ProviderDetail id="openai" />);
    expect(await screen.findByRole("button", { name: t("providers.add") })).toBeTruthy();
    expect(screen.queryByRole("button", { name: t("providers.custom.edit") })).toBeNull();
  });
});
