-- The console's Logs page: one line per request to /v1, /openai or /anthropic. Kept short: the last 500 lines,
-- at most 15 minutes old (worker/logs.ts). No key, token or message text; `message` is the gateway's own error.
CREATE TABLE log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,          -- milliseconds
  level     TEXT NOT NULL,             -- info, warn, error
  method    TEXT NOT NULL,
  path      TEXT NOT NULL,
  status    INTEGER NOT NULL,
  took_ms   INTEGER NOT NULL,
  system_id TEXT,
  model     TEXT,
  message   TEXT
);
CREATE INDEX log_at ON log(at);

-- Relay pools: Codex relays (relay/) a Codex connection sends through instead of CODEX_RELAY_URL.
-- `relays` is a JSON list of base URLs; `secret` is the relays' shared secret, sealed like a connection's key.
CREATE TABLE proxy_pool (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  relays     TEXT NOT NULL,
  secret     TEXT NOT NULL,
  hint       TEXT NOT NULL,
  last_check TEXT,                     -- JSON: [{url, ok, ms}] from the last health check
  checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE connection ADD COLUMN proxy_pool TEXT;

-- Keys for web search and fetch providers (worker/web-tools.ts), sealed like a connection's key.
CREATE TABLE web_tool (
  id         TEXT PRIMARY KEY,
  secret     TEXT NOT NULL,
  hint       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
