-- Milliseconds from the request reaching the gateway to its last byte from the provider. NULL on rows from before.
ALTER TABLE usage ADD COLUMN latency_ms INTEGER;
CREATE INDEX usage_at ON usage(at);

-- Prices for the cost estimate on the Usage page, in US dollars per million tokens. `target` is "provider/model";
-- it also prices every model whose name starts with it ("openai/gpt-5" prices "gpt-5-2026"), the longest match first.
CREATE TABLE price (
  target      TEXT PRIMARY KEY,
  input       REAL NOT NULL,
  output      REAL NOT NULL,
  cache_read  REAL NOT NULL DEFAULT 0,
  cache_write REAL NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
