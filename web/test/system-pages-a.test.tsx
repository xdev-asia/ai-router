import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLang, t } from "../i18n";
import { NotifyContext } from "../notify";
import { cliToolFromHash, pageFromHash } from "../App";
import { CliTools, MITM_TOOLS, TOKEN_PLACEHOLDER, TOOLS, filterTools, toolLogo, toolSnippets } from "../pages/CliTools";
import { Logs, logsPath, mergeLines, type LogLine } from "../pages/Logs";
import { Skills } from "../pages/Skills";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SKILLS = [
  { name: "ai-router", description: "Chat with any model behind this gateway.", url: "https://gw.example/skills/ai-router.md" },
  { name: "web", description: "Web search and page fetch through this gateway.", url: "https://gw.example/skills/web.md" },
];

const line = (id: number, level: LogLine["level"], path: string, model: string | null = null): LogLine => ({
  id,
  at: 1_790_000_000_000 + id * 1000,
  level,
  method: "POST",
  path,
  status: level === "error" ? 502 : 200,
  took_ms: 40 + id,
  system_id: "chat",
  model,
  message: level === "error" ? "upstream failed" : null,
});
const LINES = [line(2, "error", "/v1/messages", "anthropic/claude"), line(1, "info", "/v1/chat/completions", "openai/gpt-5")];

let calls: { method: string; url: string }[];
let logs: LogLine[];
let skillsStatus: number;

