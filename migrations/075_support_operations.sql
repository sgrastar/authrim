-- Privacy-preserving support operations
-- Adds cohort snapshots and approved action tracking without exposing target IDs via Admin API.

CREATE TABLE IF NOT EXISTS support_operation_cohorts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  resource TEXT NOT NULL,
  intended_action TEXT NOT NULL,
  selector_json TEXT NOT NULL,
  selector_hash TEXT NOT NULL,
  matched_count INTEGER NOT NULL,
  actionable_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  blocked_summary_json TEXT,
  snapshot_status TEXT NOT NULL DEFAULT 'completed' CHECK (
    snapshot_status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  ),
  snapshot_job_id TEXT,
  snapshot_error TEXT,
  risk_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  support_case_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS support_operation_cohort_targets (
  id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  resource TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_hash TEXT,
  block_reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (cohort_id) REFERENCES support_operation_cohorts(id) ON DELETE CASCADE,
  UNIQUE(cohort_id, target_id)
);

CREATE TABLE IF NOT EXISTS support_operation_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  cohort_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('approval_required', 'approved', 'running', 'completed', 'failed', 'cancelled')
  ),
  reason TEXT NOT NULL,
  support_case_id TEXT,
  approval_request_id TEXT,
  job_id TEXT,
  result_summary_json TEXT,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (cohort_id) REFERENCES support_operation_cohorts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS support_operation_break_glass_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  resource TEXT NOT NULL,
  cohort_id TEXT,
  action_id TEXT,
  target_id TEXT,
  target_hash TEXT,
  requested_detail_classes_json TEXT NOT NULL DEFAULT '[]',
  redaction_level TEXT NOT NULL DEFAULT 'masked' CHECK (
    redaction_level IN ('summary_only', 'masked', 'raw')
  ),
  reason TEXT NOT NULL,
  support_case_id TEXT,
  approval_request_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('approval_required', 'approved', 'revealed', 'expired', 'denied', 'cancelled')
  ),
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  revealed_by TEXT,
  revealed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (cohort_id) REFERENCES support_operation_cohorts(id) ON DELETE SET NULL,
  FOREIGN KEY (action_id) REFERENCES support_operation_actions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS support_operation_break_glass_reveals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  break_glass_request_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  detail_classes_json TEXT NOT NULL DEFAULT '[]',
  result_summary_json TEXT,
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (break_glass_request_id)
    REFERENCES support_operation_break_glass_requests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_soc_tenant_created
  ON support_operation_cohorts(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soc_tenant_expires
  ON support_operation_cohorts(tenant_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_soc_selector_hash
  ON support_operation_cohorts(tenant_id, resource, selector_hash);
CREATE INDEX IF NOT EXISTS idx_soc_snapshot_status
  ON support_operation_cohorts(tenant_id, snapshot_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_soct_cohort
  ON support_operation_cohort_targets(tenant_id, cohort_id);
CREATE INDEX IF NOT EXISTS idx_soct_cohort_block
  ON support_operation_cohort_targets(tenant_id, cohort_id, block_reason);

CREATE INDEX IF NOT EXISTS idx_soa_tenant_created
  ON support_operation_actions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soa_tenant_status
  ON support_operation_actions(tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_soa_cohort
  ON support_operation_actions(tenant_id, cohort_id);
CREATE INDEX IF NOT EXISTS idx_soa_approval_request
  ON support_operation_actions(tenant_id, approval_request_id);

CREATE INDEX IF NOT EXISTS idx_sobgr_tenant_status
  ON support_operation_break_glass_requests(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sobgr_approval_request
  ON support_operation_break_glass_requests(tenant_id, approval_request_id);
CREATE INDEX IF NOT EXISTS idx_sobgr_cohort
  ON support_operation_break_glass_requests(tenant_id, cohort_id);
CREATE INDEX IF NOT EXISTS idx_sobgr_action
  ON support_operation_break_glass_requests(tenant_id, action_id);
CREATE INDEX IF NOT EXISTS idx_sobgr_reveals_request
  ON support_operation_break_glass_reveals(tenant_id, break_glass_request_id, occurred_at DESC);
