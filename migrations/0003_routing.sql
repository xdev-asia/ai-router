-- Models a system may call, as a JSON array of patterns ("anthropic/*", "openai/gpt-5", "combo/fast").
-- NULL keeps the old behaviour: Claude only ("anthropic/*").
ALTER TABLE system ADD COLUMN allowed_models TEXT;

-- Named fallback lists: `combo/<name>` tries `targets` (JSON array of "provider/model") in order.
CREATE TABLE combo (
  name       TEXT PRIMARY KEY,
  targets    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A target ("provider/model") that answered 429 or 5xx is skipped by combos until `until` (unix seconds).
CREATE TABLE cooldown (
  target TEXT PRIMARY KEY,
  until  INTEGER NOT NULL
);
