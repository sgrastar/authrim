-- Migration: 018_ai_grants.sql
-- Description: Create ai_grants table for AI Ephemeral Auth grant management
-- Author: @authrim
-- Date: 2025-12-28
-- Issue: Human Auth / AI Ephemeral Auth Two-Layer Model Implementation

-- =============================================================================
-- 1. AI Grants Table
-- =============================================================================
-- Stores grants that authorize AI principals (agents, tools, services) to act
-- on behalf of users or systems. Used for MCP (Model Context Protocol) integration
-- and AI-to-AI delegation scenarios.
--
-- Design considerations:
-- - ai_principal: Identifier for the AI agent/tool (e.g., "mcp:agent:xyz", "tool:github-copilot")
-- - scopes: Space-separated list of granted scopes (ai:read, ai:write, ai:execute, ai:admin)
-- - scope_targets: Optional JSON for resource-specific constraints
-- - expires_at: Optional expiration (NULL = no expiration, but profile max_token_ttl still applies)
-- - Soft delete via revoked_at (never hard delete for audit purposes)

CREATE TABLE ai_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  ai_principal TEXT NOT NULL,
  scopes TEXT NOT NULL,
  scope_targets TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT,
  UNIQUE(tenant_id, client_id, ai_principal)
);

-- =============================================================================
-- 2. Indexes for Performance
-- =============================================================================

-- Index for client-specific grant lookups
CREATE INDEX idx_ai_grants_client ON ai_grants(client_id);

-- Index for principal-specific grant lookups
CREATE INDEX idx_ai_grants_principal ON ai_grants(ai_principal);

-- Index for tenant-scoped queries
CREATE INDEX idx_ai_grants_tenant ON ai_grants(tenant_id);

-- Index for active grants (filtering out revoked)
CREATE INDEX idx_ai_grants_active ON ai_grants(is_active) WHERE is_active = 1;

-- Index for expiration cleanup
CREATE INDEX idx_ai_grants_expires ON ai_grants(expires_at) WHERE expires_at IS NOT NULL;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.
--
-- DROP INDEX IF EXISTS idx_ai_grants_expires;
-- DROP INDEX IF EXISTS idx_ai_grants_active;
-- DROP INDEX IF EXISTS idx_ai_grants_tenant;
-- DROP INDEX IF EXISTS idx_ai_grants_principal;
-- DROP INDEX IF EXISTS idx_ai_grants_client;
-- DROP TABLE IF EXISTS ai_grants;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 018
-- =============================================================================
