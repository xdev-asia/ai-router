-- Tokens for AI clients on /mcp (mcp-tokens.ts). Only the SHA-256 of a token is kept; `hint` is its last 4
-- characters. `scopes`: JSON object, group -> "none" | "read" | "write". expires_at NULL: no expiry.
CREATE TABLE mcp_token (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  hint         TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER
);
