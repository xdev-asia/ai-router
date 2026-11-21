// POST /mcp: a Model Context Protocol server (Streamable HTTP, stateless) over the admin API, so any AI client can
// check and change the gateway's settings with the admin token. Nothing that carries or returns a key is a tool.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, call, fakeUpstream, reset } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const up = () => fakeUpstream(() => json({}));

let nextId = 1;
const rpc = (method: string, params?: unknown, token: string | null = ADMIN_TOKEN, notification = false) =>
  call(up(), "/mcp", {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method, ...(notification ? {} : { id: nextId++ }), ...(params === undefined ? {} : { params }) }),
  });

/** Calls a tool and returns its result: `isError` and the parsed JSON of its text. */
async function tool(name: string, args: Record<string, unknown> = {}) {
  const { res, text } = await rpc("tools/call", { name, arguments: args });
  expect(res.status, text).toBe(200);
  const body = JSON.parse(text);
  expect(body.error, text).toBeUndefined();
  const content = body.result.content as { type: string; text: string }[];
  expect(content[0]!.type).toBe("text");
  let data: unknown = content[0]!.text;
  try {
    data = JSON.parse(content[0]!.text);
  } catch {
    // plain text
  }
  return { isError: body.result.isError === true, data: data as any, text: content[0]!.text };
}

const admin = (method: string, path: string, body?: unknown) =>
  call(up(), `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(reset);

describe("MCP transport", () => {
  it("refuses a request without the admin token, or with another token", async () => {
    const none = await rpc("tools/list", undefined, null);
    expect(none.res.status).toBe(401);
    expect(none.res.headers.get("www-authenticate")).toContain("Bearer");
    const wrong = await rpc("tools/list", undefined, "not-the-admin-token");
    expect(wrong.res.status).toBe(401);
  });

  it("initialize names the server and offers tools", async () => {
    const { res, text } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = JSON.parse(text);
    expect(body).toMatchObject({ jsonrpc: "2.0", id: expect.any(Number), result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ai-router" } } });
    expect(typeof body.result.instructions).toBe("string");
  });

  it("answers a protocol version it does not know with its own", async () => {
    const { text } = await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(JSON.parse(text).result.protocolVersion).toBe("2025-06-18");
  });

  it("accepts a notification with 202 and no body", async () => {
    const { res, text } = await rpc("notifications/initialized", undefined, ADMIN_TOKEN, true);
    expect(res.status).toBe(202);
    expect(text).toBe("");
  });

  it("answers ping, and -32601 for an unknown method", async () => {
    expect(JSON.parse((await rpc("ping")).text).result).toEqual({});
    expect(JSON.parse((await rpc("resources/list")).text).error.code).toBe(-32601);
  });

  it("answers -32700 for a body that is not JSON", async () => {
    const { res, text } = await call(up(), "/mcp", { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: "{" });
    expect(res.status).toBe(400);
    expect(JSON.parse(text).error.code).toBe(-32700);
  });

  it("GET is not offered: no server-sent stream", async () => {
    const { res } = await call(up(), "/mcp", { method: "GET", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, accept: "text/event-stream" } });
    expect(res.status).toBe(405);
  });
});

describe("MCP tools", () => {
  it("lists tools with schemas and hints, and none that takes or returns a key", async () => {
    const tools = JSON.parse((await rpc("tools/list")).text).result.tools as { name: string; inputSchema: { type: string; properties?: Record<string, unknown> }; annotations: Record<string, boolean> }[];
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_status", "list_connections", "save_combo", "delete_combo", "update_system", "update_connection", "usage_summary", "set_token_saver"]));
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
      expect(Object.keys(t.inputSchema.properties ?? {})).not.toEqual(expect.arrayContaining(["api_key"]));
    }
    expect(names).not.toEqual(expect.arrayContaining(["create_system", "rotate_system_token", "add_connection"]));
    expect(tools.find((t) => t.name === "list_combos")!.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "delete_combo")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("get_status reports the build and what is set up", async () => {
    const r = await tool("get_status");
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ version: expect.any(String), admin_token: true });
  });

  it("save_combo creates a combo; list_combos shows it; delete_combo removes it", async () => {
    const saved = await tool("save_combo", { name: "fast", targets: ["openai/gpt-5", "groq/llama-4"], strategy: "round-robin" });
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.data).toMatchObject({ name: "fast", targets: ["openai/gpt-5", "groq/llama-4"], strategy: "round-robin" });
    const listed = await tool("list_combos");
    expect(listed.data).toEqual([expect.objectContaining({ name: "fast" })]);
    expect((await tool("delete_combo", { name: "fast" })).isError).toBe(false);
    expect((await tool("list_combos")).data).toEqual([]);
  });

  it("save_combo passes a combo's timeouts on; list_combos shows them (FR-CTO-10)", async () => {
    const saved = await tool("save_combo", { name: "fast", targets: ["openai/gpt-5"], timeouts: { first_byte_s: 20 } });
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.data).toMatchObject({ timeouts: { first_byte_s: 20 } });
    expect((await tool("list_combos")).data).toEqual([expect.objectContaining({ name: "fast", timeouts: { first_byte_s: 20 } })]);
  });

  it("a refused change comes back as a tool error with the gateway's reason", async () => {
    const r = await tool("save_combo", { name: "bad name!", targets: ["openai/gpt-5"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("400");
    expect(r.text).toContain("invalid_input");
  });

  it("list_connections never shows a key; update_connection refuses one", async () => {
    const created = await admin("POST", "/connections", { provider: "openai", name: "work", api_key: "sk-live-abcd1234" });
    const id = JSON.parse(created.text).id as string;
    const listed = await tool("list_connections");
    expect(listed.text).not.toContain("sk-live");
    expect(listed.data).toEqual([expect.objectContaining({ id, name: "work", hint: "1234" })]);

    const off = await tool("update_connection", { id, disabled: true, priority: 2 });
    expect(off.data).toMatchObject({ id, disabled: true, priority: 2 });
    const before = await env.DB.prepare("SELECT secret FROM connection WHERE id = ?").bind(id).first<{ secret: string }>();
    const withKey = await tool("update_connection", { id, api_key: "sk-live-other999" });
    expect(withKey.isError).toBe(true);
    expect(withKey.text).toContain("console");
    const after = await env.DB.prepare("SELECT secret FROM connection WHERE id = ?").bind(id).first<{ secret: string }>();
    expect(after!.secret).toBe(before!.secret);
  });

  it("set_token_saver changes savers but not the Headroom address", async () => {
    const r = await tool("set_token_saver", { rtk: true, headroom: { enabled: true, url: "https://elsewhere.test" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("headroom");
    const ok = await tool("set_token_saver", { rtk: true, caveman: "lite" });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.data).toMatchObject({ rtk: true, caveman: "lite" });
  });

  it("update_system changes the allow-list", async () => {
    await admin("POST", "/systems", { id: "app", name: "App" });
    const r = await tool("update_system", { id: "app", allowed_models: ["openai/*", "combo/fast"] });
    expect(r.isError, r.text).toBe(false);
    const listed = await tool("list_systems");
    expect(listed.text).not.toContain("token_sha256");
    expect(listed.data).toEqual([expect.objectContaining({ id: "app" })]);
  });

  it("an unknown tool is a -32602 error", async () => {
    const body = JSON.parse((await rpc("tools/call", { name: "add_connection", arguments: {} })).text);
    expect(body.error.code).toBe(-32602);
  });

  it("a missing required argument is a tool error naming it", async () => {
    const r = await tool("delete_combo", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("name");
  });
});
