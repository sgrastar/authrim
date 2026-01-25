-- =============================================================================
-- Migration: Admin Jobs Table for Async Job Management
-- =============================================================================
-- Created: 2026-01-03
-- Description: Creates admin_jobs table to track asynchronous job execution
--              status and results for bulk operations.
--
-- Supported Job Types:
-- - users/import: CSV bulk user import
-- - users/bulk-update: Bulk user updates
-- - organizations/bulk-members: Bulk member additions
-- - reports/generate: Report generation
--
-- Job Status Flow:
-- pending -> processing -> completed/failed/partial_failure
--
-- Usage:
-- 1. POST /api/admin/jobs/users/import - Create import job
-- 2. GET /api/admin/jobs - List all jobs
-- 3. GET /api/admin/jobs/:id - Get job status
-- 4. GET /api/admin/jobs/:id/result - Get job result
-- =============================================================================

-- Admin jobs table
CREATE TABLE IF NOT EXISTS admin_jobs (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL,

  -- Job type (e.g., 'users/import', 'users/bulk-update', 'reports/generate')
  job_type TEXT NOT NULL,

  -- Job status (pending, processing, completed, failed, partial_failure)
  status TEXT NOT NULL DEFAULT 'pending',

  -- Progress tracking (JSON)
  -- { "total": 100, "processed": 45, "succeeded": 43, "failed": 2 }
  progress TEXT,

  -- Job configuration (JSON)
  -- Input parameters for the job
  config TEXT,

  -- R2 key for input file (for import jobs)
  input_r2_key TEXT,

  -- R2 key for result file (for completed jobs with large results)
  result_r2_key TEXT,

  -- Result summary (JSON, for completed jobs)
  -- { "summary": {...}, "failures": [...] }
  result TEXT,

  -- Error information (for failed jobs)
  error_code TEXT,
  error_message TEXT,

  -- Actor who created the job
  created_by TEXT NOT NULL,

  -- Timestamps (Unix timestamp in seconds)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,

  -- Estimated completion time
  estimated_completion INTEGER
);

-- Index for listing jobs by tenant (most common query)
CREATE INDEX IF NOT EXISTS idx_admin_jobs_tenant ON admin_jobs(
  tenant_id,
  created_at DESC
);

-- Index for filtering by status
CREATE INDEX IF NOT EXISTS idx_admin_jobs_status ON admin_jobs(
  tenant_id,
  status,
  created_at DESC
);

-- Index for filtering by job type
CREATE INDEX IF NOT EXISTS idx_admin_jobs_type ON admin_jobs(
  tenant_id,
  job_type,
  created_at DESC
);

-- Index for cleanup of old completed jobs
CREATE INDEX IF NOT EXISTS idx_admin_jobs_cleanup ON admin_jobs(
  status,
  completed_at
);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Next steps:
-- 1. Deploy this migration to D1_CORE database
-- 2. Jobs are created via Admin API endpoints
-- 3. Job processing is handled by Durable Objects or Queues
-- 4. Configure retention policy via KV (admin_jobs_retention_days)
-- =============================================================================
