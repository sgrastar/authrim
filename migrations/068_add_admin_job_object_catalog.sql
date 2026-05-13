-- Phase 7: Admin job result artifacts should move to object_catalog-backed storage.
-- This keeps admin_jobs summary/state in DB while generated result payloads live in EXPORT_ARTIFACTS.

ALTER TABLE admin_jobs ADD COLUMN object_catalog_id TEXT;

CREATE INDEX IF NOT EXISTS idx_admin_jobs_object_catalog
  ON admin_jobs(object_catalog_id);
