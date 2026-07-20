-- Bind each Admin Agent login-handoff child session to the one tenant issuer that consumed it.
-- The child retains its central root session tenant_id for parent/user validation; this separate
-- target prevents a copied child credential from being replayed against another tenant issuer.
ALTER TABLE admin_sessions ADD COLUMN derived_target_tenant_id TEXT;

CREATE INDEX IF NOT EXISTS idx_admin_sessions_derived_target
  ON admin_sessions(derived_target_tenant_id, expires_at);