beforeEach(() => {
  localStorage.setItem("ai-router.lang", "en");
  resetLang();
  window.location.hash = "";
  calls = [];
  logs = [...LINES];
  skillsStatus = 200;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    calls.push({ method, url });
    const [path, search = ""] = url.split("?");
    const params = new URLSearchParams(search);
    if (method === "GET" && path === "/skills") return skillsStatus === 200 ? json(SKILLS) : json({ error: "down" }, skillsStatus);
    if (method === "GET" && path === "/admin/combos") return json([{ name: "coding", targets: ["openai/gpt-5"], updated_at: 1 }]);
    if (method === "GET" && path === "/admin/logs") {
      const level = params.get("level");
      const q = params.get("q");
      const after = Number(params.get("after") ?? 0);
      const rows = logs.filter(
        (l) => (!level || l.level === level) && (!q || [l.path, l.model, l.system_id, l.message].some((v) => v?.includes(q))) && l.id > after,
      );
      return json({ logs: rows, kept: { rows: 500, minutes: 15 } });
    }
    if (method === "DELETE" && path === "/admin/logs") {
      logs = [];
      return new Response(null, { status: 204 });
    }
    return json({ error: "not_found" }, 404);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CLI tools", () => {
  it("lists every tool as a card that opens its own page, then the MITM tools apart", () => {
    render(<CliTools tool={null} />);
    const tools = screen.getByRole("region", { name: new RegExp(t("cli.tools")) });
    const links = within(tools).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(TOOLS.map((tool) => `#/cli-tools/${tool.id}`));
    links.forEach((a, i) => expect(a.textContent, TOOLS[i].id).toContain(TOOLS[i].name));
    const mitm = screen.getByRole("region", { name: new RegExp(t("cli.mitm")) });
    for (const tool of MITM_TOOLS) expect(within(mitm).getByText(tool.name)).toBeTruthy();
    // A Worker cannot run a proxy on the owner's machine: the MITM tools say so and open nothing.
    expect(within(mitm).queryAllByRole("link")).toHaveLength(0);
    expect(mitm.textContent).toContain(t("cli.mitmNote"));
    expect(document.body.textContent).not.toContain(t("cli.notLocal"));
  });

  it("filters the cards by name", () => {
    render(<CliTools tool={null} />);
    fireEvent.change(screen.getByRole("searchbox", { name: t("cli.find") }), { target: { value: "gemini" } });
    const tools = screen.getByRole("region", { name: new RegExp(t("cli.tools")) });
    expect(within(tools).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["#/cli-tools/gemini-cli"]);
  });

  it("routes #/cli-tools/<id> to the tool's page", () => {
    expect(pageFromHash("#/cli-tools/codex")).toBe("cli-tools");
    expect(cliToolFromHash("#/cli-tools/codex")).toBe("codex");
    expect(cliToolFromHash("#/cli-tools")).toBeNull();
    expect(cliToolFromHash("#/providers/codex")).toBeNull();
  });

  it("names a logo file for the tools that have one, letters for the rest", () => {
    expect(toolLogo(TOOLS.find((x) => x.id === "claude-code")!)).toBe("/cli/claude-code.png");
    expect(toolLogo(TOOLS.find((x) => x.id === "aider")!)).toBeUndefined();
  });

  it("points Claude Code at this origin with the placeholder token, never a real one", async () => {
    render(<CliTools tool="claude-code" />);
    const origin = window.location.origin;
    await waitFor(() => expect(document.body.textContent).toContain(`ANTHROPIC_MODEL="combo/coding"`));
    const text = document.body.textContent ?? "";
    expect(text).toContain(`ANTHROPIC_BASE_URL="${origin}"`);
    expect(text).toContain(`ANTHROPIC_AUTH_TOKEN="${TOKEN_PLACEHOLDER}"`);
    expect(text).toContain(t("cli.notLocal"));
    expect(text).not.toMatch(/xllm_|sk-[a-z0-9]/i);
  });

  it("gives OpenAI-format tools the /v1 base URL", async () => {
    render(<CliTools tool="aider" />);
    const origin = window.location.origin;
    await waitFor(() => expect(document.body.textContent).toContain(`OPENAI_API_BASE="${origin}/v1"`));
    expect(document.body.textContent).toContain(`OPENAI_API_KEY="${TOKEN_PLACEHOLDER}"`);
  });

  it("gives Codex a Responses provider in config.toml and a command to check it is installed", async () => {
    render(<CliTools tool="codex" />);
    const origin = window.location.origin;
    await waitFor(() => expect(document.body.textContent).toContain('wire_api = "responses"'));
    const text = document.body.textContent ?? "";
    expect(text).toContain(`base_url = "${origin}/v1"`);
    expect(text).toContain('env_key = "AI_ROUTER_TOKEN"');
    expect(text).toContain(t("cli.speaks.responses"));
    expect(text).toContain(t("cli.check"));
    expect(text).toContain("codex --version");
    expect(text).not.toMatch(/xllm_|sk-[a-z0-9]/i);
  });

  it("points Gemini CLI at the origin, which serves /v1beta", async () => {
    render(<CliTools tool="gemini-cli" />);
    const origin = window.location.origin;
    await waitFor(() => expect(document.body.textContent).toContain(`GOOGLE_GEMINI_BASE_URL="${origin}"`));
    expect(document.body.textContent).toContain(`GEMINI_API_KEY="${TOKEN_PLACEHOLDER}"`);
    expect(document.body.textContent).toContain(t("cli.speaks.gemini"));
  });

  it("every tool's settings use the placeholder token and this origin", () => {
    for (const tool of TOOLS) {
      const code = toolSnippets(tool, "https://gw.example/", "combo/x").map((s) => s.code).join("\n");
      expect(code, tool.name).toContain("https://gw.example");
      expect(code, tool.name).not.toContain("https://gw.example//");
      if ((tool.format === "openai" || tool.format === "responses") && tool.id !== "goose") expect(code, tool.name).toContain("https://gw.example/v1");
      expect(code.includes(TOKEN_PLACEHOLDER) || code.includes("AI_ROUTER_TOKEN"), tool.name).toBe(true);
    }
    expect(filterTools(TOOLS, "claude code").map((x) => x.id)).toEqual(["claude-code"]);
  });

  it("lists the agents whose docs take a custom endpoint, with their logos", () => {
    const ids = TOOLS.map((x) => x.id);
    for (const id of ["openclaw", "hermes", "amp", "grok-build", "pi", "oh-my-pi", "codewhale", "smelt", "forgecode", "jcode", "claude-cowork"])
      expect(ids, id).toContain(id);
    // No custom endpoint in their docs: left out rather than guessed.
    for (const id of ["devin-cli", "opendesign", "deepseek-tui"]) expect(ids, id).not.toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(toolLogo(TOOLS.find((x) => x.id === "pi")!)).toBe("/cli/pi.svg");
    expect(toolLogo(TOOLS.find((x) => x.id === "hermes")!)).toBe("/cli/hermes.png");
    expect(toolLogo(TOOLS.find((x) => x.id === "claude-cowork")!)).toBeUndefined();
  });

  it("points Claude Cowork's gateway at the origin and jcode's key at stdin", () => {
    const cowork = toolSnippets(TOOLS.find((x) => x.id === "claude-cowork")!, "https://gw.example", "combo/x").map((s) => s.code).join("\n");
    expect(cowork).toContain('"inferenceGatewayBaseUrl": "https://gw.example"');
    expect(cowork).toContain(`"inferenceGatewayApiKey": "${TOKEN_PLACEHOLDER}"`);
    const jcode = toolSnippets(TOOLS.find((x) => x.id === "jcode")!, "https://gw.example", "combo/x").map((s) => s.code).join("\n");
    expect(jcode).toContain("--api-key-stdin");
    expect(jcode).not.toContain("--api-key ");
  });
});

