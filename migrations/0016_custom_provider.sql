-- Providers the owner adds in the console ("Custom Providers"): an OpenAI-compatible (Chat Completions at
-- `base_url` + /chat/completions) or Anthropic-compatible (Messages at `base_url` + /v1/messages) endpoint. They
-- take API-key connections like a built-in provider. `id` never names a built-in provider or its short alias
-- (worker/custom-providers.ts). No key here: keys live on their connections.
CREATE TABLE custom_provider (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  format     TEXT NOT NULL,          -- openai, anthropic
  base_url   TEXT NOT NULL,          -- https, no trailing slash
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
