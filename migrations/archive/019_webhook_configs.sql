-- Migration: 019_webhook_configs.sql
-- Description: Create webhook_configs table for Event System webhook management
-- Author: @authrim
-- Date: 2025-12-29
-- Issue: Unified Event System Implementation

-- =============================================================================
-- 1. Webhook Configs Table
-- =============================================================================
-- Stores webhook configuration for event delivery.
--
-- Design considerations:
-- - tenant_id: All webhooks are scoped to a tenant
-- - client_id: NULL = tenant-level webhook, value = client-specific webhook
-- - scope: 'tenant' or 'client' for quick filtering
-- - events: JSON array of event patterns (e.g., ["auth.*", "token.access.issued"])
-- - secret_encrypted: AES-256-GCM encrypted webhook secret (never stored in plaintext)
-- - retry_policy: JSON object for retry configuration
-- - Soft delete via active flag (allow deactivation without losing history)

CREATE TABLE webhook_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,
  scope TEXT NOT NULL DEFAULT 'tenant',
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret_encrypted TEXT,
  headers TEXT,
  retry_policy TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT
);

-- =============================================================================
-- 2. Indexes for Performance
-- =============================================================================

-- Index for tenant-scoped queries
CREATE INDEX idx_webhook_configs_tenant ON webhook_configs(tenant_id);

-- Index for client-scoped queries
CREATE INDEX idx_webhook_configs_client ON webhook_configs(tenant_id, client_id);

-- Index for active webhook lookups
CREATE INDEX idx_webhook_configs_active ON webhook_configs(tenant_id, active) WHERE active = 1;

-- Index for scope-based filtering
CREATE INDEX idx_webhook_configs_scope ON webhook_configs(tenant_id, scope);

-- =============================================================================
-- 3. Webhook Delivery Logs Table (Optional)
-- =============================================================================
-- Stores delivery history for debugging and retry management.
-- Keep history for a limited time (cleanup via scheduled job).

CREATE TABLE webhook_delivery_logs (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  status_code INTEGER,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (webhook_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
);

-- Index for webhook-specific delivery history
CREATE INDEX idx_webhook_delivery_logs_webhook ON webhook_delivery_logs(webhook_id);

-- Index for event-specific delivery history
CREATE INDEX idx_webhook_delivery_logs_event ON webhook_delivery_logs(event_id);

-- Index for cleanup by date
CREATE INDEX idx_webhook_delivery_logs_created ON webhook_delivery_logs(created_at);

-- Index for tenant-scoped queries
CREATE INDEX idx_webhook_delivery_logs_tenant ON webhook_delivery_logs(tenant_id);

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.
--
-- DROP INDEX IF EXISTS idx_webhook_delivery_logs_tenant;
-- DROP INDEX IF EXISTS idx_webhook_delivery_logs_created;
-- DROP INDEX IF EXISTS idx_webhook_delivery_logs_event;
-- DROP INDEX IF EXISTS idx_webhook_delivery_logs_webhook;
-- DROP TABLE IF EXISTS webhook_delivery_logs;
-- DROP INDEX IF EXISTS idx_webhook_configs_scope;
-- DROP INDEX IF EXISTS idx_webhook_configs_active;
-- DROP INDEX IF EXISTS idx_webhook_configs_client;
-- DROP INDEX IF EXISTS idx_webhook_configs_tenant;
-- DROP TABLE IF EXISTS webhook_configs;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 019
-- =============================================================================
