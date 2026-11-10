export interface Env {
  DB: D1Database;
  /** Public: Anthropic API base URL, no trailing path (`https://api.anthropic.com`). */
  ANTHROPIC_BASE_URL: string;
  /** Secret: JSON object, system id -> that system's Anthropic API key. A system missing here gets `not_configured`. */
  ANTHROPIC_KEYS?: string;
  /** Secret: SHA-256 hex of the admin bearer token. Unset disables /admin. */
  ADMIN_TOKEN_SHA256?: string;
}

export type AppEnv = { Bindings: Env };
