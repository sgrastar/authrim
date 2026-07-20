-- Phase 2D: one-time, browser-bound Admin session handoff from the central Admin UI
-- to the tenant issuer that owns an Admin Agent OAuth authorization request.
--
-- Raw handoff codes and browser-binding secrets are never stored. The source Admin
-- session ID is retained only while the handoff is issued and is cleared atomically
-- when the target tenant consumes it.

-- A target issuer receives a distinct child session credential. Authentication of a
-- child session always revalidates this parent, so central logout/revocation propagates.
ALTER TABLE admin_sessions ADD COLUMN parent_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_admin_sessions_parent
  ON admin_sessions(parent_session_id, expires_at);

CREATE TABLE IF NOT EXISTS admin_agent_login_handoffs (
  id TEXT PRIMARY KEY,
  target_tenant_id TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  authorization_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'issued', 'consumed')),
  browser_binding_hash TEXT NOT NULL,
  source_session_id TEXT,
  source_session_hash TEXT,
  admin_user_id TEXT,
  code_hash TEXT UNIQUE,
  last_transition_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  issued_at INTEGER,
  consumed_at INTEGER,
  CHECK (target_origin LIKE 'https://%'),
  CHECK (authorization_path LIKE '/oauth/admin-agent/authorize%'),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'pending' AND source_session_id IS NULL AND code_hash IS NULL) OR
    (status = 'issued' AND source_session_id IS NOT NULL AND code_hash IS NOT NULL
      AND issued_at IS NOT NULL) OR
    (status = 'consumed' AND source_session_id IS NULL AND code_hash IS NOT NULL
      AND issued_at IS NOT NULL AND consumed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_admin_agent_login_handoffs_pending
  ON admin_agent_login_handoffs(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_admin_agent_login_handoffs_target
  ON admin_agent_login_handoffs(target_tenant_id, created_at DESC);
