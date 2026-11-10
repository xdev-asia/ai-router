-- One row per calling system (chat, xdevd, ...). The gateway token is stored only as its SHA-256.
-- The system's Anthropic key is not stored here: it is in the ANTHROPIC_KEYS secret, keyed by system id.
CREATE TABLE system (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  token_sha256      TEXT NOT NULL UNIQUE,
  -- Tokens per calendar month (UTC), counting input, output, cache write and cache read. NULL: no cap.
  monthly_token_cap INTEGER,
  disabled          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

-- One row per forwarded Messages request. No request or response content is kept.
CREATE TABLE usage (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id                   TEXT NOT NULL REFERENCES system(id) ON DELETE CASCADE,
  provider                    TEXT NOT NULL,
  request_id                  TEXT,
  model                       TEXT,
  status                      INTEGER NOT NULL,
  streamed                    INTEGER NOT NULL,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  at                          INTEGER NOT NULL
);
CREATE INDEX usage_system_at ON usage(system_id, at);
