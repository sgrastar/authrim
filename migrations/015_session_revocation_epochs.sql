-- Migration: 015_session_revocation_epochs
-- Persist per-user session revocation epochs so user-wide revocation survives
-- Durable Object cache misses, shard routing failures, and cold persistence fallback.

CREATE TABLE IF NOT EXISTS session_revocation_epochs (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  revoked_after_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_revocation_epochs_user
  ON session_revocation_epochs(tenant_id, user_id);
