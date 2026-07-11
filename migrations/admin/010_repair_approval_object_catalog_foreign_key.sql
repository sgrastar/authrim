-- =============================================================================
-- Authrim Admin Migration 010: Repair Approval Object Catalog Foreign Key
-- =============================================================================
-- Migration 009 rebuilt object_catalog by renaming the original table. SQLite
-- propagated that rename into approval_requests, leaving its foreign key aimed
-- at object_catalog_old after the temporary table was dropped.
--
-- D1 always enforces foreign keys, so rebuild the approval parent and both of
-- its dependent tables together. The replacement child tables reference the
-- replacement parent throughout the copy and are renamed only after the old
-- dependency tree has been removed.

CREATE TABLE approval_requests_repaired (
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

CREATE TABLE approval_request_approvals_repaired (
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
  last_notification_action TEXT CHECK (
    last_notification_action IN ('initial', 'resend', 'remind')
  ),
  last_notified_at INTEGER,
  notification_count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (approval_request_id) REFERENCES approval_requests_repaired(id) ON DELETE CASCADE
);

CREATE TABLE elevation_grants_repaired (
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
  FOREIGN KEY (approval_request_id) REFERENCES approval_requests_repaired(id) ON DELETE CASCADE
);

INSERT INTO approval_requests_repaired (
  id,
  public_request_id,
  tenant_id,
  investigation_id,
  requester_subject_type,
  requester_subject_id,
  target_subject_type,
  target_subject_id,
  request_surface,
  requested_action,
  redaction_level,
  status,
  scope_canonical,
  scope_json,
  reason_code,
  reason_note,
  reference_system,
  reference_value,
  reference_url,
  ticket_reference_system,
  ticket_reference_value,
  ticket_reference_url,
  reuse_scope,
  policy_preset,
  partial_access_allowed,
  requested_at,
  expires_at,
  decided_at,
  detail_object_catalog_id,
  created_at,
  updated_at
)
SELECT
  id,
  public_request_id,
  tenant_id,
  investigation_id,
  requester_subject_type,
  requester_subject_id,
  target_subject_type,
  target_subject_id,
  request_surface,
  requested_action,
  redaction_level,
  status,
  scope_canonical,
  scope_json,
  reason_code,
  reason_note,
  reference_system,
  reference_value,
  reference_url,
  ticket_reference_system,
  ticket_reference_value,
  ticket_reference_url,
  reuse_scope,
  policy_preset,
  partial_access_allowed,
  requested_at,
  expires_at,
  decided_at,
  detail_object_catalog_id,
  created_at,
  updated_at
FROM approval_requests;

INSERT INTO approval_request_approvals_repaired (
  id,
  approval_request_id,
  step_key,
  side,
  subject_type,
  subject_id,
  relation_type,
  relation_source,
  status,
  method,
  transport_channel,
  reason_code,
  reason_note,
  requested_at,
  decided_at,
  expires_at,
  created_at,
  updated_at,
  last_notification_action,
  last_notified_at,
  notification_count
)
SELECT
  id,
  approval_request_id,
  step_key,
  side,
  subject_type,
  subject_id,
  relation_type,
  relation_source,
  status,
  method,
  transport_channel,
  reason_code,
  reason_note,
  requested_at,
  decided_at,
  expires_at,
  created_at,
  updated_at,
  last_notification_action,
  last_notified_at,
  notification_count
FROM approval_request_approvals;

INSERT INTO elevation_grants_repaired (
  id,
  public_grant_id,
  approval_request_id,
  tenant_id,
  status,
  target_audience,
  resource_class,
  redaction_level,
  scope_canonical,
  scope_json,
  authorization_details_json,
  requester_subject_type,
  requester_subject_id,
  actor_subject_type,
  actor_subject_id,
  issued_at,
  expires_at,
  revoked_at,
  revoke_reason,
  created_at,
  updated_at
)
SELECT
  id,
  public_grant_id,
  approval_request_id,
  tenant_id,
  status,
  target_audience,
  resource_class,
  redaction_level,
  scope_canonical,
  scope_json,
  authorization_details_json,
  requester_subject_type,
  requester_subject_id,
  actor_subject_type,
  actor_subject_id,
  issued_at,
  expires_at,
  revoked_at,
  revoke_reason,
  created_at,
  updated_at
FROM elevation_grants;

DROP TABLE approval_request_approvals;
DROP TABLE elevation_grants;
DROP TABLE approval_requests;

ALTER TABLE approval_requests_repaired RENAME TO approval_requests;
ALTER TABLE approval_request_approvals_repaired RENAME TO approval_request_approvals;
ALTER TABLE elevation_grants_repaired RENAME TO elevation_grants;

CREATE INDEX idx_approval_requests_tenant_status_requested
  ON approval_requests(tenant_id, status, requested_at DESC);

CREATE INDEX idx_approval_requests_investigation
  ON approval_requests(investigation_id, created_at DESC);

CREATE INDEX idx_approval_requests_requester
  ON approval_requests(requester_subject_type, requester_subject_id, created_at DESC);

CREATE INDEX idx_approval_requests_target
  ON approval_requests(target_subject_type, target_subject_id, created_at DESC);

CREATE INDEX idx_approval_requests_expires
  ON approval_requests(expires_at);

CREATE INDEX idx_approval_requests_detail_object_catalog
  ON approval_requests(detail_object_catalog_id);

CREATE UNIQUE INDEX idx_approval_request_approvals_unique_subject
  ON approval_request_approvals(
    approval_request_id,
    step_key,
    subject_type,
    COALESCE(subject_id, '')
  );

CREATE INDEX idx_approval_request_approvals_request_status
  ON approval_request_approvals(approval_request_id, status, created_at ASC);

CREATE INDEX idx_approval_request_approvals_subject
  ON approval_request_approvals(subject_type, subject_id, created_at DESC);

CREATE INDEX idx_approval_request_approvals_expires
  ON approval_request_approvals(expires_at);

CREATE INDEX idx_elevation_grants_tenant_status_issued
  ON elevation_grants(tenant_id, status, issued_at DESC);

CREATE INDEX idx_elevation_grants_request
  ON elevation_grants(approval_request_id, issued_at DESC);

CREATE INDEX idx_elevation_grants_actor
  ON elevation_grants(actor_subject_type, actor_subject_id, issued_at DESC);

CREATE INDEX idx_elevation_grants_expires
  ON elevation_grants(expires_at);
