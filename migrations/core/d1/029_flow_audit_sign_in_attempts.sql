-- Failed sign-in attempts recorded with their Flow interaction, for investigating a sign-in
-- problem without personal data. A record names the method and a reason from a closed vocabulary,
-- never the user: once the account is known it carries the account's subject hash (an HMAC under
-- the investigation keyring). Each record has a random inquiry number, unique in its tenant.
ALTER TABLE flow_audit_events ADD COLUMN method TEXT;
ALTER TABLE flow_audit_events ADD COLUMN reason_code TEXT;
ALTER TABLE flow_audit_events ADD COLUMN subject_hash TEXT;
ALTER TABLE flow_audit_events ADD COLUMN inquiry_number TEXT;
-- An account's recent attempts, newest first.
CREATE INDEX IF NOT EXISTS idx_flow_audit_events_subject
  ON flow_audit_events(tenant_id, subject_hash, created_at)
  WHERE subject_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_audit_events_inquiry
  ON flow_audit_events(tenant_id, inquiry_number)
  WHERE inquiry_number IS NOT NULL;
