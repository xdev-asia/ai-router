-- What a provider last said about an account's rate limits, read from the headers of its answers to real requests
-- (worker/limits.ts). One row per account and model: providers count limits per model. Used to set an account
-- that is out aside until its reset, and for the "quota-left" order. No key, token or request content.
CREATE TABLE connection_limit (
  connection         TEXT NOT NULL,
  model              TEXT NOT NULL,
  requests_limit     INTEGER,
  requests_remaining INTEGER,
  -- Unix seconds; NULL when the provider gave no reset time.
  requests_reset_at  INTEGER,
  tokens_limit       INTEGER,
  tokens_remaining   INTEGER,
  tokens_reset_at    INTEGER,
  seen_at            INTEGER NOT NULL,
  PRIMARY KEY (connection, model)
);
