-- =============================================================================
-- Migration 039: Compliance Tables
-- =============================================================================
-- Creates tables for compliance management features:
-- - access_reviews: Periodic access review campaigns
-- - compliance_reports: Generated compliance reports
-- =============================================================================

-- =============================================================================
-- 1. Access Reviews Table
-- =============================================================================
-- Tracks access review campaigns for compliance (SOC2, ISO27001, etc.)
-- Access reviews verify that users still need their assigned permissions.

CREATE TABLE access_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,           -- Review campaign name
  description TEXT,             -- Campaign description
  scope TEXT NOT NULL,          -- all_users, role, organization, application
  scope_value TEXT,             -- Value for scope (role_id, org_id, client_id)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, in_progress, completed, cancelled
  reviewer_id TEXT,             -- User assigned to review
  total_items INTEGER NOT NULL DEFAULT 0,     -- Total items to review
  reviewed_items INTEGER NOT NULL DEFAULT 0,  -- Items reviewed
  approved_items INTEGER NOT NULL DEFAULT 0,  -- Items approved (access retained)
  revoked_items INTEGER NOT NULL DEFAULT 0,   -- Items revoked (access removed)
  created_at TEXT NOT NULL,
  started_at TEXT,              -- When review started
  completed_at TEXT,            -- When review completed
  due_date TEXT                 -- Review deadline
);

-- Indexes for access_reviews
CREATE INDEX idx_access_reviews_tenant ON access_reviews(tenant_id);
CREATE INDEX idx_access_reviews_status ON access_reviews(tenant_id, status);
CREATE INDEX idx_access_reviews_reviewer ON access_reviews(tenant_id, reviewer_id);
CREATE INDEX idx_access_reviews_created ON access_reviews(tenant_id, created_at);
CREATE INDEX idx_access_reviews_due ON access_reviews(tenant_id, due_date);

-- =============================================================================
-- 2. Access Review Items Table
-- =============================================================================
-- Individual items within an access review (one per user-permission pair)

CREATE TABLE access_review_items (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES access_reviews(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,        -- User being reviewed
  permission_type TEXT NOT NULL, -- role, permission, group_membership
  permission_value TEXT NOT NULL, -- The specific permission/role/group
  decision TEXT,                -- approved, revoked, pending
  decided_by TEXT,              -- Reviewer who made decision
  decided_at TEXT,              -- When decision was made
  justification TEXT,           -- Reason for decision
  created_at TEXT NOT NULL
);

-- Indexes for access_review_items
CREATE INDEX idx_access_review_items_review ON access_review_items(review_id);
CREATE INDEX idx_access_review_items_user ON access_review_items(tenant_id, user_id);
CREATE INDEX idx_access_review_items_decision ON access_review_items(review_id, decision);

-- =============================================================================
-- 3. Compliance Reports Table
-- =============================================================================
-- Stores generated compliance reports (audit logs, access reports, etc.)

CREATE TABLE compliance_reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,           -- audit_log, access_report, user_activity, etc.
  name TEXT NOT NULL,           -- Report name/title
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, generating, completed, failed
  requested_by TEXT,            -- User who requested the report
  parameters TEXT,              -- JSON: Report generation parameters
  result_url TEXT,              -- URL to download completed report
  error_message TEXT,           -- Error message if failed
  created_at TEXT NOT NULL,
  completed_at TEXT,            -- When report generation completed
  expires_at TEXT               -- When report download expires
);

-- Indexes for compliance_reports
CREATE INDEX idx_compliance_reports_tenant ON compliance_reports(tenant_id);
CREATE INDEX idx_compliance_reports_type ON compliance_reports(tenant_id, type);
CREATE INDEX idx_compliance_reports_status ON compliance_reports(tenant_id, status);
CREATE INDEX idx_compliance_reports_created ON compliance_reports(tenant_id, created_at);
CREATE INDEX idx_compliance_reports_requested ON compliance_reports(tenant_id, requested_by);

-- =============================================================================
-- Migration Complete
-- =============================================================================
