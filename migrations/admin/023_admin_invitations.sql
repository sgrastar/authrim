-- Admin invitation bootstrap flow (DB_ADMIN).
-- Invitation codes are stored only as SHA-256 hashes and can authorize Passkey enrollment,
-- never an Admin session by themselves.

CREATE TABLE IF NOT EXISTS admin_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  admin_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  pending_email_key TEXT,
  name TEXT,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_role_id TEXT NOT NULL,
  admin_role_name TEXT NOT NULL,
  admin_role_display_name TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  role_expires_at INTEGER,
  ip_restriction_enabled INTEGER NOT NULL DEFAULT 0,
  allowed_ip_ranges_json TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL,
  last_delivery_status TEXT NOT NULL DEFAULT 'pending',
  last_delivery_error TEXT,
  accepted_at INTEGER,
  accepted_ip TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(admin_user_id),
  UNIQUE(tenant_id, pending_email_key),
  CHECK(status IN ('pending', 'accepted', 'revoked', 'expired')),
  CHECK(
    (status = 'pending' AND pending_email_key = email)
    OR (status IN ('accepted', 'revoked', 'expired') AND pending_email_key IS NULL)
  ),
  CHECK(last_delivery_status IN ('pending', 'sent', 'failed')),
  CHECK(scope_type IN ('global', 'tenant')),
  CHECK(ip_restriction_enabled IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_admin_invitations_tenant_status
  ON admin_invitations(tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_invitations_code_hash
  ON admin_invitations(code_hash, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_admin_invitations_email
  ON admin_invitations(tenant_id, email, status);

-- Short-lived Passkey enrollment state must be strongly consistent. Store only a hash of
-- the bearer token so a database read cannot disclose an active enrollment capability.
CREATE TABLE IF NOT EXISTS admin_invitation_enrollments (
  token_hash TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  state_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(phase IN ('redeemed', 'registration', 'authentication'))
);

CREATE INDEX IF NOT EXISTS idx_admin_invitation_enrollments_expiry
  ON admin_invitation_enrollments(expires_at);

CREATE INDEX IF NOT EXISTS idx_admin_invitation_enrollments_invitation
  ON admin_invitation_enrollments(invitation_id, expires_at);
