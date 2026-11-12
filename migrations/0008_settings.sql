-- Gateway-wide settings, one JSON value per key. "token_saver": the savers every system gets (worker/settings.ts).
CREATE TABLE setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
