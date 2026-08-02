-- Migration: 035_notification_delivery_intents.sql
-- Description: Store short-lived encrypted notification payloads separately from reference outboxes.
-- Author: Authrim
-- Date: 2026-07-29

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE IF NOT EXISTS notification_delivery_intents (
  intent_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  provider_order_version INTEGER NOT NULL CHECK (provider_order_version >= 1),
  provider_installation_ids_json TEXT NOT NULL
    CHECK (json_valid(provider_installation_ids_json)
      AND json_type(provider_installation_ids_json) = 'array'
      AND json_array_length(provider_installation_ids_json) BETWEEN 1 AND 8),
  active_provider_index INTEGER NOT NULL DEFAULT 0 CHECK (active_provider_index BETWEEN 0 AND 7),
  provider_started_at INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  notification_kind TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version = 1),
  payload_key_id TEXT,
  payload_envelope_json TEXT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(request_fingerprint) = 64),
  fingerprint_key_id TEXT NOT NULL
    CHECK (fingerprint_key_id NOT GLOB '*[^a-zA-Z0-9._:-]*'
      AND length(fingerprint_key_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'canceled', 'expired', 'dead_letter')),
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  canceled_at INTEGER,
  dead_lettered_at INTEGER,
  delete_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  CHECK (length(intent_id) BETWEEN 1 AND 256),
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_installation_id) BETWEEN 1 AND 256),
  CHECK (active_provider_index < json_array_length(provider_installation_ids_json)),
  CHECK (json_extract(provider_installation_ids_json, '$[0]') = plugin_installation_id),
  CHECK (notification_kind NOT GLOB '*[^a-z0-9._:-]*'
    AND length(notification_kind) BETWEEN 1 AND 128),
  CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  CHECK (expires_at > created_at),
  CHECK (provider_started_at >= created_at),
  CHECK (delete_after >= expires_at),
  CHECK (
    (state = 'pending'
      AND payload_key_id IS NOT NULL
      AND payload_key_id NOT GLOB '*[^a-zA-Z0-9._:-]*'
      AND length(payload_key_id) BETWEEN 1 AND 128
      AND payload_envelope_json IS NOT NULL
      AND json_valid(payload_envelope_json)
      AND length(payload_envelope_json) BETWEEN 1 AND 196608
      AND delivered_at IS NULL
      AND canceled_at IS NULL
      AND dead_lettered_at IS NULL) OR
    (state = 'delivered'
      AND payload_key_id IS NULL
      AND payload_envelope_json IS NULL
      AND delivered_at IS NOT NULL
      AND canceled_at IS NULL
      AND dead_lettered_at IS NULL) OR
    (state IN ('canceled', 'expired')
      AND payload_key_id IS NULL
      AND payload_envelope_json IS NULL
      AND canceled_at IS NOT NULL
      AND delivered_at IS NULL
      AND dead_lettered_at IS NULL) OR
    (state = 'dead_letter'
      AND payload_key_id IS NULL
      AND payload_envelope_json IS NULL
      AND dead_lettered_at IS NOT NULL
      AND delivered_at IS NULL
      AND canceled_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_intents_retention
  ON notification_delivery_intents(delete_after, state, intent_id);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_intents_pending
  ON notification_delivery_intents(tenant_id, state, expires_at, intent_id);

CREATE TRIGGER IF NOT EXISTS trg_notification_delivery_intent_initial_state
BEFORE INSERT ON notification_delivery_intents
WHEN NEW.state <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'invalid_notification_delivery_intent_initial_state');
END;

CREATE TRIGGER IF NOT EXISTS trg_notification_delivery_intent_state_transition
BEFORE UPDATE OF state ON notification_delivery_intents
WHEN OLD.state <> NEW.state AND NOT (
  OLD.state = 'pending' AND NEW.state IN ('delivered', 'canceled', 'expired', 'dead_letter')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_notification_delivery_intent_state_transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_notification_delivery_intent_payload_immutable
BEFORE UPDATE OF payload_key_id, payload_envelope_json, tenant_id, plugin_installation_id,
  provider_order_version, provider_installation_ids_json, channel, notification_kind,
  payload_version, idempotency_key, request_fingerprint,
  fingerprint_key_id, expires_at, created_at
ON notification_delivery_intents
WHEN OLD.state <> 'pending'
  OR NEW.payload_key_id IS NOT NULL
  OR NEW.payload_envelope_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'notification_delivery_intent_payload_immutable');
END;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- DROP TRIGGER IF EXISTS trg_notification_delivery_intent_payload_immutable;
-- DROP TRIGGER IF EXISTS trg_notification_delivery_intent_state_transition;
-- DROP TRIGGER IF EXISTS trg_notification_delivery_intent_initial_state;
-- DROP INDEX IF EXISTS idx_notification_delivery_intents_pending;
-- DROP INDEX IF EXISTS idx_notification_delivery_intents_retention;
-- DROP TABLE IF EXISTS notification_delivery_intents;
-- DELETE FROM schema_migrations WHERE version = 35;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 035
-- =============================================================================
