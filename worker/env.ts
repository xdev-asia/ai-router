export interface Env {
  DB: D1Database;
  /** Public: Anthropic API base URL, no trailing path (`https://api.anthropic.com`). */
  ANTHROPIC_BASE_URL: string;
  /** Secret: JSON object, system id -> that system's Anthropic API key. A system missing here gets `not_configured`. */
  ANTHROPIC_KEYS?: string;
  /** Secret: JSON object, provider id -> its API key (`{"openai": "sk-...", "groq": "gsk_..."}`), shared by the systems allowed to use it. */
  PROVIDER_KEYS?: string;
  /** Secret: 32 random bytes, base64. Seals the credentials of the connections stored in D1 (secret-box.ts). Unset: connections cannot be added or used. */
  CONNECTIONS_KEY?: string;
  /** Secret: SHA-256 hex of the admin bearer token. Unset disables the token (the console can still use xDev ID). */
  ADMIN_TOKEN_SHA256?: string;
  /** Public: OpenID issuer of xDev ID (`https://id.xdev.asia/api/auth`). Console sign-in is off while any OIDC value is unset. */
  OIDC_ISSUER?: string;
  /** Public: this gateway's client id at xDev ID. */
  OIDC_CLIENT_ID?: string;
  /** Secret: this gateway's client secret at xDev ID. */
  OIDC_CLIENT_SECRET?: string;
  /** Public: comma-separated emails (verified at xDev ID) allowed into the console. */
  CONSOLE_EMAILS?: string;
  /**
   * Public: base URL of the Codex relay (`relay/`). chatgpt.com refuses every request carrying the Cf-Worker
   * header, which a Worker cannot leave out, so Codex requests go through this relay when it is set.
   */
  CODEX_RELAY_URL?: string;
  /** Secret: the shared secret the Codex relay checks (its RELAY_SECRET). Required when CODEX_RELAY_URL is set. */
  CODEX_RELAY_SECRET?: string;
  /**
   * Public and secret: the Google OAuth client Gemini CLI signs in with (oauth.ts). Either unset: the Gemini CLI
   * provider shows as unavailable. Never kept in the code.
   */
  GOOGLE_GEMINI_CLI_CLIENT_ID?: string;
  GOOGLE_GEMINI_CLI_CLIENT_SECRET?: string;
  /** Public and secret: the Google OAuth client Antigravity signs in with. Either unset: the Antigravity provider shows as unavailable. */
  /** The Codex CLI version the Codex model list is asked for (model-sync.ts); a default is built in. */
  CODEX_CLIENT_VERSION?: string;
  GOOGLE_ANTIGRAVITY_CLIENT_ID?: string;
  GOOGLE_ANTIGRAVITY_CLIENT_SECRET?: string;
  /** Public: the commit this gateway was built from, set by the Docker image (CI). Unset: a local build, `dev`. */
  APP_VERSION?: string;
  /** Public: when that image was built (ISO 8601). */
  APP_BUILT_AT?: string;
}

/**
 * `startedAt`: when the request reached the gateway (ms), for the latency of its usage rows.
 * `connection`: the provider account being tried (its id only), for the usage row's account; unset for a secret-file key.
 */
export type AppEnv = { Bindings: Env; Variables: { startedAt: number; connection?: string | null } };
