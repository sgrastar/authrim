CREATE TABLE IF NOT EXISTS profile_registry (
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('storage', 'audit', 'residency')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, id)
);
