-- External PostgreSQL parity for Consent Gate runtime state.
-- Responsibilities mirror D1: consent_records is evidence, oauth_client_consents and
-- attribute_release_consents are current protocol grants, document_acknowledgments_current is
-- Client-independent Legal state, and consent_gate_decision_receipts is single-use authority.

CREATE TABLE IF NOT EXISTS consent_gate_policy_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  gate_kind TEXT NOT NULL CHECK (
    gate_kind IN ('legal_document', 'oidc_authorization', 'saml_attribute_release')
  ),
  target_type TEXT NOT NULL CHECK (target_type IN ('tenant', 'oidc_client', 'saml_sp')),
  target_id TEXT,
  policy_id TEXT NOT NULL,
  enabled BIGINT NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT consent_gate_policy_bindings_policy_fk
    FOREIGN KEY (policy_id) REFERENCES consent_policies(id) ON DELETE CASCADE,
  CONSTRAINT consent_gate_policy_bindings_target_check CHECK (
    (target_type = 'tenant' AND target_id IS NULL) OR
    (target_type IN ('oidc_client', 'saml_sp') AND target_id IS NOT NULL AND length(target_id) > 0)
  ),
  CONSTRAINT consent_gate_policy_bindings_gate_target_check CHECK (
    target_type = 'tenant' OR
    gate_kind = 'legal_document' OR
    (gate_kind = 'oidc_authorization' AND target_type = 'oidc_client') OR
    (gate_kind = 'saml_attribute_release' AND target_type = 'saml_sp')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_gate_policy_bindings_target_unique
  ON consent_gate_policy_bindings(
    tenant_id,
    gate_kind,
    target_type,
    COALESCE(target_id, '')
  );

CREATE INDEX IF NOT EXISTS idx_consent_gate_policy_bindings_policy
  ON consent_gate_policy_bindings(tenant_id, policy_id, enabled);

CREATE TABLE IF NOT EXISTS document_acknowledgments_current (
  tenant_id TEXT NOT NULL,
  subject_user_id TEXT NOT NULL,
  consent_kind TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  statement_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'withdrawn', 'expired')),
  accepted_at BIGINT,
  expires_at BIGINT,
  withdrawn_at BIGINT,
  latest_evidence_record_id TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (
    tenant_id,
    subject_user_id,
    consent_kind,
    statement_id,
    statement_version
  )
);

CREATE INDEX IF NOT EXISTS idx_document_acknowledgments_current_active
  ON document_acknowledgments_current(
    tenant_id,
    subject_user_id,
    consent_kind,
    statement_id,
    statement_version,
    status,
    expires_at
  );

CREATE TABLE IF NOT EXISTS consent_gate_decision_receipts (
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
  decision_json JSONB NOT NULL,
  evidence_record_ids_json JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'consumed', 'denied', 'expired')),
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT consent_gate_decision_receipts_target_check CHECK (
    (target_type = 'tenant' AND target_id IS NULL AND protocol_request_id IS NULL) OR
    (target_type IN ('oidc_client', 'saml_sp') AND target_id IS NOT NULL AND protocol_request_id IS NOT NULL)
  ),
  CONSTRAINT consent_gate_decision_receipts_gate_target_check CHECK (
    gate_kind = 'legal_document' OR
    (gate_kind = 'oidc_authorization' AND target_type = 'oidc_client') OR
    (gate_kind = 'saml_attribute_release' AND target_type = 'saml_sp')
  )
);

CREATE INDEX IF NOT EXISTS idx_consent_gate_decision_receipts_lookup
  ON consent_gate_decision_receipts(tenant_id, id, state, expires_at);

CREATE INDEX IF NOT EXISTS idx_consent_gate_decision_receipts_interaction
  ON consent_gate_decision_receipts(tenant_id, interaction_id, gate_kind, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_gate_decision_receipts_gate_once
  ON consent_gate_decision_receipts(tenant_id, interaction_id, flow_node_id, gate_kind);

CREATE INDEX IF NOT EXISTS idx_consent_gate_decision_receipts_protocol_request
  ON consent_gate_decision_receipts(tenant_id, protocol_request_id, target_type, target_id, state);

-- Normalize the original external schema to the portable oauth_client_consents contract used by
-- D1 and the shared consent repositories. The original PostgreSQL seed called this column
-- "scopes" while every runtime query uses "scope".
ALTER TABLE oauth_client_consents RENAME COLUMN scopes TO scope;
ALTER TABLE oauth_client_consents ADD COLUMN IF NOT EXISTS selected_scopes JSONB;
ALTER TABLE oauth_client_consents ADD COLUMN IF NOT EXISTS privacy_policy_version TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN IF NOT EXISTS tos_version TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN IF NOT EXISTS consent_version BIGINT DEFAULT 1;
ALTER TABLE oauth_client_consents ADD COLUMN IF NOT EXISTS release_set_hash TEXT;
ALTER TABLE oauth_client_consents ADD COLUMN IF NOT EXISTS selected_claims JSONB;

UPDATE oauth_client_consents
   SET selected_scopes = to_jsonb(regexp_split_to_array(trim(scope), '\s+'))
 WHERE selected_scopes IS NULL;

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
  first_granted_at BIGINT,
  last_confirmed_at BIGINT,
  expires_at BIGINT,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT attribute_release_consents_destination_unique
    UNIQUE (tenant_id, subject_id, destination_type, destination_id, attribute_set_hash)
);

CREATE INDEX IF NOT EXISTS idx_attribute_release_consents_destination
  ON attribute_release_consents(tenant_id, destination_type, destination_id, consent_state);

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
WHERE acceptance_rank = 1
ON CONFLICT (
  tenant_id,
  subject_user_id,
  consent_kind,
  statement_id,
  statement_version
) DO NOTHING;
