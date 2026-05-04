-- =============================================================================
-- Migration: Admin Approval / Elevation Governance
-- =============================================================================
-- Created: 2026-05-02
-- Description:
--   Adds DB_ADMIN tables for mixed approval workflows, per-approver decisions,
--   and short-lived elevation grant metadata used by delegated support and
--   break-glass style access flows.
-- =============================================================================

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  public_request_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  investigation_id TEXT NOT NULL,
  requester_subject_type TEXT NOT NULL CHECK (
    requester_subject_type IN ('admin_user', 'end_user', 'customer_delegate', 'service_principal')
  ),
  requester_subject_id TEXT NOT NULL,
  target_subject_type TEXT NOT NULL CHECK (
    target_subject_type IN ('user', 'artifact', 'service_resource', 'tenant_resource')
  ),
  target_subject_id TEXT NOT NULL,
  request_surface TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  redaction_level TEXT NOT NULL CHECK (redaction_level IN ('summary_only', 'masked', 'raw')),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'partially_approved', 'approved', 'denied', 'expired', 'cancelled')
  ),
  scope_canonical TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_note TEXT,
  reference_system TEXT,
  reference_value TEXT,
  reference_url TEXT,
  ticket_reference_system TEXT,
  ticket_reference_value TEXT,
  ticket_reference_url TEXT,
  reuse_scope TEXT NOT NULL DEFAULT 'request' CHECK (reuse_scope IN ('request', 'case')),
  policy_preset TEXT NOT NULL,
  partial_access_allowed INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  detail_object_catalog_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (detail_object_catalog_id) REFERENCES object_catalog(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_tenant_status_requested
  ON approval_requests(tenant_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_requests_investigation
  ON approval_requests(investigation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_requests_requester
  ON approval_requests(requester_subject_type, requester_subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_requests_target
  ON approval_requests(target_subject_type, target_subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_requests_expires
  ON approval_requests(expires_at);

CREATE INDEX IF NOT EXISTS idx_approval_requests_detail_object_catalog
  ON approval_requests(detail_object_catalog_id);

CREATE TABLE IF NOT EXISTS approval_request_approvals (
  id TEXT PRIMARY KEY,
  approval_request_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  side TEXT NOT NULL CHECK (
    side IN ('admin_operator', 'customer_data_owner', 'guardian_delegate')
  ),
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('admin_user', 'end_user', 'customer_delegate', 'service_principal')
  ),
  subject_id TEXT,
  relation_type TEXT,
  relation_source TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')
  ),
  method TEXT CHECK (
    method IN ('ciba', 'passkey', 'portal_confirm', 'email_otp', 'sms_otp', 'reauth')
  ),
  transport_channel TEXT,
  reason_code TEXT,
  reason_note TEXT,
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_request_approvals_unique_subject
  ON approval_request_approvals(
    approval_request_id,
    step_key,
    subject_type,
    COALESCE(subject_id, '')
  );

CREATE INDEX IF NOT EXISTS idx_approval_request_approvals_request_status
  ON approval_request_approvals(approval_request_id, status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_approval_request_approvals_subject
  ON approval_request_approvals(subject_type, subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_request_approvals_expires
  ON approval_request_approvals(expires_at);

CREATE TABLE IF NOT EXISTS elevation_grants (
  id TEXT PRIMARY KEY,
  public_grant_id TEXT NOT NULL UNIQUE,
  approval_request_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  target_audience TEXT NOT NULL,
  resource_class TEXT NOT NULL,
  redaction_level TEXT NOT NULL CHECK (redaction_level IN ('summary_only', 'masked', 'raw')),
  scope_canonical TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  authorization_details_json TEXT,
  requester_subject_type TEXT NOT NULL CHECK (
    requester_subject_type IN ('admin_user', 'end_user', 'customer_delegate', 'service_principal')
  ),
  requester_subject_id TEXT NOT NULL,
  actor_subject_type TEXT NOT NULL CHECK (
    actor_subject_type IN ('admin_user', 'end_user', 'customer_delegate', 'service_principal')
  ),
  actor_subject_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_tenant_status_issued
  ON elevation_grants(tenant_id, status, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_request
  ON elevation_grants(approval_request_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_actor
  ON elevation_grants(actor_subject_type, actor_subject_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_expires
  ON elevation_grants(expires_at);
