-- Add protocol-neutral attribute release consent records for SAML/OIDC destinations.
-- The table stores release decisions by destination and attribute/claim-set hash.
-- Raw attribute values are intentionally not stored.

CREATE TABLE IF NOT EXISTS attribute_release_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  account_id TEXT,
  destination_type TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  attribute_set_hash TEXT NOT NULL,
  consent_mode TEXT NOT NULL,
  consent_state TEXT NOT NULL DEFAULT 'granted',
  consent_record_id TEXT,
  first_granted_at INTEGER,
  last_confirmed_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, subject_id, destination_type, destination_id, attribute_set_hash)
);

CREATE INDEX IF NOT EXISTS idx_attribute_release_consents_destination
  ON attribute_release_consents(tenant_id, destination_type, destination_id, consent_state);
