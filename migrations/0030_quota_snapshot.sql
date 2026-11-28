-- The last quota answer of an account whose provider only reports its limits on a real request (Groq: the
-- rate-limit headers of a chat answer). Kept so the quota page does not spend a request on every look.
-- `report` is the QuotaReport as JSON (worker/quota.ts): no key or token.
CREATE TABLE quota_snapshot (
  connection TEXT PRIMARY KEY,
  report     TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);
