-- How a provider's connections are picked: 'fill-first' (priority order, the default when there is no row)
-- or 'round-robin' (the one used longest ago first).
CREATE TABLE provider_setting (
  provider TEXT PRIMARY KEY,
  strategy TEXT NOT NULL
);

-- When the connection last answered a request, in milliseconds: what round robin sorts by.
ALTER TABLE connection ADD COLUMN rr_at INTEGER NOT NULL DEFAULT 0;
