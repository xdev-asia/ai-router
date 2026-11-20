// MCP tokens: the owner makes tokens for AI clients, each with a level (none, read, write) per group of tools and an
// optional expiry. /mcp lists and runs only what the token may use. Only the hash is stored.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, call, fakeUpstream, reset } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const up = () => fakeUpstream(() => json({}));

const admin = (method: string, path: string, body?: unknown) =>
  call(up(), `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

let nextId = 1;
const rpc = (token: string, method: string, params?: unknown) =>
  call(up(), "/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) }),
  });

const toolNames = async (token: string) => (JSON.parse((await rpc(token, "tools/list")).text).result.tools as { name: string }[]).map((t) => t.name);
const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) => JSON.parse((await rpc(token, "tools/call", { name, arguments: args })).text).result as { isError?: boolean; content: { text: string }[] };

async function create(body: Record<string, unknown>): Promise<{ id: string; token: string }> {
  const r = await admin("POST", "/mcp-tokens", body);
  expect(r.res.status, r.text).toBe(201);
  return JSON.parse(r.text);
}

beforeEach(reset);

describe("admin: MCP tokens", () => {
  it("creates a token, shows it once, stores only its hash, and lists it without it", async () => {
    const r = await admin("POST", "/mcp-tokens", { name: "Claude Code laptop", scopes: { combos: "write", usage: "read" }, expires_days: 30 });
    expect(r.res.status).toBe(201);
    const made = JSON.parse(r.text);
    expect(made.token).toMatch(/^xmcp_[A-Za-z0-9_-]{43}$/);
    expect(made).toMatchObject({ name: "Claude Code laptop", scopes: { combos: "write", models: "none", systems: "none", connections: "none", usage: "read", settings: "none" }, hint: made.token.slice(-4) });
    expect(made.expires_at - made.created_at).toBe(30 * 86400);

    const stored = await env.DB.prepare("SELECT * FROM mcp_token WHERE id = ?").bind(made.id).first<Record<string, unknown>>();
    expect(JSON.stringify(stored)).not.toContain(made.token);

    const list = await admin("GET", "/mcp-tokens");
    expect(list.text).not.toContain(made.token);
    expect(list.text).not.toContain("token_sha256");
    expect(JSON.parse(list.text)).toEqual([expect.objectContaining({ id: made.id, name: "Claude Code laptop", hint: made.token.slice(-4), last_used_at: null })]);
  });

  it("no expiry when expires_days is null; refuses a bad name, level, group or expiry", async () => {
    const forever = await create({ name: "ci", scopes: {}, expires_days: null });
    expect((await admin("GET", "/mcp-tokens")).text).toContain(`"expires_at":null`);
    expect(forever.token).toBeTruthy();
    for (const body of [
      { name: "", scopes: {} },
      { name: "x", scopes: { combos: "admin" } },
      { name: "x", scopes: { tokens: "write" } },
      { name: "x", scopes: { usage: "write" } },
      { name: "x", scopes: {}, expires_days: 5 },
    ]) {
      const r = await admin("POST", "/mcp-tokens", body);
      expect(r.res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("changes a token's name and levels, and revokes it", async () => {
    const t = await create({ name: "a", scopes: { combos: "read" } });
    const patched = await admin("PATCH", `/mcp-tokens/${t.id}`, { name: "b", scopes: { combos: "write", models: "read" } });
    expect(JSON.parse(patched.text)).toMatchObject({ name: "b", scopes: { combos: "write", models: "read" } });
    expect((await admin("DELETE", `/mcp-tokens/${t.id}`)).res.status).toBe(204);
    expect((await rpc(t.token, "tools/list")).res.status).toBe(401);
    expect((await admin("DELETE", `/mcp-tokens/${t.id}`)).res.status).toBe(404);
  });

  it("an MCP token cannot reach the admin API itself", async () => {
    const t = await create({ name: "a", scopes: { combos: "write", models: "write", systems: "write", connections: "write", usage: "read", settings: "write" } });
    const r = await call(up(), "/admin/mcp-tokens", { headers: { authorization: `Bearer ${t.token}` } });
    expect(r.res.status).toBe(401);
  });
});

describe("/mcp with an MCP token", () => {
  it("lists only the tools its levels allow, and get_status always", async () => {
    const t = await create({ name: "a", scopes: { combos: "read", usage: "read" } });
    const names = await toolNames(t.token);
    expect(names.sort()).toEqual(["get_logs", "get_status", "list_combos", "usage_by_month", "usage_requests", "usage_summary"]);
  });

  it("write includes read", async () => {
    const t = await create({ name: "a", scopes: { combos: "write" } });
    expect((await toolNames(t.token)).sort()).toEqual(["delete_combo", "get_status", "list_combos", "save_combo", "set_combo_settings"]);
  });

  it("runs an allowed change and refuses one its levels do not allow", async () => {
    const t = await create({ name: "a", scopes: { combos: "read" } });
    const refused = await callTool(t.token, "save_combo", { name: "fast", targets: ["openai/gpt-5"] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("combos");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM combo").first<{ n: number }>())!.n).toBe(0);

    const w = await create({ name: "b", scopes: { combos: "write" } });
    const ok = await callTool(w.token, "save_combo", { name: "fast", targets: ["openai/gpt-5"] });
    expect(ok.isError, ok.content[0]!.text).toBeFalsy();
    expect(JSON.parse((await callTool(t.token, "list_combos")).content[0]!.text)).toEqual([expect.objectContaining({ name: "fast" })]);
  });

  it("an expired token is refused", async () => {
    const t = await create({ name: "a", scopes: { combos: "read" }, expires_days: 7 });
    await env.DB.prepare("UPDATE mcp_token SET expires_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 1, t.id).run();
    expect((await rpc(t.token, "tools/list")).res.status).toBe(401);
  });

  it("records when the token was last used", async () => {
    const t = await create({ name: "a", scopes: { combos: "read" } });
    await rpc(t.token, "tools/list");
    const row = await env.DB.prepare("SELECT last_used_at FROM mcp_token WHERE id = ?").bind(t.id).first<{ last_used_at: number | null }>();
    expect(row!.last_used_at).toBeGreaterThan(0);
  });

  it("the admin token still sees every tool", async () => {
    expect((await toolNames(ADMIN_TOKEN)).length).toBe(36);
  });
});
