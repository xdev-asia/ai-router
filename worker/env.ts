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
}

/** `startedAt`: when the request reached the gateway (ms), for the latency of its usage rows. */
export type AppEnv = { Bindings: Env; Variables: { startedAt: number } };
