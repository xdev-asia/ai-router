// POST /admin/translate: shows the owner what the gateway sends upstream for a request in another format.
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, call, fakeUpstream, reset } from "./helpers";

const post = (body: unknown, token: string | null = ADMIN_TOKEN) => ({
  method: "POST",
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

beforeEach(reset);

describe("POST /admin/translate", () => {
  it("needs the admin token", async () => {
    const up = fakeUpstream(() => new Response("no"));
    const { res } = await call(up, "/admin/translate", post({ from: "responses", to: "openai", body: { model: "m", input: "hi" } }, null));
    expect(res.status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("turns a Responses request into a chat completions request", async () => {
    const up = fakeUpstream(() => new Response("no"));
    const { res, text } = await call(up, "/admin/translate", post({ from: "responses", to: "openai", body: { model: "openai/gpt-5", instructions: "Be brief.", input: "hi" } }));
    expect(res.status).toBe(200);
    const out = JSON.parse(text).result;
    expect(out.model).toBe("openai/gpt-5");
    expect(out.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
    ]);
    expect(up.calls).toHaveLength(0);
  });

  it("chains a Gemini request through chat into Anthropic Messages", async () => {
    const up = fakeUpstream(() => new Response("no"));
    const body = { systemInstruction: { parts: [{ text: "Be brief." }] }, contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 64 } };
    const { res, text } = await call(up, "/admin/translate", post({ from: "gemini", to: "anthropic", model: "claude-sonnet-4-5", body }));
    expect(res.status).toBe(200);
    const out = JSON.parse(text).result;
    expect(out.model).toBe("claude-sonnet-4-5");
    expect(out.system).toBeDefined();
    expect(JSON.stringify(out.system)).toContain("Be brief.");
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(out.max_tokens).toBe(64);
  });

  it("turns a chat completions request into Anthropic Messages", async () => {
    const up = fakeUpstream(() => new Response("no"));
    const { res, text } = await call(up, "/admin/translate", post({ from: "openai", to: "anthropic", body: { model: "claude-x", max_tokens: 10, messages: [{ role: "user", content: "hi" }] } }));
    expect(res.status).toBe(200);
    expect(JSON.parse(text).result).toMatchObject({ model: "claude-x", max_tokens: 10, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  });

  it("refuses unknown formats, a missing body, the same format twice and a Gemini request with no model", async () => {
    const up = fakeUpstream(() => new Response("no"));
    for (const b of [
      { from: "cobol", to: "openai", body: {} },
      { from: "openai", to: "gemini", body: {} },
      { from: "openai", to: "openai", body: { model: "m", messages: [{ role: "user", content: "hi" }] } },
      { from: "responses", to: "openai" },
      { from: "gemini", to: "openai", body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
    ]) {
      const { res, text } = await call(up, "/admin/translate", post(b));
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(JSON.parse(text).error).toBe("invalid_input");
    }
    expect((await call(up, "/admin/translate", post("{not json"))).res.status).toBe(400);
  });

  it("answers what the translator refused, as a 400 with its message", async () => {
    const up = fakeUpstream(() => new Response("no"));
    const { res, text } = await call(up, "/admin/translate", post({ from: "responses", to: "openai", body: { model: "m" } }));
    expect(res.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: "translate_failed", message: "input is required" });
  });
});
