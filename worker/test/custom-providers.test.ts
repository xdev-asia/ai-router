import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

// Fake keys and hosts only.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const COMPLETION = {
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "corp-large",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
};
const MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "corp-claude", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 } };

const admin = (method: string, path: string, body?: unknown, up: FakeUpstream = fakeUpstream(() => json({}))) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const chat = (token: string, model: string) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
});

const allow = (id: string, patterns: string[]) => env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(patterns), id).run();

async function create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await admin("POST", "/custom-providers", body);
  expect(r.res.status, r.text).toBe(201);
  return JSON.parse(r.text) as Record<string, unknown>;
}

async function connect(provider: string, apiKey: string): Promise<string> {
  const r = await admin("POST", "/connections", { provider, name: "main", api_key: apiKey });
  expect(r.res.status, r.text).toBe(201);
  return (JSON.parse(r.text) as { id: string }).id;
}

beforeEach(reset);

describe("admin: custom providers", () => {
  it("creates, lists, updates and deletes a custom provider", async () => {
    const created = await create({ id: "corp-ai", name: "Corp AI", format: "openai", base_url: "https://llm.corp.test/v1/" });
    expect(created).toMatchObject({ id: "corp-ai", name: "Corp AI", format: "openai", base_url: "https://llm.corp.test/v1" });

    const list = JSON.parse((await admin("GET", "/custom-providers")).text) as { id: string }[];
    expect(list).toEqual([expect.objectContaining({ id: "corp-ai", name: "Corp AI", format: "openai", base_url: "https://llm.corp.test/v1" })]);

    // It is listed with the built-in providers, marked as the owner's, with an API-key login.
    const providers = JSON.parse((await admin("GET", "/providers")).text) as Record<string, unknown>[];
    expect(providers.find((p) => p.id === "corp-ai")).toMatchObject({ name: "Corp AI", format: "openai", auth: ["api_key"], custom: true, base_url: "https://llm.corp.test/v1", env_key: false, key_url: null });
    expect(providers.find((p) => p.id === "openai")).not.toHaveProperty("custom");

    const patched = await admin("PATCH", "/custom-providers/corp-ai", { name: "Corp", base_url: "https://llm2.corp.test/v1", format: "anthropic" });
    expect(patched.res.status, patched.text).toBe(200);
    expect(JSON.parse(patched.text)).toMatchObject({ id: "corp-ai", name: "Corp", format: "anthropic", base_url: "https://llm2.corp.test/v1" });

    expect((await admin("PATCH", "/custom-providers/missing", { name: "x" })).res.status).toBe(404);
    expect((await admin("DELETE", "/custom-providers/corp-ai")).res.status).toBe(204);
    expect((await admin("DELETE", "/custom-providers/corp-ai")).res.status).toBe(404);
    expect(JSON.parse((await admin("GET", "/custom-providers")).text)).toEqual([]);
  });

  it("takes plain http only for a server on this machine or the local network (a local Ollama, LM Studio)", async () => {
    for (const url of ["http://host.docker.internal:11434/v1", "http://localhost:1234/v1", "http://127.0.0.1:8080/v1", "http://[::1]:11434/v1", "http://192.168.1.20:11434/v1", "http://10.0.0.5/v1", "http://172.20.0.3:8000/v1", "http://ollama:11434/v1"]) {
      const r = await admin("POST", "/custom-providers", { id: "local", name: "Local", format: "openai", base_url: url });
      expect(r.res.status, url).toBe(201);
      expect(JSON.parse(r.text).base_url, url).toBe(url.replace(/\/$/, ""));
      expect((await admin("DELETE", "/custom-providers/local")).res.status).toBe(204);
    }
    for (const url of ["http://a.test/v1", "http://8.8.8.8/v1", "http://172.32.0.1/v1", "http://192.169.0.1/v1", "http://localhost.evil.test/v1", "ftp://localhost/v1", "http://169.254.169.254/v1", "http://0.0.0.0/v1"]) {
      expect((await admin("POST", "/custom-providers", { id: "local", name: "Local", format: "openai", base_url: url })).res.status, url).toBe(400);
    }
  });

  it("blocks the cloud metadata address and 0.0.0.0, even over https", async () => {
    for (const base_url of ["https://169.254.169.254/v1", "https://169.254.1.2/latest", "http://169.254.169.254/v1", "https://0.0.0.0/v1", "http://0.0.0.0/v1", "https://[::]/v1"]) {
      const r = await admin("POST", "/custom-providers", { id: "meta", name: "Meta", format: "openai", base_url });
      expect(r.res.status, base_url).toBe(400);
    }
    // A normal private host over https is still fine (a real internal LLM).
    expect((await admin("POST", "/custom-providers", { id: "meta", name: "Meta", format: "openai", base_url: "https://10.0.0.5/v1" })).res.status).toBe(201);
  });

  it("refuses a bad id, name, format or base URL", async () => {
    for (const body of [
      { id: "Corp", name: "x", format: "openai", base_url: "https://a.test/v1" },
      { id: "c", name: "x", format: "openai", base_url: "https://a.test/v1" },
      { id: "corp/x", name: "x", format: "openai", base_url: "https://a.test/v1" },
      { id: "corp", name: "", format: "openai", base_url: "https://a.test/v1" },
      { id: "corp", name: "x", format: "codex", base_url: "https://a.test/v1" },
      { id: "corp", name: "x", format: "openai", base_url: "http://a.test/v1" },
      { id: "corp", name: "x", format: "openai", base_url: "https://user:pw@a.test/v1" },
      { id: "corp", name: "x", format: "openai", base_url: "not a url" },
      { id: "corp", name: "x", format: "openai" },
    ]) {
      expect((await admin("POST", "/custom-providers", body)).res.status, JSON.stringify(body)).toBe(400);
    }
    await create({ id: "corp", name: "x", format: "openai", base_url: "https://a.test/v1" });
    for (const bad of [{ name: "" }, { format: "codex" }, { base_url: "http://a.test" }]) {
      expect((await admin("PATCH", "/custom-providers/corp", bad)).res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("refuses to shadow a built-in provider, a built-in short alias, combo/ or another custom provider", async () => {
    for (const id of ["openai", "anthropic", "codex", "cx", "combo"]) {
      const r = await admin("POST", "/custom-providers", { id, name: "x", format: "openai", base_url: "https://a.test/v1" });
      expect(r.res.status, id).toBe(409);
      expect(JSON.parse(r.text).error).toBe("taken");
    }
    await create({ id: "corp", name: "x", format: "openai", base_url: "https://a.test/v1" });
    expect((await admin("POST", "/custom-providers", { id: "corp", name: "y", format: "openai", base_url: "https://b.test/v1" })).res.status).toBe(409);
  });

  it("refuses to delete a provider that still has connections, then deletes its models and settings with it", async () => {
    await create({ id: "corp", name: "Corp", format: "openai", base_url: "https://a.test/v1" });
    const conn = await connect("corp", "sk-corp-test-00001111");
    expect((await admin("POST", "/models/custom", { provider: "corp", id: "corp-large" })).res.status).toBeLessThan(300);

    const refused = await admin("DELETE", "/custom-providers/corp");
    expect(refused.res.status).toBe(409);
    expect(JSON.parse(refused.text).error).toBe("in_use");

    expect((await admin("DELETE", `/connections/${conn}`)).res.status).toBe(204);
    expect((await admin("DELETE", "/custom-providers/corp")).res.status).toBe(204);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM model_custom WHERE provider = 'corp'").first<number>("n")).toBe(0);
    // Gone: a connection to it is refused again.
    expect((await admin("POST", "/connections", { provider: "corp", name: "x", api_key: "sk-corp-test-1" })).res.status).toBe(400);
  });

  it("never returns a connection's key, and tests a key at the custom base URL", async () => {
    await create({ id: "corp", name: "Corp", format: "openai", base_url: "https://a.test/v1" });
    const id = await connect("corp", "sk-corp-test-secret-9999");
    const list = await admin("GET", "/connections");
    expect(list.text).not.toContain("sk-corp-test-secret");

    const up = fakeUpstream(() => json({ data: [] }));
    const tested = await admin("POST", `/connections/${id}/test`, undefined, up);
    expect(JSON.parse(tested.text)).toEqual({ ok: true });
    expect(up.calls[0]!.url).toBe("https://a.test/v1/models");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer sk-corp-test-secret-9999");
    expect(tested.text).not.toContain("sk-corp");
    for (const r of [await admin("GET", "/custom-providers"), await admin("GET", "/providers")]) expect(r.text).not.toContain("sk-corp");
  });

  it("tests an Anthropic-compatible key the Anthropic way, at its base URL", async () => {
    await create({ id: "corp-claude", name: "Corp Claude", format: "anthropic", base_url: "https://claude.corp.test" });
    const id = await connect("corp-claude", "sk-ant-corp-test-1234");
    const up = fakeUpstream(() => json({ data: [] }));
    const tested = await admin("POST", `/connections/${id}/test`, undefined, up);
    expect(JSON.parse(tested.text)).toEqual({ ok: true });
    expect(up.calls[0]!.url).toBe("https://claude.corp.test/v1/models?limit=1");
    expect(up.calls[0]!.headers.get("x-api-key")).toBe("sk-ant-corp-test-1234");
  });
});

describe("routing to a custom provider", () => {
  it("sends an OpenAI-compatible chat to <base URL>/chat/completions with the connection's key", async () => {
    await create({ id: "corp", name: "Corp", format: "openai", base_url: "https://a.test/v1" });
    await connect("corp", "sk-corp-test-00001111");
    const token = await addSystem("app");
    await allow("app", ["corp/*"]);

    const up = fakeUpstream(() => json(COMPLETION));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, "corp/corp-large"));
    expect(res.status, text).toBe(200);
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.url).toBe("https://a.test/v1/chat/completions");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer sk-corp-test-00001111");
    expect(JSON.parse(up.bodies[0]!).model).toBe("corp-large");
    expect(JSON.parse(text).choices[0].message.content).toBe("hello");
    expect(text).not.toContain("sk-corp");

    const rows = await usageRows("app");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "corp", input_tokens: 20, output_tokens: 4 });
    expect(JSON.stringify(rows)).not.toContain("sk-corp");
  });

  it("sends an Anthropic-compatible chat to <base URL>/v1/messages and answers in Chat Completions", async () => {
    await create({ id: "corp-claude", name: "Corp Claude", format: "anthropic", base_url: "https://claude.corp.test/" });
    await connect("corp-claude", "sk-ant-corp-test-5678");
    const token = await addSystem("app");
    await allow("app", ["corp-claude/*"]);

    const up = fakeUpstream(() => json(MESSAGE));
    const { res, text } = await call(up, "/v1/chat/completions", chat(token, "corp-claude/corp-claude"));
    expect(res.status, text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://claude.corp.test/v1/messages");
    expect(up.calls[0]!.headers.get("x-api-key")).toBe("sk-ant-corp-test-5678");
    expect(JSON.parse(up.bodies[0]!).model).toBe("corp-claude");
    expect(JSON.parse(text).choices[0].message.content).toBe("hi");
    expect(text).not.toContain("sk-ant-corp");

    const rows = await usageRows("app");
    expect(rows[0]).toMatchObject({ provider: "corp-claude", input_tokens: 7, output_tokens: 3 });
  });

  it("takes an Anthropic-compatible provider's models on the Anthropic surface, with its own key and base URL", async () => {
    await create({ id: "corp-claude", name: "Corp Claude", format: "anthropic", base_url: "https://claude.corp.test" });
    await connect("corp-claude", "sk-ant-corp-test-4321");
    const token = await addSystem("app");
    await allow("app", ["corp-claude/*"]);

    const up = fakeUpstream(() => json(MESSAGE));
    const body = { model: "corp-claude/corp-claude", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
    const { res, text } = await call(up, "/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": token, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual(MESSAGE);
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.url).toBe("https://claude.corp.test/v1/messages");
    // The provider's key, never the gateway token or the gateway's own Anthropic key.
    expect(up.calls[0]!.headers.get("x-api-key")).toBe("sk-ant-corp-test-4321");
    expect(JSON.parse(up.bodies[0]!)).toEqual({ ...body, model: "corp-claude" });

    const rows = await usageRows("app");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "corp-claude", input_tokens: 7, output_tokens: 3 });
  });

  it("serves an OpenAI-compatible provider's models on the Anthropic surface, translated to chat", async () => {
    await create({ id: "corp", name: "Corp", format: "openai", base_url: "https://a.test/v1" });
    await connect("corp", "sk-corp-test-00001111");
    const token = await addSystem("app");
    await allow("app", ["*"]);
    const up = fakeUpstream(() => json({ id: "c1", object: "chat.completion", model: "corp-large", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    const { res, text } = await call(up, "/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify({ model: "corp/corp-large", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status, text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://a.test/v1/chat/completions");
    expect(JSON.parse(text)).toMatchObject({ type: "message", model: "corp/corp-large", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
  });

  it("lists a custom provider's added models in /v1/models", async () => {
    await create({ id: "corp", name: "Corp", format: "openai", base_url: "https://a.test/v1" });
    await connect("corp", "sk-corp-test-00001111");
    expect((await admin("POST", "/models/custom", { provider: "corp", id: "corp-large" })).res.status).toBeLessThan(300);
    const token = await addSystem("app");
    await allow("app", ["corp/*"]);
    const { res, text } = await call(fakeUpstream(() => json({})), "/v1/models", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status, text).toBe(200);
    expect((JSON.parse(text) as { data: { id: string }[] }).data.map((m) => m.id)).toContain("corp/corp-large");
  });

  it("does not reach a deleted custom provider", async () => {
    await create({ id: "corp", name: "Corp", format: "openai", base_url: "https://a.test/v1" });
    expect((await admin("DELETE", "/custom-providers/corp")).res.status).toBe(204);
    const token = await addSystem("app");
    await allow("app", ["*"]);
    const up = fakeUpstream(() => json(COMPLETION));
    const { res } = await call(up, "/openai/v1/chat/completions", chat(token, "corp/corp-large"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(up.calls).toHaveLength(0);
  });
});

describe("custom provider lookups", () => {
  it("see the providers of the request they run in, not another request's", async () => {
    const { isProvider, runWithCustomProviders } = await import("../providers");
    const row = (id: string) => ({ id, name: id, format: "openai" as const, base_url: "https://a.test/v1" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = runWithCustomProviders([row("alpha")], async () => {
      await gate;
      return [isProvider("alpha"), isProvider("beta")];
    });
    const b = runWithCustomProviders([row("beta")], async () => [isProvider("alpha"), isProvider("beta")]);
    expect(await b).toEqual([false, true]);
    release();
    expect(await a).toEqual([true, false]);
  });
});
