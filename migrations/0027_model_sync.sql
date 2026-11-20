-- Model sync (model-sync.ts): each provider's own model list, as last fetched, and when. first_seen marks a model
-- as new; a model the provider no longer lists is deleted on the next sync. thinking: JSON array of levels.
CREATE TABLE model_synced (
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  name       TEXT,
  thinking   TEXT,
  context    INTEGER,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);
-- The last sync of each provider: when it last worked, and the last error (kept until the next success).
CREATE TABLE model_sync (
  provider  TEXT PRIMARY KEY,
  synced_at INTEGER,
  error     TEXT,
  error_at  INTEGER
);
