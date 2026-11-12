-- A subscription login in progress: the PKCE verifier waits here until the provider sends the browser back with
-- a code. Rows older than 10 minutes are ignored and removed.
CREATE TABLE oauth_pending (
  state      TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- The account a connection signed in as (the provider's account id). Not a secret; signing in again with the
-- same account replaces that connection's tokens instead of adding a second one. NULL for API keys.
ALTER TABLE connection ADD COLUMN account TEXT;
