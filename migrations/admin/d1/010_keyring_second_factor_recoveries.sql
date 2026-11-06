-- A recovery request can name a Keyring holder key as the new second factor, not only a WebAuthn
-- credential. SQLite cannot relax NOT NULL in place, so the table is rebuilt: the WebAuthn columns
-- become nullable, `kind` says which of the two the request carries, and a CHECK keeps each kind's
-- columns complete. Existing requests are WebAuthn ones and keep every value.
CREATE TABLE admin_second_factor_recoveries_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  -- The requester's home tenant: whose admins are notified and may cancel
  tenant_id TEXT NOT NULL,
  -- pending | completed | cancelled | expired
  status TEXT NOT NULL,
  -- webauthn_credential | keyring_holder_key
  kind TEXT NOT NULL DEFAULT 'webauthn_credential',
  -- WebAuthn: the new credential, verified at request time
  credential_id TEXT,
  public_key TEXT,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT,
  aaguid TEXT,
  label TEXT,
  -- Keyring: JWK thumbprint of the holder key, and the admin credential it was presented with
  -- (checked again when the request is completed)
  holder_jkt TEXT,
  admin_credential_id TEXT,
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
  cancel_reason TEXT,
  CHECK (
    (kind = 'webauthn_credential' AND credential_id IS NOT NULL AND public_key IS NOT NULL
      AND holder_jkt IS NULL AND admin_credential_id IS NULL)
    OR (kind = 'keyring_holder_key' AND holder_jkt IS NOT NULL AND admin_credential_id IS NOT NULL
      AND credential_id IS NULL AND public_key IS NULL)
  )
);

INSERT INTO admin_second_factor_recoveries_v2 (
  id, admin_user_id, tenant_id, status, kind, credential_id, public_key, counter, transports_json,
  aaguid, label, requested_session_id, notified_at, requested_at, not_before, expires_at,
  completed_at, cancelled_at, cancelled_by, cancel_reason
)
SELECT
  id, admin_user_id, tenant_id, status, 'webauthn_credential', credential_id, public_key, counter,
  transports_json, aaguid, label, requested_session_id, notified_at, requested_at, not_before,
  expires_at, completed_at, cancelled_at, cancelled_by, cancel_reason
FROM admin_second_factor_recoveries;

DROP TABLE admin_second_factor_recoveries;
ALTER TABLE admin_second_factor_recoveries_v2 RENAME TO admin_second_factor_recoveries;

-- One pending request per admin.
CREATE UNIQUE INDEX idx_admin_second_factor_recoveries_pending
  ON admin_second_factor_recoveries(admin_user_id) WHERE status = 'pending';
CREATE INDEX idx_admin_second_factor_recoveries_tenant
  ON admin_second_factor_recoveries(tenant_id, status);
