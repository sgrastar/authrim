-- Compliance reports keep their file encrypted in EXPORT_ARTIFACTS: each report records the
-- file's catalog entry (in the admin database), its SHA-256, what it holds and its size. A report
-- is generating until its generation is audited, then completed; one whose download period ended
-- is marked expired and its file deleted, as is the file of one that failed.

-- The file's object catalog entry (admin database), set once the file is stored; and where the
-- file is stored, so a file stored for a report that never completed is deleted too.
ALTER TABLE compliance_reports ADD COLUMN object_catalog_id TEXT;
ALTER TABLE compliance_reports ADD COLUMN object_key_base TEXT;
ALTER TABLE compliance_reports ADD COLUMN artifact_sha256 TEXT;
-- csv or json.
ALTER TABLE compliance_reports ADD COLUMN format TEXT
  CHECK (format IS NULL OR format IN ('csv', 'json'));
ALTER TABLE compliance_reports ADD COLUMN row_count INTEGER;
ALTER TABLE compliance_reports ADD COLUMN size_bytes INTEGER;

-- The retention task finds reports past their download period.
CREATE INDEX IF NOT EXISTS idx_compliance_reports_expiry
  ON compliance_reports(tenant_id, status, expires_at);
