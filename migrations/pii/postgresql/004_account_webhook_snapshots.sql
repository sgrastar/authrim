-- Event-time email data stays in the PII stream and survives account cleanup for bounded delivery.
CREATE TABLE account_webhook_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  registration_state TEXT NOT NULL CHECK (registration_state IN ('guest', 'registered')),
  email_before_json TEXT,
  email_after_json TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX idx_account_webhook_snapshot_expiry ON account_webhook_snapshots (tenant_id, expires_at);
CREATE TABLE account_webhook_delivery_fields (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, event_id, webhook_id)
);
