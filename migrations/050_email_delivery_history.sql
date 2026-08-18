-- Migration: 050_email_delivery_history.sql
-- Description: Persist privacy-aware email delivery diagnostics and provider acceptance evidence.
-- Author: Authrim
-- Date: 2026-08-17

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

ALTER TABLE notification_delivery_intents ADD COLUMN account_id TEXT;
ALTER TABLE notification_delivery_intents ADD COLUMN recipient_masked TEXT;
ALTER TABLE notification_delivery_intents ADD COLUMN recipient_encrypted TEXT;
ALTER TABLE notification_delivery_intents ADD COLUMN recipient_encryption_key_version INTEGER;
ALTER TABLE notification_delivery_intents ADD COLUMN provider_message_id TEXT;
ALTER TABLE notification_delivery_intents ADD COLUMN provider_accepted_at INTEGER;
ALTER TABLE notification_delivery_intents ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'requested'
  CHECK (delivery_status IN (
    'requested', 'provider_accepted', 'delivered', 'deferred', 'bounced', 'failed',
    'rejected', 'complained', 'unknown'
  ));
ALTER TABLE notification_delivery_intents ADD COLUMN delivery_status_updated_at INTEGER;
ALTER TABLE notification_delivery_intents ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (attempt_count >= 0);
ALTER TABLE notification_delivery_intents ADD COLUMN last_error_code TEXT;

CREATE INDEX IF NOT EXISTS idx_notification_delivery_history_tenant_created
  ON notification_delivery_intents(tenant_id, created_at DESC, intent_id DESC);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_history_account_created
  ON notification_delivery_intents(tenant_id, account_id, created_at DESC, intent_id DESC);

CREATE TRIGGER IF NOT EXISTS trg_notification_delivery_history_recipient_immutable
BEFORE UPDATE OF account_id, recipient_masked, recipient_encrypted,
  recipient_encryption_key_version, created_at
ON notification_delivery_intents
BEGIN
  SELECT RAISE(ABORT, 'notification_delivery_history_recipient_immutable');
END;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- DROP INDEX IF EXISTS idx_notification_delivery_history_account_created;
-- DROP INDEX IF EXISTS idx_notification_delivery_history_tenant_created;
-- DROP TRIGGER IF EXISTS trg_notification_delivery_history_recipient_immutable;
-- ALTER TABLE notification_delivery_intents DROP COLUMN last_error_code;
-- ALTER TABLE notification_delivery_intents DROP COLUMN attempt_count;
-- ALTER TABLE notification_delivery_intents DROP COLUMN delivery_status_updated_at;
-- ALTER TABLE notification_delivery_intents DROP COLUMN delivery_status;
-- ALTER TABLE notification_delivery_intents DROP COLUMN provider_accepted_at;
-- ALTER TABLE notification_delivery_intents DROP COLUMN provider_message_id;
-- ALTER TABLE notification_delivery_intents DROP COLUMN recipient_encryption_key_version;
-- ALTER TABLE notification_delivery_intents DROP COLUMN recipient_encrypted;
-- ALTER TABLE notification_delivery_intents DROP COLUMN recipient_masked;
-- ALTER TABLE notification_delivery_intents DROP COLUMN account_id;
-- DELETE FROM schema_migrations WHERE version = 50;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 050
-- =============================================================================
