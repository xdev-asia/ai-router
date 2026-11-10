import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, call, fakeUpstream, messagesInit, reset } from "./helpers";

const up = () =>
  fakeUpstream(
    () =>
      new Response(JSON.stringify({ model: "claude-opus-5-5", usage: { input_tokens: 2, output_tokens: 1 } }), {
        headers: { "content-type": "application/json" },
      }),
  );

const admin = (method: string, body?: unknown, token = ADMIN_TOKEN): RequestInit => ({
  method,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(reset);

describe("admin access", () => {
  it("refuses without the admin token", async () => {
    expect((await call(up(), "/admin/systems")).res.status).toBe(401);
  });

  it("refuses a wrong admin token", async () => {
    expect((await call(up(), "/admin/systems", admin("GET", undefined, "nope"))).res.status).toBe(401);
  });

  it("refuses a system gateway token", async () => {
    const created = await call(up(), "/admin/systems", admin("POST", { id: "xdevd", name: "xdevd" }));
    const { token } = JSON.parse(created.text);
    expect((await call(up(), "/admin/systems", admin("GET", undefined, token))).res.status).toBe(401);
  });
});

describe("systems", () => {
  it("creates a system, returns its token once, and the token works on the proxy", async () => {
    const created = await call(up(), "/admin/systems", admin("POST", { id: "xdevd", name: "xDev daemon", monthly_token_cap: 1000 }));
    expect(created.res.status).toBe(201);
    const { id, token } = JSON.parse(created.text);
    expect(id).toBe("xdevd");
    expect(token).toMatch(/^xllm_[A-Za-z0-9_-]{43}$/);

    const row = await env.DB.prepare("SELECT token_sha256 FROM system WHERE id = 'xdevd'").first<{ token_sha256: string }>();
    expect(row!.token_sha256).not.toContain(token);

    const list = await call(up(), "/admin/systems", admin("GET"));
    const systems = JSON.parse(list.text);
    expect(systems).toEqual([expect.objectContaining({ id: "xdevd", name: "xDev daemon", monthly_token_cap: 1000, disabled: false })]);
    expect(list.text).not.toContain("token_sha256");

    expect((await call(up(), "/anthropic/v1/messages", messagesInit(token, {}))).res.status).toBe(200);
  });

  it("rejects a bad id and a duplicate id", async () => {
    expect((await call(up(), "/admin/systems", admin("POST", { id: "Bad Id", name: "x" }))).res.status).toBe(400);
    expect((await call(up(), "/admin/systems", admin("POST", { id: "xdevd", name: "x" }))).res.status).toBe(201);
    expect((await call(up(), "/admin/systems", admin("POST", { id: "xdevd", name: "x" }))).res.status).toBe(409);
  });

  it("rotates a token: the old one stops working, the new one works", async () => {
    const { token: old } = JSON.parse((await call(up(), "/admin/systems", admin("POST", { id: "xdevd", name: "x" }))).text);
    const rotated = await call(up(), "/admin/systems/xdevd/rotate", admin("POST"));
    expect(rotated.res.status).toBe(200);
    const { token: fresh } = JSON.parse(rotated.text);
    expect(fresh).not.toBe(old);
    expect((await call(up(), "/anthropic/v1/messages", messagesInit(old, {}))).res.status).toBe(401);
    expect((await call(up(), "/anthropic/v1/messages", messagesInit(fresh, {}))).res.status).toBe(200);
  });

  it("disables and re-enables a system, and changes its cap", async () => {
    const { token } = JSON.parse((await call(up(), "/admin/systems", admin("POST", { id: "xdevd", name: "x" }))).text);
    const off = await call(up(), "/admin/systems/xdevd", admin("PATCH", { disabled: true, monthly_token_cap: 5 }));
    expect(JSON.parse(off.text)).toMatchObject({ disabled: true, monthly_token_cap: 5 });
    expect((await call(up(), "/anthropic/v1/messages", messagesInit(token, {}))).res.status).toBe(403);
    await call(up(), "/admin/systems/xdevd", admin("PATCH", { disabled: false, monthly_token_cap: null }));
    expect((await call(up(), "/anthropic/v1/messages", messagesInit(token, {}))).res.status).toBe(200);
  });

  it("answers 404 for an unknown system", async () => {
    expect((await call(up(), "/admin/systems/none/rotate", admin("POST"))).res.status).toBe(404);
    expect((await call(up(), "/admin/systems/none", admin("PATCH", { disabled: true }))).res.status).toBe(404);
  });
});

describe("usage report", () => {
  it("sums this month's usage per system and model", async () => {
    const { token } = JSON.parse((await call(up(), "/admin/systems", admin("POST", { id: "xdevd", name: "x" }))).text);
    await call(up(), "/anthropic/v1/messages", messagesInit(token, {}));
    await call(up(), "/anthropic/v1/messages", messagesInit(token, {}));

    const report = await call(up(), "/admin/usage", admin("GET"));
    expect(report.res.status).toBe(200);
    const { month, rows } = JSON.parse(report.text);
    expect(month).toMatch(/^\d{4}-\d{2}$/);
    expect(rows).toEqual([
      {
        system_id: "xdevd",
        provider: "anthropic",
        model: "claude-opus-5-5",
        requests: 2,
        input_tokens: 4,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    ]);
  });

  it("rejects a malformed month", async () => {
    expect((await call(up(), "/admin/usage?month=2026-13", admin("GET"))).res.status).toBe(400);
  });
});
