-- Completion evidence is business state, independent of searchable log retention.
CREATE TABLE provisioning_revocation_receipts (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  subject_id TEXT,
  source_event_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_provisioning_revocation_receipts_account
  ON provisioning_revocation_receipts(tenant_id,account_id,source_event_id,id);
