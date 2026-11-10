import { Hono } from "hono";
import { adminRoutes } from "./admin";
import type { AppEnv } from "./env";
import { anthropicError } from "./errors";
import { anthropicRoutes, type Upstream } from "./proxy";

export interface Deps {
  /** Sends a request to the provider. `fetch` in production; a fake in tests. */
  upstream: Upstream;
}

/**
 * LLM gateway. Each calling system keeps using its provider's official SDK and only changes the base URL:
 * `new Anthropic({ apiKey: <gateway token>, baseURL: "https://<host>/anthropic" })`.
 * A provider is a path prefix, so another one can be added beside `/anthropic` without touching it.
 */
export function makeApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/admin", adminRoutes());
  app.route("/anthropic", anthropicRoutes(deps.upstream));
  app.notFound((c) => anthropicError(c, 404, "not_found_error", "not found"));
  return app;
}
