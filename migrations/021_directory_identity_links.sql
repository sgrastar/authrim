-- Directory identity links and JIT pending users for Wordwarden directory authentication.

CREATE TABLE IF NOT EXISTS directory_identity_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  directory_subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  latest_facts_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  UNIQUE (tenant_id, connector_id, directory_subject)
);

CREATE INDEX IF NOT EXISTS idx_directory_identity_links_user
  ON directory_identity_links (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS directory_jit_pending_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  directory_subject TEXT NOT NULL,
  login_identifier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'linked')),
  directory_facts_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  decision_reason TEXT,
  linked_user_id TEXT,
  UNIQUE (tenant_id, connector_id, directory_subject)
);

CREATE INDEX IF NOT EXISTS idx_directory_jit_pending_users_status
  ON directory_jit_pending_users (tenant_id, status, updated_at);

