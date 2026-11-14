import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { adminRoutes } from "./admin";
import { consoleAuthRoutes, type Idp } from "./console-auth";
import { withCustomProviders } from "./custom-providers";
import type { AppEnv } from "./env";
import { anthropicError } from "./errors";
import { geminiRoutes } from "./gemini";
import { finishLogin, isPendingState } from "./oauth";
import { openaiRoutes } from "./openai";
import { logRequest } from "./logs";
import { anthropicRoutes, type Upstream } from "./proxy";
import { skillRoutes } from "./skills";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The page a provider's sign-in ends on: one sentence, no script, no token. */
function loginPage(r: { ok: true; name: string } | { ok: false; message: string }): string {
  const text = r.ok ? `Signed in as ${escapeHtml(r.name)}. You can close this tab and go back to the console.` : `The sign-in did not finish: ${escapeHtml(r.message)}. Go back to the console and try again.`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>ai-router</title><body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 32rem; padding: 0 1rem; line-height: 1.5"><p>${text}</p></body></html>`;
}

export interface Deps {
  /** Sends a request to the provider. `fetch` in production; a fake in tests. */
  upstream: Upstream;
  /** Sends a request to xDev ID (console sign-in). `fetch` in production; a fake in tests. */
  idp?: Idp;
}

/**
 * LLM gateway. Each calling system keeps using its provider's official SDK and only changes the base URL:
 * `new Anthropic({ apiKey: <gateway token>, baseURL: "https://<host>/anthropic" })`.
 * A provider is a path prefix, so another one can be added beside `/anthropic` without touching it.
 */
export function makeApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("startedAt", Date.now());
    await next();
  });
  // One log line per gateway request (logs.ts): never a body, a key or a token.
  // The logged path is the pathname only, so a Gemini `?key=<token>` never reaches the log.
  for (const path of ["/v1", "/v1/*", "/v1beta/*", "/openai/*", "/anthropic/*"]) app.use(path, logRequest);
  // The owner's providers (custom-providers.ts), read once per request so routing and the console see them.
  for (const path of ["/v1", "/v1/*", "/v1beta/*", "/openai/*", "/anthropic/*", "/admin/*"]) app.use(path, withCustomProviders);
  // No token: compose's healthcheck and the console's new-build check (web/version.ts) read it. The build is a
  // commit of the repository and a time, nothing secret.
  const health = (c: Context<AppEnv>) => c.json({ ok: true, version: c.env.APP_VERSION?.trim() || "dev", built_at: c.env.APP_BUILT_AT?.trim() || null });
  app.get("/health", health);
  app.get("/api/health", health);
  // A provider's sign-in page sends the browser back here (Codex: http://localhost:1455/auth/callback, so only
  // when that port reaches this Worker). Anything that is not one of our pending logins is the console's own
  // sign-in with xDev ID, handled below.
  app.get("/auth/callback", async (c, next) => {
    const state = c.req.query("state");
    if (!state || !(await isPendingState(c.env.DB, state))) return next();
    const code = c.req.query("code");
    const result = code
      ? await finishLogin(c.env, deps.upstream, null, code, state)
      : ({ ok: false, status: 400, error: "provider_refused", message: c.req.query("error_description") ?? c.req.query("error") ?? "the sign-in was not completed" } as const);
    return c.html(loginPage(result.ok ? { ok: true, name: result.name } : { ok: false, message: result.message }), result.ok ? 200 : result.status);
  });
  app.route("/auth", consoleAuthRoutes(deps.idp ?? ((req) => fetch(req))));
  app.route("/admin", adminRoutes(deps.upstream));
  app.route("/skills", skillRoutes());
  const anthropic = anthropicRoutes(deps.upstream);
  const openai = openaiRoutes(deps.upstream);
  app.route("/anthropic", anthropic);
  app.route("/openai", openai);

  // /v1/* with no provider prefix. Same handlers, same gateway token, same metering.
  // Any origin may call them (CORS *); the gateway token is still required.
  // Allowed headers mirror the preflight's: a "*" there would not cover Authorization.
  const v1Cors = cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], maxAge: 86400 });
  app.use("/v1", v1Cors);
  app.use("/v1/*", v1Cors);
  // Gemini API (Gemini CLI: GOOGLE_GEMINI_BASE_URL=https://<host>, the gateway token as GEMINI_API_KEY).
  app.use("/v1beta/*", v1Cors);
  app.route("/v1beta", geminiRoutes(deps.upstream));
  app.all("/v1/v1/*", (c) => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^(\/v1)+\/v1\//, "/v1/");
    return app.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
  });
  app.all("/v1/messages", (c) => anthropic.fetch(c.req.raw, c.env, c.executionCtx));
  app.all("/v1/messages/*", (c) => anthropic.fetch(c.req.raw, c.env, c.executionCtx));
  app.all("/v1", (c) => openai.fetch(c.req.raw, c.env, c.executionCtx));
  app.all("/v1/*", (c) => openai.fetch(c.req.raw, c.env, c.executionCtx));
  app.notFound((c) => anthropicError(c, 404, "not_found_error", "not found"));
  return app;
}
