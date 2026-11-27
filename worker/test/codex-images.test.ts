import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (account: string) =>
  `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email: "dev@example.com", "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "plus" } }))}.sig`;
const tokens = (n: number) => ({ access_token: `at-${n}`, refresh_token: `rt-${n}`, id_token: idToken("acc_1"), expires_in: 3600 });

const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function signIn(): Promise<Record<string, unknown>> {
  const up = fakeUpstream(() => json(tokens(1)));
  const start = JSON.parse((await adminCall(up, "POST", "/oauth/codex/start")).text) as { authorize_url: string };
  const state = new URL(start.authorize_url).searchParams.get("state");
  const finished = await adminCall(up, "POST", "/oauth/codex/finish", { callback_url: `http://localhost:1455/auth/callback?code=c&state=${state}` });
  expect(finished.res.status, finished.text).toBe(201);
  return JSON.parse(finished.text);
}

const sse = (events: Record<string, unknown>[]) => new Response(events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const PNG = "iVBORw0KGgoAAAANSUhEUg==";
const drawn = (result = PNG) => [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", item: { id: "ig_1", type: "image_generation_call", status: "in_progress" } },
  { type: "response.image_generation_call.partial_image", item_id: "ig_1", partial_image_b64: "cGFydGlhbA==" },
  { type: "response.output_item.done", item: { id: "ig_1", type: "image_generation_call", status: "completed", result, revised_prompt: "a red apple, photo" } },
  { type: "response.completed", response: { id: "resp_1", model: "gpt-6-luna", usage: { input_tokens: 40, output_tokens: 9, input_tokens_details: { cached_tokens: 0 } } } },
];
const draw = (token: string, body: unknown) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

async function system(models = '["codex/*"]'): Promise<string> {
  const token = await addSystem("art");
  await env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = 'art'").bind(models).run();
  return token;
}

beforeEach(reset);

describe("images through a ChatGPT (Codex) account", () => {
  it("asks the Codex backend for its image_generation tool and answers as OpenAI images", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => sse(drawn()));
    const { res, text } = await call(up, "/openai/v1/images/generations", draw(token, { model: "codex/gpt-6-luna", prompt: "a red apple", size: "1024x1536", n: 1, response_format: "b64_json" }));
    expect(res.status, text).toBe(200);
    const sent = up.calls[0]!;
    expect(sent.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(sent.headers.get("authorization")).toBe("Bearer at-1");
    expect(sent.headers.get("chatgpt-account-id")).toBe("acc_1");
    expect(sent.headers.get("originator")).toBe("codex_cli_rs");
    const body = JSON.parse(up.bodies[0]!);
    expect(body).toMatchObject({
      model: "gpt-6-luna",
      stream: true,
      store: false,
      // The backend draws landscape unless the prompt says otherwise.
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "a red apple\n\nMake it a vertical portrait image, taller than wide, 1024x1536 pixels." }] }],
      tools: [{ type: "image_generation", size: "1024x1536", output_format: "png" }],
      tool_choice: { type: "image_generation" },
    });
    expect(typeof body.instructions).toBe("string");
    for (const dropped of ["prompt", "n", "size", "response_format"]) expect(body, dropped).not.toHaveProperty(dropped);

    const out = JSON.parse(text);
    expect(out.data).toEqual([{ b64_json: PNG, revised_prompt: "a red apple, photo" }]);
    expect(typeof out.created).toBe("number");
    expect(out.usage).toEqual({ input_tokens: 40, output_tokens: 9, total_tokens: 49 });
    expect(await usageRows("art")).toEqual([expect.objectContaining({ provider: "codex", model: "gpt-6-luna", status: 200, input_tokens: 40, output_tokens: 9 })]);
  });

  it("passes quality, background and output format to the tool, and asks once per image for n up to 4", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => sse(drawn()));
    const { res, text } = await call(up, "/openai/v1/images/generations", draw(token, { model: "codex/gpt-6-luna", prompt: "logo", n: 2, quality: "low", background: "transparent", output_format: "webp" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text).data).toHaveLength(2);
    expect(up.calls).toHaveLength(2);
    expect(JSON.parse(up.bodies[0]!).tools).toEqual([{ type: "image_generation", quality: "low", background: "transparent", output_format: "webp" }]);
    // No size asked: the prompt goes as it was.
    expect(JSON.parse(up.bodies[0]!).input[0].content[0].text).toBe("logo");
  });

  it("refuses a request it cannot answer before sending anything", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => sse(drawn()));
    const bad: [unknown, string][] = [
      [{ model: "codex/gpt-6-luna" }, "prompt"],
      [{ model: "codex/gpt-6-luna", prompt: "x", n: 5 }, "n"],
      [{ model: "codex/gpt-6-luna", prompt: "x", size: "big" }, "size"],
      [{ model: "codex/gpt-6-luna", prompt: "x", response_format: "url" }, "response_format"],
      [{ model: "codex/gpt-6-luna", prompt: "x", output_format: "gif" }, "output_format"],
    ];
    for (const [b, field] of bad) {
      const { res, text } = await call(up, "/openai/v1/images/generations", draw(token, b));
      expect(res.status, field).toBe(400);
      expect(JSON.parse(text).error.message, field).toContain(field);
    }
    expect(up.calls).toHaveLength(0);
  });

  it("keeps to the system's allowed models", async () => {
    const token = await system('["openai/*"]');
    await signIn();
    const up = fakeUpstream(() => sse(drawn()));
    const { res } = await call(up, "/openai/v1/images/generations", draw(token, { model: "codex/gpt-6-luna", prompt: "x" }));
    expect(res.status).toBe(403);
    expect(up.calls).toHaveLength(0);
  });

  it("says to sign in when no account is connected", async () => {
    const token = await system();
    const up = fakeUpstream(() => sse(drawn()));
    const { res, text } = await call(up, "/openai/v1/images/generations", draw(token, { model: "codex/gpt-6-luna", prompt: "x" }));
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error.code).toBe("not_configured");
    expect(up.calls).toHaveLength(0);
  });

  it("an answer without an image is a 502 that says what the model did instead", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() =>
      sse([
        { type: "response.output_text.delta", delta: "I can't draw that." },
        { type: "response.completed", response: { id: "r", model: "gpt-6-luna", usage: { input_tokens: 5, output_tokens: 5 } } },
      ]),
    );
    const { res, text } = await call(up, "/openai/v1/images/generations", draw(token, { model: "codex/gpt-6-luna", prompt: "x" }));
    expect(res.status).toBe(502);
    expect(JSON.parse(text).error.message).toContain("I can't draw that.");
  });

  it("a failure inside the stream is a 502 with the provider's message", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => sse([{ type: "response.failed", response: { error: { message: "image_generation is not enabled for this account" } } }]));
    const { res, text } = await call(up, "/openai/v1/images/generations", draw(token, { model: "codex/gpt-6-luna", prompt: "x" }));
    expect(res.status).toBe(502);
    expect(JSON.parse(text).error.message).toBe("image_generation is not enabled for this account");
  });

  it("passes Codex's own refusal on with its status, and sets the account aside on a 429", async () => {
    const token = await system();
    const conn = await signIn();
    const up = fakeUpstream(() => json({ detail: "You've hit your usage limit." }, 429));
    const { res, text } = await call(up, "/openai/v1/images/generations", draw(token, { model: "codex/gpt-6-luna", prompt: "x" }));
    expect(res.status).toBe(429);
    expect(JSON.parse(text).error.message).toBe("You've hit your usage limit.");
    const row = await env.DB.prepare("SELECT last_error FROM connection WHERE id = ?").bind(conn.id).first<{ last_error: string | null }>();
    expect(row!.last_error).toContain("usage limit");
  });

  it("a 401 renews the token once and sends again", async () => {
    const token = await system();
    await signIn();
    let sent = 0;
    const up = fakeUpstream((req) => {
      if (new URL(req.url).host === "auth.openai.com") return json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
      return ++sent === 1 ? json({ detail: "token expired" }, 401) : sse(drawn());
    });
    const { res } = await call(up, "/openai/v1/images/generations", draw(token, { model: "codex/gpt-6-luna", prompt: "x" }));
    expect(res.status).toBe(200);
    expect(up.calls.map((r) => new URL(r.url).host)).toEqual(["chatgpt.com", "auth.openai.com", "chatgpt.com"]);
    expect(up.calls[2]!.headers.get("authorization")).toBe("Bearer at-2");
  });

  it("goes through the Codex relay when one is set", async () => {
    const token = await system();
    await signIn();
    const up = fakeUpstream(() => sse(drawn()));
    const { res, text } = await call(up, "/openai/v1/images/generations", draw(token, { model: "codex/gpt-6-luna", prompt: "x" }), {
      CODEX_RELAY_URL: "https://relay.test",
      CODEX_RELAY_SECRET: "test-relay-secret",
    });
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe("https://relay.test/codex/responses");
    expect(up.calls[0]!.headers.get("x-relay-secret")).toBe("test-relay-secret");
    expect(text).not.toContain("test-relay-secret");
  });

  it("the console's image playground draws through a Codex account too", async () => {
    await system();
    await signIn();
    const up = fakeUpstream(() => sse(drawn()));
    const { res, text } = await call(up, "/admin/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ system: "art", model: "codex/gpt-6-luna", prompt: "x" }),
    });
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text).data[0].b64_json).toBe(PNG);
  });
});
