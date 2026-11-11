-- Console sign-in with xDev ID (OpenID Connect). Only hashes of the state and the session token are stored.

-- One row per sign-in in progress; removed when the callback uses it. Expired rows are removed on the next sign-in.
CREATE TABLE console_login (
  state_sha256 TEXT PRIMARY KEY,
  verifier     TEXT NOT NULL,
  nonce        TEXT NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE console_session (
  token_sha256 TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
