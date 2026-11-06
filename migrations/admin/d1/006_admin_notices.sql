-- Notices shown in the admin console's header: raised by the system (operational events and the
-- like) or written by an admin as an announcement. Each is addressed to one audience: the
-- platform's admins, a tenant's admins, the admins who can read a client, or one admin.
CREATE TABLE admin_notices (
  id TEXT PRIMARY KEY NOT NULL,
  -- platform | tenant | client | admin_user
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant', 'client', 'admin_user')),
  -- NULL only for platform; for admin_user the addressee's home tenant
  tenant_id TEXT,
  client_id TEXT,
  admin_user_id TEXT REFERENCES admin_users(id) ON DELETE CASCADE,
  -- critical | high | caution | info
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'caution', 'info')),
  -- system | announcement
  source TEXT NOT NULL CHECK (source IN ('system', 'announcement')),
  category TEXT NOT NULL,
  -- System notices: the console's message for them and its parameters
  message_key TEXT,
  params_json TEXT,
  -- The announcement's text, or the English fallback of a system notice
  title TEXT NOT NULL,
  body TEXT,
  -- A console path under /admin/
  link TEXT,
  -- The viewer must also hold this permission
  required_permission TEXT,
  -- What raised it, e.g. the internal_notification_events row
  source_ref TEXT,
  deduplication_key TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  resolved_at INTEGER,
  -- 'system' or the admin who resolved it
  resolved_by TEXT,
  CHECK (
    (scope_type = 'platform' AND tenant_id IS NULL AND client_id IS NULL AND admin_user_id IS NULL)
    OR (scope_type = 'tenant' AND tenant_id IS NOT NULL AND client_id IS NULL AND admin_user_id IS NULL)
    OR (scope_type = 'client' AND tenant_id IS NOT NULL AND client_id IS NOT NULL AND admin_user_id IS NULL)
    OR (scope_type = 'admin_user' AND tenant_id IS NOT NULL AND client_id IS NULL AND admin_user_id IS NOT NULL)
  )
);

-- One open notice per deduplication key; a resolved one may be raised again.
CREATE UNIQUE INDEX idx_admin_notices_open_dedup
  ON admin_notices(deduplication_key) WHERE deduplication_key IS NOT NULL AND resolved_at IS NULL;
CREATE INDEX idx_admin_notices_tenant_open ON admin_notices(tenant_id, resolved_at, created_at);
CREATE INDEX idx_admin_notices_admin_open ON admin_notices(admin_user_id, resolved_at);
CREATE INDEX idx_admin_notices_scope_open ON admin_notices(scope_type, resolved_at, created_at);
CREATE INDEX idx_admin_notices_source_ref ON admin_notices(source_ref);

-- Information an admin has put away for themselves.
CREATE TABLE admin_notice_dismissals (
  notice_id TEXT NOT NULL REFERENCES admin_notices(id) ON DELETE CASCADE,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (notice_id, admin_user_id)
);
CREATE INDEX idx_admin_notice_dismissals_admin ON admin_notice_dismissals(admin_user_id);
