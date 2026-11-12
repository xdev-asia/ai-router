-- Provider accounts managed from the console: several per provider, tried in `priority` order.
-- `secret` is the credential as JSON ({"api_key": ...} or OAuth tokens), sealed with AES-256-GCM under the
-- CONNECTIONS_KEY secret (worker/secret-box.ts). `hint` is the last 4 characters of an API key, to tell keys apart.
CREATE TABLE connection (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  -- 'api_key' or 'oauth'
  auth_type      TEXT NOT NULL,
  name           TEXT NOT NULL,
  secret         TEXT NOT NULL,
  hint           TEXT,
  -- OAuth access token expiry, unix seconds. NULL for API keys.
  expires_at     INTEGER,
  -- Lower first, within a provider.
  priority       INTEGER NOT NULL,
  disabled       INTEGER NOT NULL DEFAULT 0,
  -- Set aside until this time (unix seconds) after a 429, a 5xx or a refused key; 0 when available.
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  -- Consecutive failures, for the growing cooldown. Back to 0 on a success.
  backoff_level  INTEGER NOT NULL DEFAULT 0,
  -- "<status> <provider message>" of the last failure. Never a key or request content.
  last_error     TEXT,
  last_error_at  INTEGER,
  last_used_at   INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX connection_provider ON connection(provider, priority);
