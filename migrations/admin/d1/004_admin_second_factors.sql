-- Second factors an admin registered for step-up (L2), kept apart from the sign-in passkeys in
-- admin_passkeys. A credential is never in both tables. Revoked rows stay for the audit trail and
-- are never reactivated.
CREATE TABLE admin_second_factors (
  id TEXT PRIMARY KEY NOT NULL,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  -- webauthn_credential | keyring_holder_key
  kind TEXT NOT NULL,
  -- WebAuthn: base64url credential ID
  credential_id TEXT UNIQUE,
  -- Keyring: JWK thumbprint of the holder key
  holder_jkt TEXT UNIQUE,
  -- WebAuthn: COSE public key (base64)
  public_key TEXT,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT,
  aaguid TEXT,
  -- WebAuthn authenticator data flags at registration (BE, BS)
  backup_eligible INTEGER,
  backup_state INTEGER,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX idx_admin_second_factors_user ON admin_second_factors(admin_user_id, revoked_at);

-- One credential, one role: whichever path inserts it, a credential ID already registered in the
-- other table aborts the statement (and the batch it belongs to).
CREATE TRIGGER trg_admin_second_factors_not_passkey
BEFORE INSERT ON admin_second_factors
WHEN NEW.credential_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM admin_passkeys WHERE credential_id = NEW.credential_id)
BEGIN
  SELECT RAISE(ABORT, 'credential is registered as an admin passkey');
END;

CREATE TRIGGER trg_admin_passkeys_not_second_factor
BEFORE INSERT ON admin_passkeys
WHEN EXISTS (SELECT 1 FROM admin_second_factors WHERE credential_id = NEW.credential_id)
BEGIN
  SELECT RAISE(ABORT, 'credential is registered as an admin second factor');
END;

-- The second factor an Admin session last verified, and when. Written only by the second-factor
-- verification path; cleared when that factor is revoked.
ALTER TABLE admin_sessions ADD COLUMN second_factor_id TEXT;
ALTER TABLE admin_sessions ADD COLUMN second_factor_verified_at INTEGER;

-- Start of the one-time window in which an admin may register a first second factor with a fresh
-- passkey alone. NULL means the account's created_at. Accounts that exist now start their window
-- at this migration, so none are already past it.
ALTER TABLE admin_users ADD COLUMN second_factor_grace_started_at INTEGER;
UPDATE admin_users
  SET second_factor_grace_started_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
