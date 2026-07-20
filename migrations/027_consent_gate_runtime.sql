-- Consent Gate runtime state for policy binding, legal-document current state, and
-- tamper-resistant protocol continuation receipts.
-- Responsibilities remain intentionally split:
--   consent_records: immutable/minimized evidence and audit correlation;
--   oauth_client_consents: current OIDC scope/claim release grant per Client;
--   attribute_release_consents: current SAML attribute grant per SP and source-set hash;
--   document_acknowledgments_current: Client-independent Legal statement/version state;
--   consent_gate_decision_receipts: short-lived, single-use protocol continuation authority.

CREATE TABLE consent_gate_policy_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  gate_kind TEXT NOT NULL CHECK (
    gate_kind IN ('legal_document', 'oidc_authorization', 'saml_attribute_release')
  ),
  target_type TEXT NOT NULL CHECK (target_type IN ('tenant', 'oidc_client', 'saml_sp')),
  target_id TEXT,
  policy_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES consent_policies(id) ON DELETE CASCADE,
  CHECK (
    (target_type = 'tenant' AND target_id IS NULL) OR
    (target_type IN ('oidc_client', 'saml_sp') AND target_id IS NOT NULL AND length(target_id) > 0)
  ),
  CHECK (
    target_type = 'tenant' OR
    gate_kind = 'legal_document' OR
    (gate_kind = 'oidc_authorization' AND target_type = 'oidc_client') OR
    (gate_kind = 'saml_attribute_release' AND target_type = 'saml_sp')
  )
);

CREATE UNIQUE INDEX idx_consent_gate_policy_bindings_target_unique
  ON consent_gate_policy_bindings(
    tenant_id,
    gate_kind,
    target_type,
    COALESCE(target_id, '')
  );

CREATE INDEX idx_consent_gate_policy_bindings_policy
  ON consent_gate_policy_bindings(tenant_id, policy_id, enabled);

CREATE TABLE document_acknowledgments_current (
  tenant_id TEXT NOT NULL,
  subject_user_id TEXT NOT NULL,
  consent_kind TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  statement_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'withdrawn', 'expired')),
  accepted_at INTEGER,
  expires_at INTEGER,
  withdrawn_at INTEGER,
  latest_evidence_record_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    tenant_id,
    subject_user_id,
    consent_kind,
    statement_id,
    statement_version
  )
);

CREATE INDEX idx_document_acknowledgments_current_active
  ON document_acknowledgments_current(
    tenant_id,
    subject_user_id,
    consent_kind,
    statement_id,
    statement_version,
    status,
    expires_at
  );

CREATE TABLE consent_gate_decision_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  interaction_id TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  flow_node_id TEXT NOT NULL,
  gate_kind TEXT NOT NULL CHECK (
    gate_kind IN ('legal_document', 'oidc_authorization', 'saml_attribute_release')
  ),
  subject_user_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('tenant', 'oidc_client', 'saml_sp')),
  target_id TEXT,
  policy_id TEXT,
  protocol_request_id TEXT,
  statement_version_set_hash TEXT,
  release_set_hash TEXT,
  decision_json TEXT NOT NULL,
  evidence_record_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'consumed', 'denied', 'expired')),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (target_type = 'tenant' AND target_id IS NULL AND protocol_request_id IS NULL) OR
    (target_type IN ('oidc_client', 'saml_sp') AND target_id IS NOT NULL AND protocol_request_id IS NOT NULL)
  ),
  CHECK (
    gate_kind = 'legal_document' OR
    (gate_kind = 'oidc_authorization' AND target_type = 'oidc_client') OR
    (gate_kind = 'saml_attribute_release' AND target_type = 'saml_sp')
  )
);

CREATE INDEX idx_consent_gate_decision_receipts_lookup
  ON consent_gate_decision_receipts(tenant_id, id, state, expires_at);

CREATE INDEX idx_consent_gate_decision_receipts_interaction
  ON consent_gate_decision_receipts(tenant_id, interaction_id, gate_kind, created_at);

CREATE UNIQUE INDEX idx_consent_gate_decision_receipts_gate_once
  ON consent_gate_decision_receipts(tenant_id, interaction_id, flow_node_id, gate_kind);

CREATE INDEX idx_consent_gate_decision_receipts_protocol_request
  ON consent_gate_decision_receipts(tenant_id, protocol_request_id, target_type, target_id, state);

ALTER TABLE oauth_client_consents ADD COLUMN release_set_hash TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN selected_claims TEXT;

-- Collapse active Legal Consent evidence into a statement/version current projection.
-- Client, Policy, and Flow identifiers intentionally remain only on consent_records.
WITH ranked_legal_acceptances AS (
  SELECT
    id,
    tenant_id,
    subject_user_id,
    consent_kind,
    statement_id,
    statement_version,
    created_at,
    expires_at,
    updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, subject_user_id, consent_kind, statement_id, statement_version
      ORDER BY created_at DESC, updated_at DESC, id DESC
    ) AS acceptance_rank
  FROM consent_records
  WHERE status = 'active'
    AND decision = 'accepted'
    AND (protocol = 'document' OR consent_kind IN ('terms', 'privacy'))
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > __AUTHRIM_NOW_EPOCH_SECONDS__)
)
INSERT INTO document_acknowledgments_current (
  tenant_id,
  subject_user_id,
  consent_kind,
  statement_id,
  statement_version,
  status,
  accepted_at,
  expires_at,
  withdrawn_at,
  latest_evidence_record_id,
  updated_at
)
SELECT
  tenant_id,
  subject_user_id,
  consent_kind,
  statement_id,
  statement_version,
  'accepted',
  created_at,
  expires_at,
  NULL,
  id,
  updated_at
FROM ranked_legal_acceptances
WHERE acceptance_rank = 1;
