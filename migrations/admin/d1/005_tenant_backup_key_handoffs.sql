-- Short-lived operation secrets; never include these rows in portable backups.
CREATE TABLE tenant_backup_key_handoffs (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  input_upload_id TEXT,
  request_digest TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  private_ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  submit_expires_at INTEGER NOT NULL CHECK (submit_expires_at > created_at),
  key_expires_at INTEGER NOT NULL CHECK (key_expires_at >= submit_expires_at),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted')),
  envelope TEXT,
  handoff TEXT,
  accepted_at INTEGER,
  FOREIGN KEY (operation_id, tenant_id) REFERENCES tenant_backup_operations(id, tenant_id),
  CHECK ((state='pending' AND envelope IS NULL AND handoff IS NULL AND accepted_at IS NULL) OR
    (state='accepted' AND envelope IS NOT NULL AND handoff IS NOT NULL AND accepted_at >= created_at AND accepted_at < submit_expires_at))
);
CREATE INDEX idx_tenant_backup_key_handoffs_operation ON tenant_backup_key_handoffs(tenant_id, operation_id);
CREATE INDEX idx_tenant_backup_key_handoffs_expiry ON tenant_backup_key_handoffs(key_expires_at);
