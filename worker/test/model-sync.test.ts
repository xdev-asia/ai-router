// Model sync: a provider's own model list, fetched with one of its connections and kept in D1, so a model the
// provider adds (gpt-6.2-sol) shows up without a new release. Codex: chatgpt.com's codex/models (what Codex CLI
// reads), through the relay when one is set. OpenAI-format providers: {baseUrl}/models. Fake upstreams only.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stripMarkers } from "../models";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, type FakeUpstream } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (account: string) => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email: "dev@example.com", "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "plus" } }))}.sig`;
const tokens = { access_token: "at-1", refresh_token: "rt-1", id_token: idToken("acc_1"), expires_in: 3600 };

const adminCall = (up: FakeUpstream, method: string, path: string, body?: unknown, envOverride?: Record<string, unknown>) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, envOverride);

async function codexConnection(): Promise<void> {
  const up = fakeUpstream(() => json(tokens));
  const start = JSON.parse((await adminCall(up, "POST", "/oauth/codex/start")).text) as { authorize_url: string };
  const state = new URL(start.authorize_url).searchParams.get("state");
  const r = await adminCall(up, "POST", "/oauth/codex/finish", { callback_url: `http://localhost:1455/auth/callback?code=c&state=${state}` });
  expect(r.res.status, r.text).toBe(201);
}

const level = (effort: string) => ({ effort, description: effort });
const CODEX_MODELS = {
  models: [
    { slug: "gpt-6.2-sol", display_name: "GPT-6.2-Sol", visibility: "list", context_window: 500000, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map(level) },
    { slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list", context_window: 400000, supported_reasoning_levels: [level("low")] },
    { slug: "internal-only", display_name: "Internal", visibility: "hide" },
  ],
};

const models = async (provider: string) => JSON.parse((await adminCall(fakeUpstream(() => json({})), "GET", `/providers/${provider}/models`)).text);

beforeEach(reset);

describe("model sync: Codex", () => {
  it("reads chatgpt.com's codex/models with the account's token and keeps the listed models", async () => {
    await codexConnection();
    const up = fakeUpstream(() => json(CODEX_MODELS));
    const r = await adminCall(up, "POST", "/providers/codex/models/sync");
    expect(r.res.status, r.text).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ provider: "codex", count: 2, added: ["gpt-6.2-sol"], removed: [] });

    const sent = up.calls[0]!;
    const url = new URL(sent.url);
    expect(url.origin + url.pathname).toBe("https://chatgpt.com/backend-api/codex/models");
    expect(url.searchParams.get("client_version")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sent.method).toBe("GET");
    expect(sent.headers.get("authorization")).toBe("Bearer at-1");
    expect(sent.headers.get("chatgpt-account-id")).toBe("acc_1");

    const m = await models("codex");
    expect(m.sync).toMatchObject({ supported: true, synced_at: expect.any(Number), error: null });
    const added = m.models.find((x: { id: string }) => x.id === "gpt-6.2-sol");
    expect(added).toMatchObject({ name: "GPT-6.2-Sol", synced: true, new: true, context: 500000, custom: false, disabled: false });
    expect(added.thinking).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    // Already in the catalog: listed once, not new.
    const known = m.models.filter((x: { id: string }) => x.id === "gpt-6-sol");
    expect(known).toHaveLength(1);
    expect(known[0].new).toBeFalsy();
    expect(m.models.some((x: { id: string }) => x.id === "internal-only")).toBe(false);
  });

  it("goes through the Codex relay when one is set, with only client_version in the query", async () => {
    await codexConnection();
    const up = fakeUpstream(() => json(CODEX_MODELS));
    const r = await adminCall(up, "POST", "/providers/codex/models/sync", undefined, { CODEX_RELAY_URL: "https://relay.test/", CODEX_RELAY_SECRET: "test-relay-secret-test-relay-secret" });
    expect(r.res.status, r.text).toBe(200);
    const url = new URL(up.calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://relay.test/codex/models");
    expect([...url.searchParams.keys()]).toEqual(["client_version"]);
    expect(up.calls[0]!.headers.get("x-relay-secret")).toBe("test-relay-secret-test-relay-secret");
  });

  it("drops a model the provider no longer lists", async () => {
    await codexConnection();
    await adminCall(fakeUpstream(() => json(CODEX_MODELS)), "POST", "/providers/codex/models/sync");
    const r = await adminCall(fakeUpstream(() => json({ models: [CODEX_MODELS.models[1]] })), "POST", "/providers/codex/models/sync");
    expect(JSON.parse(r.text)).toMatchObject({ count: 1, added: [], removed: ["gpt-6.2-sol"] });
    expect((await models("codex")).models.some((x: { id: string }) => x.id === "gpt-6.2-sol")).toBe(false);
  });

  it("keeps the last list and records the error when the provider refuses", async () => {
    await codexConnection();
    await adminCall(fakeUpstream(() => json(CODEX_MODELS)), "POST", "/providers/codex/models/sync");
    const r = await adminCall(fakeUpstream(() => json({ error: { message: "nope" } }, 500)), "POST", "/providers/codex/models/sync");
    expect(r.res.status).toBe(502);
    const m = await models("codex");
    expect(m.sync.error).toContain("500");
    expect(m.models.some((x: { id: string }) => x.id === "gpt-6.2-sol")).toBe(true);
  });

  it("without a connection: 409 naming what is missing", async () => {
    const r = await adminCall(fakeUpstream(() => json(CODEX_MODELS)), "POST", "/providers/codex/models/sync");
    expect(r.res.status).toBe(409);
    expect(r.text).toContain("connection");
  });
});