describe("Skills", () => {
  it("lists the files from the public /skills, not /admin", async () => {
    render(<Skills />);
    expect(await screen.findByText("ai-router")).toBeTruthy();
    expect(screen.getByText("web")).toBeTruthy();
    expect(screen.getByText(SKILLS[0].url)).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain("/skills");
    expect(calls.some((c) => c.url.startsWith("/admin/skills"))).toBe(false);
    const open = screen.getByRole("link", { name: t("skills.open", { name: "web" }) });
    expect(open.getAttribute("href")).toBe(SKILLS[1].url);
    expect(document.body.textContent).toContain(`Read ${SKILLS[0].url}`);
  });

  it("copies a link and says so", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const notify = vi.fn();
    render(
      <NotifyContext.Provider value={notify}>
        <Skills />
      </NotifyContext.Provider>,
    );
    const rows = await screen.findAllByRole("button", { name: t("skills.copyLink") });
    fireEvent.click(rows[1]);
    await waitFor(() => expect(notify).toHaveBeenCalledWith(t("skills.copied", { name: "web" })));
    expect(writeText).toHaveBeenCalledWith(SKILLS[1].url);
  });

  it("offers a retry when /skills fails", async () => {
    skillsStatus = 500;
    render(<Skills />);
    const retry = await screen.findByRole("button", { name: t("common.retry") });
    skillsStatus = 200;
    fireEvent.click(retry);
    expect(await screen.findByText("ai-router")).toBeTruthy();
  });
});

describe("Logs", () => {
  it("filters by level and by text on the worker", async () => {
    render(<Logs />);
    expect(await screen.findByText("POST /v1/chat/completions")).toBeTruthy();
    expect(screen.getByText("POST /v1/messages")).toBeTruthy();
    expect(document.body.textContent).toContain(t("logs.kept", { rows: "500", minutes: "15" }));

    fireEvent.click(screen.getByRole("button", { name: t("logs.level.error") }));
    await waitFor(() => expect(screen.queryByText("POST /v1/chat/completions")).toBeNull());
    expect(screen.getByText("POST /v1/messages")).toBeTruthy();
    expect(calls.some((c) => c.url === "/admin/logs?level=error")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: t("logs.level.all") }));
    expect(await screen.findByText("POST /v1/chat/completions")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t("logs.filter")), { target: { value: "gpt" } });
    await waitFor(() => expect(calls.some((c) => c.url === "/admin/logs?q=gpt")).toBe(true));
    expect(await screen.findByText("POST /v1/chat/completions")).toBeTruthy();
    expect(screen.queryByText("POST /v1/messages")).toBeNull();

    fireEvent.change(screen.getByLabelText(t("logs.filter")), { target: { value: "nothing-matches" } });
    expect(await screen.findByText(t("logs.noMatch"))).toBeTruthy();
  });

  it("clears only after the owner confirms", async () => {
    const notify = vi.fn();
    render(
      <NotifyContext.Provider value={notify}>
        <Logs />
      </NotifyContext.Provider>,
    );
    await screen.findByText("POST /v1/messages");
    fireEvent.click(screen.getByRole("button", { name: t("logs.clear") }));
    const dialog = await screen.findByRole("alertdialog", { name: t("logs.clearTitle") });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: t("logs.clear") }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/admin/logs")).toBe(true));
    expect(await screen.findByText(t("logs.empty"))).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(notify).toHaveBeenCalledWith(t("logs.cleared"));
  });

  it("keeps the dialog away when the owner cancels", async () => {
    render(<Logs />);
    await screen.findByText("POST /v1/messages");
    fireEvent.click(screen.getByRole("button", { name: t("logs.clear") }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.getByText("POST /v1/messages")).toBeTruthy();
  });

  it("builds tail paths and merges new lines on top without repeats", () => {
    expect(logsPath("all", "")).toBe("/logs");
    expect(logsPath("warn", "gpt 5", 7)).toBe("/logs?level=warn&q=gpt+5&after=7");
    const merged = mergeLines([line(3, "info", "/a"), line(2, "error", "/b")], LINES);
    expect(merged.map((l) => l.id)).toEqual([3, 2, 1]);
  });
});
