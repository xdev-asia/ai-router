import type { Context } from "hono";
import type { AppEnv } from "./env";

export type AnthropicErrorType =
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error";

/**
 * An error in the Anthropic API shape, so the SDK in each calling system raises its usual typed error.
 * `noRetry` sets `x-should-retry: false`, which the official SDKs read before their own retry rule
 * (otherwise they retry 429 and 5xx).
 */
export function anthropicError(c: Context<AppEnv>, status: 401 | 403 | 404 | 429 | 500, type: AnthropicErrorType, message: string, noRetry = false): Response {
  if (noRetry) c.header("x-should-retry", "false");
  return c.json({ type: "error", error: { type, message } }, status);
}

/**
 * A provider's error body as an object. Google's OpenAI-compatible endpoint wraps it in a one-item array
 * (`[{"error": {...}}]`), so a list gives its first item. Null for anything else.
 */
export function errorBody(body: unknown): Record<string, unknown> | null {
  const b = Array.isArray(body) ? body[0] : body;
  return typeof b === "object" && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}
