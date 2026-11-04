-- Requests to replace an admin's step-up second factors after losing them. The new credential is
-- registered with the request but only becomes a second factor when the request is completed,
-- after the waiting period, during which the admin and the tenant's other admins can cancel it.
CREATE TABLE admin_second_factor_recoveries (
  id TEXT PRIMARY KEY NOT NULL,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  -- The requester's home tenant: whose admins are notified and may cancel
  tenant_id TEXT NOT NULL,
  -- pending | completed | cancelled | expired
  status TEXT NOT NULL,
  -- The new WebAuthn credential, verified at request time
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT,
  aaguid TEXT,
  label TEXT,
  requested_session_id TEXT NOT NULL,
  -- Set once every notice was handed to delivery; a request without it can never be completed
  notified_at INTEGER,
  requested_at INTEGER NOT NULL,
  -- Earliest completion time (requested_at + waiting period)
  not_before INTEGER NOT NULL,
  -- After this a pending request can no longer be completed
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  -- requester | admin | notification_failed
  cancel_reason TEXT
);

-- One pending request per admin.
CREATE UNIQUE INDEX idx_admin_second_factor_recoveries_pending
  ON admin_second_factor_recoveries(admin_user_id) WHERE status = 'pending';
CREATE INDEX idx_admin_second_factor_recoveries_tenant
  ON admin_second_factor_recoveries(tenant_id, status);
