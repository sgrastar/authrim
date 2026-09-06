-- Verified SAML aggregate entities available for opt-in runtime resolution.
CREATE TABLE federation_saml_runtime_entities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  trust_source_id TEXT NOT NULL,
  trust_context_snapshot_hash TEXT NOT NULL,
  metadata_document_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_role TEXT NOT NULL,
  metadata_xml TEXT NOT NULL,
  entity_categories_json TEXT,
  entity_category_support_json TEXT,
  registration_authority TEXT,
  valid_until TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, metadata_document_id, entity_id, entity_role),
  FOREIGN KEY (trust_source_id) REFERENCES federation_trust_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (metadata_document_id) REFERENCES federation_metadata_documents(id) ON DELETE CASCADE
);

CREATE INDEX idx_federation_saml_runtime_entities_lookup
  ON federation_saml_runtime_entities(tenant_id, entity_id, entity_role, trust_source_id);

CREATE INDEX idx_federation_saml_runtime_entities_document
  ON federation_saml_runtime_entities(tenant_id, metadata_document_id);

-- Runtime resolution and retention both need a bounded latest-document lookup.
CREATE INDEX idx_federation_metadata_documents_latest_valid
  ON federation_metadata_documents(
    tenant_id,
    trust_source_id,
    document_type,
    validation_state,
    validated_at DESC,
    created_at DESC,
    id DESC
  );

CREATE INDEX idx_federation_metadata_entity_summaries_document
  ON federation_metadata_entity_summaries(tenant_id, metadata_document_id);

CREATE INDEX idx_federation_metadata_validation_events_document
  ON federation_metadata_validation_events(tenant_id, metadata_document_id);

CREATE INDEX idx_federation_metadata_validation_events_source_created
  ON federation_metadata_validation_events(tenant_id, trust_source_id, created_at DESC);

CREATE INDEX idx_federation_metadata_refresh_jobs_source_created
  ON federation_metadata_refresh_jobs(tenant_id, trust_source_id, created_at DESC);

-- A refresh lease fences cross-database reconciliation. Runtime resolution only exposes the
-- document explicitly committed by the lease owner, never an uncommitted concurrent observation.
ALTER TABLE federation_trust_sources ADD COLUMN refresh_operation_token TEXT;
ALTER TABLE federation_trust_sources ADD COLUMN refresh_operation_expires_at INTEGER;
ALTER TABLE federation_trust_sources ADD COLUMN active_metadata_document_id TEXT;
