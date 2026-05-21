-- Authrim external durable core schema for PostgreSQL.
-- Runtime support is intentionally gated separately; this migration reserves the
-- shared external durable layout used by future core/authorization adapters.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at BIGINT NOT NULL,
  checksum TEXT NOT NULL,
  execution_time_ms INTEGER,
  rollback_sql TEXT
);

CREATE TABLE IF NOT EXISTS users_core (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  phone_number_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email_domain_hash TEXT,
  email_domain_hash_version INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  user_type TEXT NOT NULL DEFAULT 'end_user',
  pii_partition TEXT NOT NULL DEFAULT 'default',
  pii_status TEXT NOT NULL DEFAULT 'pending',
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  suspended_at BIGINT,
  suspended_until BIGINT,
  locked_at BIGINT,
  locked_until BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_login_at BIGINT,
  CONSTRAINT users_core_status_check CHECK (status IN ('active', 'suspended', 'locked')),
  CONSTRAINT users_core_lifecycle_state_check CHECK (
    lifecycle_state IN (
      'invited',
      'pending_verification',
      'provisioning',
      'incomplete',
      'active',
      'dormant',
      'archived',
      'deprovisioned'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_users_core_tenant
  ON users_core(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_core_tenant_active
  ON users_core(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_users_core_domain_hash
  ON users_core(tenant_id, email_domain_hash, email_domain_hash_version);
CREATE INDEX IF NOT EXISTS idx_users_core_external_id
  ON users_core(tenant_id, external_id);
CREATE INDEX IF NOT EXISTS idx_users_core_status
  ON users_core(tenant_id, status);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  CONSTRAINT passkeys_unique_credential UNIQUE(tenant_id, credential_id),
  CONSTRAINT passkeys_user_fk FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_passkeys_user
  ON passkeys(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_passkeys_credential
  ON passkeys(tenant_id, credential_id);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  permissions_json TEXT NOT NULL,
  role_type TEXT NOT NULL DEFAULT 'custom',
  hierarchy_level INTEGER NOT NULL DEFAULT 0,
  is_assignable BOOLEAN NOT NULL DEFAULT TRUE,
  parent_role_id TEXT,
  display_name TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT,
  CONSTRAINT roles_unique_name UNIQUE(tenant_id, name),
  CONSTRAINT roles_parent_fk FOREIGN KEY (parent_role_id) REFERENCES roles(id)
);

CREATE INDEX IF NOT EXISTS idx_roles_tenant_type
  ON roles(tenant_id, role_type);

CREATE TABLE IF NOT EXISTS role_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_target TEXT NOT NULL DEFAULT '',
  expires_at BIGINT,
  assigned_by TEXT,
  metadata_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT role_assignments_subject_fk FOREIGN KEY (subject_id) REFERENCES users_core(id) ON DELETE CASCADE,
  CONSTRAINT role_assignments_role_fk FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_role_assignments_subject
  ON role_assignments(tenant_id, subject_id, scope_type, scope_target);
CREATE INDEX IF NOT EXISTS idx_role_assignments_role
  ON role_assignments(tenant_id, role_id);
CREATE INDEX IF NOT EXISTS idx_role_assignments_expires
  ON role_assignments(tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  relationship_type TEXT NOT NULL,
  from_type TEXT NOT NULL DEFAULT 'subject',
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL DEFAULT 'subject',
  to_id TEXT NOT NULL,
  permission_level TEXT NOT NULL DEFAULT 'full',
  expires_at BIGINT,
  is_bidirectional BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_json TEXT,
  evidence_type TEXT DEFAULT 'manual',
  evidence_ref TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relationships_from
  ON relationships(tenant_id, from_type, from_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_relationships_to
  ON relationships(tenant_id, to_type, to_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_relationships_expires
  ON relationships(tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS oauth_client_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  granted_at BIGINT NOT NULL,
  expires_at BIGINT,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT oauth_client_consents_unique_client UNIQUE(tenant_id, user_id, client_id),
  CONSTRAINT oauth_client_consents_user_fk FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_client_consents_user
  ON oauth_client_consents(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_client_consents_client
  ON oauth_client_consents(tenant_id, client_id);

CREATE TABLE IF NOT EXISTS user_consent_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'granted',
  granted_at BIGINT,
  withdrawn_at BIGINT,
  expires_at BIGINT,
  client_id TEXT,
  ip_address_hash TEXT,
  user_agent TEXT,
  receipt_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT user_consent_records_unique_statement UNIQUE(tenant_id, user_id, statement_id),
  CONSTRAINT user_consent_records_user_fk FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_consent_records_user
  ON user_consent_records(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_consent_records_status
  ON user_consent_records(tenant_id, status, expires_at);

CREATE TABLE IF NOT EXISTS user_custom_fields (
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_name TEXT NOT NULL,
  field_value TEXT,
  field_type TEXT,
  searchable BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT user_custom_fields_pk PRIMARY KEY (tenant_id, user_id, field_name),
  CONSTRAINT user_custom_fields_user_fk FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_custom_fields_search
  ON user_custom_fields(tenant_id, field_name, field_value);

CREATE TABLE IF NOT EXISTS custom_claim_schemas (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_key TEXT NOT NULL,
  active_field_key TEXT,
  display_label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'string',
  is_pii BOOLEAN NOT NULL DEFAULT FALSE,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  validation_rules JSONB,
  include_in_id_token BOOLEAN NOT NULL DEFAULT FALSE,
  include_in_userinfo BOOLEAN NOT NULL DEFAULT FALSE,
  include_in_introspection BOOLEAN NOT NULL DEFAULT FALSE,
  required_scopes JSONB,
  scope_mode TEXT NOT NULL DEFAULT 'any',
  is_searchable BOOLEAN NOT NULL DEFAULT TRUE,
  is_exportable BOOLEAN NOT NULL DEFAULT TRUE,
  is_vc_claim BOOLEAN NOT NULL DEFAULT FALSE,
  claim_namespace TEXT,
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  operation_status TEXT NOT NULL DEFAULT 'active',
  operation_detail TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  show_on_registration BOOLEAN NOT NULL DEFAULT FALSE,
  registration_required BOOLEAN NOT NULL DEFAULT FALSE,
  registration_order INTEGER NOT NULL DEFAULT 0,
  registration_placeholder TEXT,
  CONSTRAINT custom_claim_schemas_active_key UNIQUE(tenant_id, active_field_key),
  CONSTRAINT custom_claim_schemas_scope_mode_check CHECK (scope_mode IN ('all', 'any'))
);

CREATE INDEX IF NOT EXISTS idx_custom_claim_schemas_tenant_active
  ON custom_claim_schemas(tenant_id, is_active, display_order);
CREATE INDEX IF NOT EXISTS idx_custom_claim_schemas_tenant_key
  ON custom_claim_schemas(tenant_id, field_key);
CREATE INDEX IF NOT EXISTS idx_custom_claim_schemas_operation
  ON custom_claim_schemas(tenant_id, operation_status);

CREATE TABLE IF NOT EXISTS custom_claim_schema_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  schema_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  changes JSONB NOT NULL,
  actor_id TEXT,
  actor_type TEXT,
  change_source TEXT,
  created_at BIGINT NOT NULL,
  CONSTRAINT custom_claim_schema_history_unique_version UNIQUE(tenant_id, schema_id, version),
  CONSTRAINT custom_claim_schema_history_operation_check CHECK (
    operation IN ('create', 'update', 'delete', 'rename', 'toggle_active')
  ),
  CONSTRAINT custom_claim_schema_history_actor_type_check CHECK (
    actor_type IS NULL OR actor_type IN ('user', 'admin', 'system', 'api')
  ),
  CONSTRAINT custom_claim_schema_history_change_source_check CHECK (
    change_source IS NULL OR change_source IN ('admin_api', 'admin_ui', 'migration', 'rollback')
  )
);

CREATE INDEX IF NOT EXISTS idx_custom_claim_schema_history_schema
  ON custom_claim_schema_history(tenant_id, schema_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_custom_claim_schema_history_cleanup
  ON custom_claim_schema_history(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS verified_attributes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  attribute_value TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  issuer TEXT,
  credential_id TEXT,
  verified_at BIGINT NOT NULL,
  expires_at BIGINT,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT verified_attributes_unique_name UNIQUE(tenant_id, subject_id, attribute_name)
);

CREATE INDEX IF NOT EXISTS idx_verified_attributes_subject
  ON verified_attributes(tenant_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_verified_attributes_name
  ON verified_attributes(tenant_id, attribute_name);

CREATE TABLE IF NOT EXISTS log_object_catalog (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_key TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('chunk', 'manifest', 'dlq_payload', 'export_artifact')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'orphan_candidate', 'deleted')),
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT,
  compression TEXT CHECK (compression IN ('none', 'gzip_block')),
  encryption_scope TEXT,
  key_version INTEGER,
  created_at BIGINT NOT NULL,
  committed_at BIGINT,
  deleted_at BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_log_object_catalog_object_key
  ON log_object_catalog(object_key);

CREATE INDEX IF NOT EXISTS idx_log_object_catalog_tenant_type_time
  ON log_object_catalog(tenant_key, log_type, plane, created_at);

CREATE INDEX IF NOT EXISTS idx_log_object_catalog_status
  ON log_object_catalog(status, created_at);

CREATE TABLE IF NOT EXISTS log_chunk_record_index (
  record_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_catalog_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  line_number INTEGER,
  block_offset INTEGER,
  block_length INTEGER,
  record_offset INTEGER,
  record_length INTEGER,
  event_at BIGINT NOT NULL,
  index_profile TEXT NOT NULL,
  indexed_fields JSONB,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'deleted')),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_key, log_type, plane, record_id)
);

CREATE INDEX IF NOT EXISTS idx_log_chunk_record_index_time
  ON log_chunk_record_index(tenant_key, log_type, plane, event_at);

CREATE INDEX IF NOT EXISTS idx_log_chunk_record_index_object
  ON log_chunk_record_index(object_catalog_id);

CREATE INDEX IF NOT EXISTS idx_log_chunk_record_index_status
  ON log_chunk_record_index(status, created_at);

CREATE TABLE IF NOT EXISTS log_chunk_manifests (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  bucket_start_at BIGINT NOT NULL,
  bucket_end_at BIGINT NOT NULL,
  shard TEXT NOT NULL,
  manifest_object_key TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  checksum_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'repair_needed')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_log_chunk_manifests_bucket
  ON log_chunk_manifests(tenant_key, log_type, plane, bucket_start_at, shard);
