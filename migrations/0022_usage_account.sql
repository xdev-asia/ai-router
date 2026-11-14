-- The provider account (connection) that served each request, for the Usage page's table by account.
-- NULL: a key from the PROVIDER_KEYS / ANTHROPIC_KEYS secrets, a row from before this column, or a media request.
ALTER TABLE usage ADD COLUMN connection_id TEXT;
