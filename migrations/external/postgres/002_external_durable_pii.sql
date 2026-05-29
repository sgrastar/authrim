-- Authrim external durable PII schema for PostgreSQL.
-- This schema is shared by tenant and keeps every durable table explicitly
-- tenant-scoped for external-durable deployments.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at BIGINT NOT NULL,
  checksum TEXT NOT NULL,
  execution_time_ms INTEGER,
  rollback_sql TEXT
);

CREATE TABLE IF NOT EXISTS users_pii (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  pii_class TEXT NOT NULL DEFAULT 'PROFILE',
  email TEXT NOT NULL,
  email_blind_index TEXT,
  phone_number TEXT,
  name TEXT,
  given_name TEXT,
  family_name TEXT,
  middle_name TEXT,
  nickname TEXT,
  preferred_username TEXT,
  profile TEXT,
  picture TEXT,
  website TEXT,
  gender TEXT,
  birthdate TEXT,
  locale TEXT,
  zoneinfo TEXT,
  address_formatted TEXT,
  address_street_address TEXT,
  address_locality TEXT,
  address_region TEXT,
  address_postal_code TEXT,
  address_country TEXT,
  declared_residence TEXT,
  custom_attributes_json JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pii_email
  ON users_pii(tenant_id, email_blind_index);
CREATE INDEX IF NOT EXISTS idx_users_pii_tenant
  ON users_pii(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_pii_class
  ON users_pii(tenant_id, pii_class);
CREATE INDEX IF NOT EXISTS idx_users_pii_residence
  ON users_pii(tenant_id, declared_residence);

CREATE TABLE IF NOT EXISTS subject_identifiers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  sector_identifier TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  CONSTRAINT subject_identifiers_unique_sector UNIQUE(tenant_id, user_id, sector_identifier)
);

CREATE INDEX IF NOT EXISTS idx_subject_identifiers_subject
  ON subject_identifiers(tenant_id, subject);
CREATE INDEX IF NOT EXISTS idx_subject_identifiers_client
  ON subject_identifiers(tenant_id, client_id);

CREATE TABLE IF NOT EXISTS linked_identities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  provider_name TEXT,
  raw_attributes JSONB,
  linked_at BIGINT NOT NULL,
  last_used_at BIGINT,
  CONSTRAINT linked_identities_unique_provider UNIQUE(tenant_id, provider_id, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_linked_identities_user
  ON linked_identities(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_linked_identities_provider_sub
  ON linked_identities(tenant_id, provider_id, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_linked_identities_email
  ON linked_identities(tenant_id, provider_email);

CREATE TABLE IF NOT EXISTS identity_sensitive_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  value_key TEXT NOT NULL,
  value_json JSONB,
  value_hash TEXT,
  classification TEXT NOT NULL DEFAULT 'sensitive',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT identity_sensitive_values_unique_owner_key
    UNIQUE(tenant_id, owner_type, owner_id, value_key)
);

CREATE INDEX IF NOT EXISTS idx_identity_sensitive_values_owner
  ON identity_sensitive_values(tenant_id, owner_type, owner_id, value_key, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_identity_sensitive_values_hash
  ON identity_sensitive_values(tenant_id, value_key, value_hash, lifecycle_state);

CREATE TABLE IF NOT EXISTS audit_log_pii (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT,
  action TEXT NOT NULL,
  target_user_id TEXT,
  details JSONB,
  ip_address TEXT,
  user_agent TEXT,
  created_at BIGINT NOT NULL,
  exported_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_audit_pii_user
  ON audit_log_pii(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_audit_pii_target
  ON audit_log_pii(tenant_id, target_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_pii_action
  ON audit_log_pii(tenant_id, action);
CREATE INDEX IF NOT EXISTS idx_audit_pii_exported
  ON audit_log_pii(tenant_id, exported_at);
CREATE INDEX IF NOT EXISTS idx_audit_pii_created
  ON audit_log_pii(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS users_pii_tombstone (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  email_blind_index TEXT,
  deleted_at BIGINT NOT NULL,
  deleted_by TEXT,
  deletion_reason TEXT,
  retention_until BIGINT NOT NULL,
  deletion_metadata JSONB,
  created_at BIGINT,
  updated_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_users_pii_tombstone_tenant
  ON users_pii_tombstone(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_pii_tombstone_email
  ON users_pii_tombstone(tenant_id, email_blind_index);
CREATE INDEX IF NOT EXISTS idx_users_pii_tombstone_retention
  ON users_pii_tombstone(tenant_id, retention_until);
