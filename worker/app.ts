import { Hono } from "hono";
import { adminRoutes } from "./admin";
import { consoleAuthRoutes, type Idp } from "./console-auth";
import type { AppEnv } from "./env";
import { anthropicError } from "./errors";
import { openaiRoutes } from "./openai";
import { anthropicRoutes, type Upstream } from "./proxy";

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
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/auth", consoleAuthRoutes(deps.idp ?? ((req) => fetch(req))));
  app.route("/admin", adminRoutes());
  app.route("/anthropic", anthropicRoutes(deps.upstream));
  app.route("/openai", openaiRoutes(deps.upstream));
  app.notFound((c) => anthropicError(c, 404, "not_found_error", "not found"));
  return app;
}
