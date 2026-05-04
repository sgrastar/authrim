-- =============================================================================
-- Migration: Operational Log Detail Externalization Foundation
-- =============================================================================
-- Created: 2026-05-01
-- Description:
--   Adds object_catalog pointer support to operational_logs so reason_detail can
--   be externalized into SENSITIVE_DETAILS.
-- =============================================================================

ALTER TABLE operational_logs ADD COLUMN detail_object_catalog_id TEXT;

CREATE INDEX IF NOT EXISTS idx_operational_logs_detail_object_catalog
  ON operational_logs(detail_object_catalog_id);
