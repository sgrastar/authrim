-- Migration: 031_security_and_operational
-- Description: Security alerts, operational logs, and idempotency support tables
-- Date: 2026-01-03

-- =============================================================================
-- Security Alerts Table
-- =============================================================================
-- Stores security alerts for tenant monitoring (brute force, suspicious login, etc.)
-- Supports cursor-based pagination and filtering by status/severity/type

CREATE TABLE IF NOT EXISTS security_alerts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN (
        'brute_force',
        'credential_stuffing',
        'suspicious_login',
        'impossible_travel',
        'account_takeover',
        'mfa_bypass_attempt',
        'token_abuse',
        'rate_limit_exceeded',
        'config_change',
        'privilege_escalation',
        'data_exfiltration',
        'other'
    )),
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
    title TEXT NOT NULL,
    description TEXT,
    source_ip TEXT,
    user_id TEXT,
    client_id TEXT,
    metadata TEXT, -- JSON string for additional context
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    acknowledged_at INTEGER,
    acknowledged_by TEXT,
    resolved_at INTEGER,
    resolved_by TEXT,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_security_alerts_tenant_status
    ON security_alerts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_security_alerts_tenant_severity
    ON security_alerts(tenant_id, severity);
CREATE INDEX IF NOT EXISTS idx_security_alerts_tenant_created
    ON security_alerts(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_alerts_tenant_type
    ON security_alerts(tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_security_alerts_user
    ON security_alerts(user_id);

-- =============================================================================
-- Operational Logs Table
-- =============================================================================
-- Stores sensitive operation details (reason_detail) separately from audit logs
-- Encrypted storage with configurable retention period
-- Access restricted to system_admin only

CREATE TABLE IF NOT EXISTS operational_logs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    operation_type TEXT NOT NULL, -- 'suspend', 'lock', 'unlock', 'anonymize', etc.
    resource_type TEXT NOT NULL,  -- 'user', 'client', etc.
    resource_id TEXT NOT NULL,
    admin_id TEXT NOT NULL,       -- Who performed the operation
    reason_detail_encrypted TEXT, -- AES-GCM encrypted reason_detail
    metadata TEXT,                -- JSON for additional non-PII context
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,  -- When this log should be deleted

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Indexes for operational logs
CREATE INDEX IF NOT EXISTS idx_operational_logs_tenant_created
    ON operational_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_logs_resource
    ON operational_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_operational_logs_expires
    ON operational_logs(expires_at);
CREATE INDEX IF NOT EXISTS idx_operational_logs_admin
    ON operational_logs(admin_id);

-- =============================================================================
-- Idempotency Keys Table
-- =============================================================================
-- Prevents duplicate operations for sensitive actions
-- Keys expire after 24 hours (configurable)

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id TEXT PRIMARY KEY,          -- Composite: tenant_id:actor_id:method:path:resource_id:key
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,       -- admin_id who made the request
    method TEXT NOT NULL,         -- HTTP method (POST, PUT, DELETE)
    path TEXT NOT NULL,           -- API path pattern
    resource_id TEXT,             -- Target resource ID (if applicable)
    idempotency_key TEXT NOT NULL,-- The Idempotency-Key header value
    body_hash TEXT NOT NULL,      -- SHA-256 hash of request body
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,  -- Sanitized response (PII removed)
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Indexes for idempotency lookups
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_lookup
    ON idempotency_keys(tenant_id, actor_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
    ON idempotency_keys(expires_at);

-- =============================================================================
-- Tenant Settings Extension
-- =============================================================================
-- Add operational_log_retention_days to tenant settings if not exists
-- This is handled via JSON in the settings column, no schema change needed

-- =============================================================================
-- Cleanup Trigger (for scheduled cleanup)
-- =============================================================================
-- Note: D1 doesn't support triggers, cleanup is handled by scheduled worker
