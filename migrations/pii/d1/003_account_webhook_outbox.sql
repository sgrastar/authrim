-- Commit PII custom-profile changes and their notification in the same database transaction.
-- Transactional, non-PII account notification outbox. No account FK: deletion must preserve delivery.
CREATE TABLE account_webhook_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  registration_state TEXT NOT NULL CHECK (registration_state IN ('guest', 'registered')),
  previous_registration_state TEXT,
  changed_field TEXT,
  occurred_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0,
  delivered_at BIGINT
);
CREATE INDEX idx_account_webhook_outbox_due ON account_webhook_outbox
  (tenant_id, delivered_at, next_attempt_at, lease_until);
