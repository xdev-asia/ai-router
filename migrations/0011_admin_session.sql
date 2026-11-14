-- Console sessions opened with the admin token (POST /auth/token), so a reload keeps the console signed in.
-- NULL: an xDev ID session. Otherwise SHA-256 of ADMIN_TOKEN_SHA256 at sign-in: a new or removed admin
-- token ends these sessions. email and name stay empty on these rows.
ALTER TABLE console_session ADD COLUMN admin_key TEXT;
