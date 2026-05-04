-- =============================================================================
-- Migration: Webhook Delivery Payload Externalization Foundation
-- =============================================================================
-- Created: 2026-05-01
-- Description:
--   Adds the webhook_deliveries table used by webhook replay/history APIs and a
--   detail_object_catalog_id pointer for externalized request/response payloads.
-- =============================================================================

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'retrying')),
  status_code INTEGER,
  request_headers TEXT,
  request_body TEXT,
  response_body TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  next_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  FOREIGN KEY (webhook_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
);

ALTER TABLE webhook_deliveries ADD COLUMN detail_object_catalog_id TEXT;

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_created
  ON webhook_deliveries(webhook_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant_created
  ON webhook_deliveries(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_created
  ON webhook_deliveries(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_detail_object_catalog
  ON webhook_deliveries(detail_object_catalog_id);
