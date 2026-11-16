-- How a console session was allowed in (FR-SET-23): 'id' (xDev ID gave the user a role for this client) or
-- 'list' (CONSOLE_EMAILS). NULL on sessions opened before this migration: treated as 'list'.
ALTER TABLE console_session ADD COLUMN access TEXT;
-- For 'id' sessions: `issuer client_id` of the client that granted it; the session ends when that changes.
ALTER TABLE console_session ADD COLUMN idp TEXT;