describe("model sync: OpenAI-format providers", () => {
  it("reads {baseUrl}/models with the connection's key", async () => {
    const c = await adminCall(fakeUpstream(() => json({})), "POST", "/connections", { provider: "groq", name: "main", api_key: "gsk_test_000011112222" });
    expect(c.res.status, c.text).toBe(201);
    const up = fakeUpstream(() => json({ object: "list", data: [{ id: "llama-5-70b", object: "model", context_window: 131072 }] }));
    const r = await adminCall(up, "POST", "/providers/groq/models/sync");
    expect(r.res.status, r.text).toBe(200);
    expect(new URL(up.calls[0]!.url).pathname).toMatch(/\/models$/);
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer gsk_test_000011112222");
    const m = await models("groq");
    expect(m.models.find((x: { id: string }) => x.id === "llama-5-70b")).toMatchObject({ synced: true, new: true, context: 131072 });
  });

  it("a provider with no model list to read: 400 and sync not supported", async () => {
    expect((await models("anthropic")).sync.supported).toBe(false);
    const r = await adminCall(fakeUpstream(() => json({})), "POST", "/providers/anthropic/models/sync");
    expect(r.res.status).toBe(400);
  });
});

describe("model sync: GitHub Copilot", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const chatModel = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id.toUpperCase(),
    object: "model",
    capabilities: { type: "chat", family: id, limits: { max_context_window_tokens: 128000 } },
    ...extra,
  });
  // The shape of api.githubcopilot.com/models, as a free plan sees it: most models off by policy.
  const COPILOT_MODELS = {
    data: [
      chatModel("gpt-4.1", { policy: { state: "enabled" } }),
      chatModel("gpt-4o"),
      chatModel("claude-haiku-4.5", { policy: { state: "enabled" }, supported_endpoints: ["/chat/completions", "/v1/messages"] }),
      chatModel("claude-opus-5.5", { policy: { state: "disabled" }, supported_endpoints: ["/v1/messages", "/chat/completions"] }),
      chatModel("gpt-6-luna", { policy: { state: "enabled" }, supported_endpoints: ["/responses", "ws:/responses"] }),
      { id: "text-embedding-3-small", object: "model", capabilities: { type: "embeddings" } },
    ],
  };

  /** GitHub's sign-in, then Copilot's model list. */
  function copilot(list: () => Response = () => json(COPILOT_MODELS)): FakeUpstream {
    return fakeUpstream((req) => {
      if (req.url === "https://github.com/login/device/code") return json({ device_code: "fake-device", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      if (req.url === "https://github.com/login/oauth/access_token") return json({ access_token: "fake-gh-at-1", token_type: "bearer" });
      if (req.url === "https://api.github.com/copilot_internal/v2/token") return json({ token: "fake-copilot-1", expires_at: now() + 1500 });
      if (req.url === "https://api.github.com/user") return json({ id: 42, login: "octo" });
      if (req.url === "https://api.githubcopilot.com/models") return list();
      return json({ message: "unexpected" }, 404);
    });
  }
  async function signIn(): Promise<void> {
    const up = copilot();
    const d = JSON.parse((await adminCall(up, "POST", "/oauth/github/start")).text) as { id: string };
    const r = await adminCall(up, "POST", "/oauth/github/poll", { id: d.id });
    expect(r.res.status, r.text).toBe(201);
  }

  it("reads Copilot's /models with the Copilot token, keeping the chat models the account may call", async () => {
    await signIn();
    expect((await models("github")).sync.supported).toBe(true);
    const up = copilot();
    const r = await adminCall(up, "POST", "/providers/github/models/sync");
    expect(r.res.status, r.text).toBe(200);
    const call = up.calls.find((c) => c.url === "https://api.githubcopilot.com/models")!;
    expect(call.headers.get("authorization")).toBe("Bearer fake-copilot-1");
    expect(call.headers.get("copilot-integration-id")).toBe("vscode-chat");
    const synced = (await models("github")).models.filter((m: { synced?: boolean }) => m.synced);
    expect(synced.map((m: { id: string }) => m.id).sort()).toEqual(["claude-haiku-4.5", "gpt-4.1", "gpt-4o"]);
    expect(synced.find((m: { id: string }) => m.id === "gpt-4.1")).toMatchObject({ name: "GPT-4.1", context: 128000, new: true });
  });

  it("without a GitHub sign-in: 409", async () => {
    const r = await adminCall(copilot(), "POST", "/providers/github/models/sync");
    expect(r.res.status).toBe(409);
  });

  it("keeps the last list when Copilot refuses", async () => {
    await signIn();
    await adminCall(copilot(), "POST", "/providers/github/models/sync");
    const r = await adminCall(copilot(() => json({ error: { message: "nope" } }, 500)), "POST", "/providers/github/models/sync");
    expect(r.res.status).toBe(502);
    const m = await models("github");
    expect(m.sync.error).toContain("500");
    expect(m.models.filter((x: { synced?: boolean }) => x.synced)).toHaveLength(3);
  });
});

describe("synced models elsewhere", () => {
  it("/v1/models lists them for a system allowed the provider", async () => {
    await codexConnection();
    await adminCall(fakeUpstream(() => json(CODEX_MODELS)), "POST", "/providers/codex/models/sync");
    const token = await addSystem("app");
    await env.DB.prepare("UPDATE system SET allowed_models = ? WHERE id = ?").bind(JSON.stringify(["codex/*"]), "app").run();
    const { text } = await call(fakeUpstream(() => json({})), "/v1/models", { headers: { authorization: `Bearer ${token}` } });
    const ids = (JSON.parse(text).data as { id: string }[]).map((x) => x.id);
    expect(ids).toContain("cx/gpt-6.2-sol");
  });

  it("the (ultra) suffix is a thinking level", () => {
    expect(stripMarkers("codex/gpt-6.2-sol(ultra)")).toEqual({ model: "codex/gpt-6.2-sol", thinking: { mode: "level", level: "ultra" } });
  });
});
