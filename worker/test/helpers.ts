import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { makeApp } from "../app";
import { sha256hex } from "../auth";

export const BASE = "https://llm.test";
export const ADMIN_TOKEN = "test-admin-token";

export interface FakeUpstream {
  calls: Request[];
  bodies: string[];
  reply: (req: Request) => Response | Promise<Response>;
  fn: (req: Request) => Promise<Response>;
}

export function fakeUpstream(reply: FakeUpstream["reply"]): FakeUpstream {
  const u: FakeUpstream = {
    calls: [],
    bodies: [],
    reply,
    fn: async (req) => {
      u.calls.push(req);
      u.bodies.push(await req.clone().text());
      return u.reply(req);
    },
  };
  return u;
}

/** Runs one request through the app and waits for its background work (usage rows) to finish. `envOverride` replaces bindings for this call. */
export async function call(upstream: FakeUpstream, path: string, init?: RequestInit, envOverride?: Record<string, unknown>): Promise<{ res: Response; text: string }> {
  const app = makeApp({ upstream: upstream.fn });
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(BASE + path, init), envOverride ? { ...env, ...envOverride } : env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return { res, text };
}

/** Empties both tables; call in beforeEach so tests do not depend on storage isolation. */
export async function reset(): Promise<void> {
  await env.DB.batch(["usage", "system", "console_login", "console_session", "combo", "cooldown", "connection", "provider_setting", "price", "setting", "oauth_pending", "model_alias", "model_disabled", "model_custom", "log", "proxy_pool", "web_tool", "custom_provider", "request_detail", "mcp_token", "model_synced", "model_sync", "video_job"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

/** Inserts a system and returns its plain gateway token. */
export async function addSystem(id: string, opts: { cap?: number | null; disabled?: boolean } = {}): Promise<string> {
  const token = `xllm_test_${id}_${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO system (id, name, token_sha256, monthly_token_cap, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, id, await sha256hex(token), opts.cap ?? null, opts.disabled ? 1 : 0, Math.floor(Date.now() / 1000))
    .run();
  return token;
}

export function messagesInit(token: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token, "anthropic-version": "2026-10-21", ...headers },
    body: JSON.stringify(body),
  };
}

export function sse(events: unknown[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** A Response whose body arrives in the given chunks, to test parsing across chunk edges. */
export function chunked(chunks: string[], init: ResponseInit): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
  return new Response(stream, init);
}

export async function usageRows(systemId: string): Promise<Record<string, unknown>[]> {
  const r = await env.DB.prepare("SELECT * FROM usage WHERE system_id = ? ORDER BY id").bind(systemId).all();
  return r.results;
}
