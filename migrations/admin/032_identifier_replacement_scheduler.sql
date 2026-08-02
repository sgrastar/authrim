CREATE TABLE IF NOT EXISTS identifier_replacement_scheduler_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  after_shard_id TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  last_started_at INTEGER,
  last_completed_at INTEGER,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL
);

INSERT INTO identifier_replacement_scheduler_state (
  singleton_id, after_shard_id, fencing_token, updated_at
)
SELECT 1, NULL, 0, 0
WHERE NOT EXISTS (
  SELECT 1 FROM identifier_replacement_scheduler_state WHERE singleton_id = 1
);
