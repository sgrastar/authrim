-- =============================================================================
-- Migration 038: Security Tables
-- =============================================================================
-- Creates tables for security monitoring features:
-- - suspicious_activities: Track suspicious user activities
-- - security_threats: Track detected security threats
-- =============================================================================

-- =============================================================================
-- 1. Suspicious Activities Table
-- =============================================================================
-- Tracks suspicious activities detected by the system (failed logins,
-- unusual patterns, credential stuffing attempts, etc.)

CREATE TABLE suspicious_activities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,           -- brute_force, credential_stuffing, anomalous_login, etc.
  severity TEXT NOT NULL,       -- critical, high, medium, low, info
  user_id TEXT,                 -- Associated user (nullable for pre-auth events)
  client_id TEXT,               -- Associated OAuth client
  source_ip TEXT,               -- Source IP address
  user_agent TEXT,              -- User agent string
  description TEXT,             -- Human-readable description
  metadata TEXT,                -- JSON: Additional context data
  created_at TEXT NOT NULL,     -- When detected
  resolved_at TEXT              -- When resolved/dismissed
);

-- Indexes for suspicious_activities
CREATE INDEX idx_suspicious_activities_tenant ON suspicious_activities(tenant_id);
CREATE INDEX idx_suspicious_activities_type ON suspicious_activities(tenant_id, type);
CREATE INDEX idx_suspicious_activities_severity ON suspicious_activities(tenant_id, severity);
CREATE INDEX idx_suspicious_activities_user ON suspicious_activities(tenant_id, user_id);
CREATE INDEX idx_suspicious_activities_created ON suspicious_activities(tenant_id, created_at);

-- =============================================================================
-- 2. Security Threats Table
-- =============================================================================
-- Tracks security threats that require attention (active attacks,
-- compromised credentials, vulnerability exploitation, etc.)

CREATE TABLE security_threats (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,           -- credential_compromise, attack_pattern, vulnerability, etc.
  severity TEXT NOT NULL,       -- critical, high, medium, low, info
  status TEXT NOT NULL DEFAULT 'active',  -- active, investigating, mitigated, resolved
  title TEXT NOT NULL,          -- Short title
  description TEXT,             -- Detailed description
  source TEXT,                  -- Detection source (system, external, manual)
  affected_resources TEXT,      -- JSON: List of affected resources
  indicators TEXT,              -- JSON: Indicators of compromise (IOCs)
  metadata TEXT,                -- JSON: Additional context
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,    -- When threat was detected
  mitigated_at TEXT             -- When threat was mitigated
);

-- Indexes for security_threats
CREATE INDEX idx_security_threats_tenant ON security_threats(tenant_id);
CREATE INDEX idx_security_threats_type ON security_threats(tenant_id, type);
CREATE INDEX idx_security_threats_severity ON security_threats(tenant_id, severity);
CREATE INDEX idx_security_threats_status ON security_threats(tenant_id, status);
CREATE INDEX idx_security_threats_detected ON security_threats(tenant_id, detected_at);

-- =============================================================================
-- Migration Complete
-- =============================================================================
