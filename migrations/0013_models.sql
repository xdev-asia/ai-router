-- Models (the Available Models card and model aliases). Provider Thinking modes live in `setting`
-- under "provider_thinking" ({"<provider>": "<mode>"}).

-- A short name for a model: a bare `model` in a request that is not a combo is looked up here (FR-MDL-04).
CREATE TABLE model_alias (
  alias      TEXT PRIMARY KEY,
  -- `<provider or prefix>/<model>`, possibly with a `(level)` suffix.
  model      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Models the owner turned off: refused in requests, left out of combos and of /v1/models (FR-MDL-05).
CREATE TABLE model_disabled (
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);

-- Models the owner added to a provider's list (FR-MDL-09).
CREATE TABLE model_custom (
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  name       TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);
