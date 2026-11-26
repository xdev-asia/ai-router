-- Video jobs made through POST /v1/videos (worker/media.ts): which provider and account made each one and for which
-- system, so GET /v1/videos/<id> and its content go to that account. The id is the provider's. Kept 7 days.
CREATE TABLE video_job (
  id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (system_id, id)
);
CREATE INDEX video_job_created ON video_job (created_at);
