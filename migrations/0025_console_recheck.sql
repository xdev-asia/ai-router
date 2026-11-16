-- Sessions xDev ID granted ('id') check the role again every 5 minutes, so taking it back at
-- xDev ID ends them. idp_token: xDev ID's access token, sealed with CONNECTIONS_KEY (secret-box.ts); NULL on
-- other sessions. checked_at: when xDev ID last confirmed the role. An 'id' session without either ends at
-- the next check.
ALTER TABLE console_session ADD COLUMN idp_token TEXT;
ALTER TABLE console_session ADD COLUMN checked_at INTEGER;
