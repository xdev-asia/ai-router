import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth } from "../api";
import { resetLang, t } from "../i18n";
import { NotifyContext } from "../notify";
import { ui } from "../ui-labels";
import { Media, mediaKeyOk, type MediaApiProvider } from "../pages/Media";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Made-up values: no real key ever goes in a test. */
const FAKE_KEY = "fake-media-key-not-real-0042";
const FAKE_AWS = "AKIAFAKEFAKEFAKE0000:fake-secret-not-real-000000:eu-west-1";

let calls: { method: string; url: string; body: unknown }[];
let routes: Record<string, (body?: unknown) => Response>;

const provider = (p: Partial<MediaApiProvider> & Pick<MediaApiProvider, "id" | "name" | "kinds">): MediaApiProvider => ({
  color: "#123456",
  mark: p.name.slice(0, 2),
  alias: null,
  key_url: `https://${p.id}.example/keys`,
  key_format: "plain",
  models: Object.fromEntries(p.kinds.map((k) => [k, ["model-a"]])),
  connections: 0,
  env_key: false,
  configured: false,
  ...p,
});

let mediaProviders: MediaApiProvider[];

beforeEach(() => {
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  window.location.hash = "";
  calls = [];
  mediaProviders = [
    provider({ id: "elevenlabs", name: "ElevenLabs", kinds: ["speech", "transcription"], connections: 2, configured: true }),
    provider({ id: "aws-polly", name: "Amazon Polly", kinds: ["speech"], key_format: "aws" }),
    provider({ id: "voyage-ai", name: "Voyage AI", kinds: ["embeddings"] }),
  ];
  routes = {
    "GET /admin/media": () =>
      json({
        kinds: [{ kind: "speech", path: "/v1/audio/speech", body: "json" }],
        providers: [],
        media_providers: mediaProviders,
        unsupported: [{ id: "edge-tts", name: "Edge TTS", reason: "scrapes" }],
      }),
    "GET /admin/providers": () => json([]),
    "GET /admin/connections": () => json([]),
    "POST /admin/media/connections": (body) => {
      const b = body as { provider: string };
      mediaProviders = mediaProviders.map((p) => (p.id === b.provider ? { ...p, connections: 1, configured: true } : p));
      return json({ id: "c9", provider: b.provider, hint: "0000" }, 201);
    },
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

describe("media providers with their own API", () => {
  it("checks the key's shape per format", () => {
    expect(mediaKeyOk("plain", FAKE_KEY)).toBe(true);
    expect(mediaKeyOk("plain", "has space")).toBe(false);
    expect(mediaKeyOk("plain", "  ")).toBe(false);
    expect(mediaKeyOk("aws", FAKE_AWS)).toBe(true);
    expect(mediaKeyOk("aws", "AKIAFAKEFAKEFAKE0000:fake-secret-not-real-000000")).toBe(true);
    expect(mediaKeyOk("aws", "lowercase-id:fake-secret-not-real-000000")).toBe(false);
    expect(mediaKeyOk("aws", "AKIAFAKEFAKEFAKE0000:short")).toBe(false);
    expect(mediaKeyOk("playht", "fake-user:fake-key")).toBe(true);
    expect(mediaKeyOk("playht", FAKE_KEY)).toBe(false);
  });

  it("shows the providers that serve the tab's kind, with their key state, and what is not offered", async () => {
    render(<Media tab="speech" />);
    const section = (await screen.findByRole("heading", { name: t("media.apiProviders") })).closest("section")!;
    expect(within(section).getByText("ElevenLabs")).toBeTruthy();
    expect(within(section).getByText(t("media.connected", { n: "2" }))).toBeTruthy();
    expect(within(section).getByText("Amazon Polly")).toBeTruthy();
    expect(within(section).getByText(t("media.noKey"))).toBeTruthy();
    expect(within(section).queryByText("Voyage AI")).toBeNull();
    expect(section.textContent).toContain("Edge TTS");
    expect(within(section).getByRole("link", { name: t("media.getKeyAt", { name: "Amazon Polly" }) }).getAttribute("href")).toBe("https://aws-polly.example/keys");
    // A provider with its own API stands in for the empty state.
    expect(screen.queryByText(t("media.none"))).toBeNull();
  });

  it("adds a key: refuses a bad shape without a call, then posts it once and reloads", async () => {
    render(<Media tab="speech" />);
    fireEvent.click(await screen.findByText("Amazon Polly"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("aws-polly/model-a");

    fireEvent.change(within(dialog).getByLabelText(t("media.apiKey")), { target: { value: FAKE_KEY } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.save") }));
    expect(await within(dialog).findByText(t("media.apiKeyBad"))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.change(within(dialog).getByLabelText(t("media.apiKey")), { target: { value: FAKE_AWS } });
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.save") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toEqual([{ method: "POST", url: "/admin/media/connections", body: { provider: "aws-polly", name: "Amazon Polly", api_key: FAKE_AWS } }]);
    const section = (await screen.findByRole("heading", { name: t("media.apiProviders") })).closest("section")!;
    await waitFor(() => expect(within(section).queryByText(t("media.noKey"))).toBeNull());
    // The key itself is never drawn on the page.
    expect(document.body.textContent).not.toContain(FAKE_AWS);
  });

  it("removes a provider's keys after a danger confirm, then reloads and says so", async () => {
    const row = (id: string, hint: string) => ({ id, provider: "elevenlabs", auth_type: "api_key", name: `Key ${hint}`, hint, disabled: false, cooldown_until: null });
    let conns = [row("m1", "0001"), row("m2", "0002"), { ...row("o1", "0003"), provider: "openai" }];
    routes["GET /admin/connections"] = () => json(conns);
    for (const id of ["m1", "m2"])
      routes[`DELETE /admin/connections/${id}`] = () => {
        conns = conns.filter((c) => c.id !== id);
        const left = conns.filter((c) => c.provider === "elevenlabs").length;
        mediaProviders = mediaProviders.map((p) => (p.id === "elevenlabs" ? { ...p, connections: left, configured: left > 0 } : p));
        return new Response(null, { status: 204 });
      };
    const notify = vi.fn();
    render(
      <NotifyContext.Provider value={notify}>
        <Media tab="speech" />
      </NotifyContext.Provider>,
    );

    // Only a provider with a stored key offers the action.
    const remove = await screen.findByRole("button", { name: t("media.removeKeysName", { name: "ElevenLabs" }) });
    expect(screen.queryByRole("button", { name: t("media.removeKeysName", { name: "Amazon Polly" }) })).toBeNull();

    // Cancel sends nothing.
    fireEvent.click(remove);
    let dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: ui("en").dialog.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    fireEvent.click(remove);
    dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Key 0001");
    expect(dialog.textContent).toContain("Key 0002");
    expect(dialog.textContent).not.toContain("Key 0003");
    fireEvent.click(within(dialog).getByRole("button", { name: t("media.removeKeys") }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/admin/connections/m1", "/admin/connections/m2"]);
    expect(notify).toHaveBeenCalledWith(t("media.keysRemoved", { name: "ElevenLabs" }));
    const section = (await screen.findByRole("heading", { name: t("media.apiProviders") })).closest("section")!;
    await waitFor(() => expect(within(section).getAllByText(t("media.noKey"))).toHaveLength(2));
    expect(screen.queryByRole("button", { name: t("media.removeKeysName", { name: "ElevenLabs" }) })).toBeNull();
  });
});
