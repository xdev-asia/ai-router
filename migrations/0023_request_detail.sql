-- Request details (observability): what a client sent and got back, kept only while the owner has it on.
-- Bodies are cut to 5 KB and key-like text is masked before a row is written (worker/request-details.ts).
CREATE TABLE request_detail (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  system_id     TEXT,
  model         TEXT,
  path          TEXT NOT NULL,
  status        INTEGER NOT NULL,
  took_ms       INTEGER NOT NULL,
  ttft_ms       INTEGER,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  request       TEXT,
  response      TEXT,
  thinking      TEXT
);
CREATE INDEX request_detail_at ON request_detail (at);
