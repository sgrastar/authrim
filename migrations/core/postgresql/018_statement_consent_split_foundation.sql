-- Statement consent split foundation (additive; nothing is rebuilt, dropped or rewritten).
-- Same columns as the D1 core stream, plus the two definition tables and the current-version
-- index that the PostgreSQL baseline never had, so statement consent can work on PostgreSQL.
-- There is no foreign key to the client table: clients are not in this database.

ALTER TABLE user_consent_records ADD COLUMN content_hash TEXT;
ALTER TABLE consent_item_history ADD COLUMN content_hash_after TEXT;

ALTER TABLE consent_statements ADD COLUMN definition_generation BIGINT NOT NULL DEFAULT 0
  CHECK (definition_generation BETWEEN 0 AND 9007199254740991);
ALTER TABLE consent_statements ADD COLUMN closed_generation BIGINT NOT NULL DEFAULT 0
  CHECK (closed_generation BETWEEN 0 AND 9007199254740991);
ALTER TABLE consent_statements ADD COLUMN retired_at BIGINT;

CREATE TABLE tenant_consent_requirements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  statement_id TEXT NOT NULL REFERENCES consent_statements(id) ON DELETE CASCADE,
  is_required BIGINT NOT NULL DEFAULT 0,
  min_version TEXT,
  enforcement TEXT NOT NULL DEFAULT 'block',
  show_deletion_link BIGINT NOT NULL DEFAULT 0,
  deletion_url TEXT,
  conditional_rules_json TEXT,
  display_order BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, statement_id)
);
CREATE INDEX idx_tcr_tenant ON tenant_consent_requirements(tenant_id, id);

CREATE TABLE client_consent_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  statement_id TEXT NOT NULL REFERENCES consent_statements(id) ON DELETE CASCADE,
  requirement TEXT NOT NULL DEFAULT 'inherit',
  min_version TEXT,
  enforcement TEXT,
  conditional_rules_json TEXT,
  display_order BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, client_id, statement_id)
);
CREATE INDEX idx_cco_client ON client_consent_overrides(tenant_id, client_id);

-- At most one current version per statement (D1 has had this since its baseline).
CREATE UNIQUE INDEX idx_csv_unique_current
  ON consent_statement_versions(tenant_id, current_statement_guard);
-- Retention and retirement scan a statement's records.
CREATE INDEX idx_ucr_statement ON user_consent_records(tenant_id, statement_id);
