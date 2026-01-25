-- Migration: Add flows table for Flow Engine management
-- Enables dynamic flow management through the Admin UI
-- Flow definitions control authentication/authorization flows per tenant/client

-- Flows table
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Optional client binding (NULL = tenant default flow)
  client_id TEXT,

  -- Profile targeting
  -- 'human-basic' | 'human-org' | 'ai-agent' | 'iot-device'
  profile_id TEXT NOT NULL,

  -- Flow identification
  name TEXT NOT NULL,
  description TEXT,

  -- Flow definition (JSON)
  graph_definition TEXT NOT NULL,  -- GraphDefinition JSON
  compiled_plan TEXT,              -- CompiledPlan JSON (cached for performance)

  -- Versioning
  version TEXT NOT NULL DEFAULT '1.0.0',

  -- Status flags
  is_active INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 0,  -- System flows cannot be deleted

  -- Audit fields
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,

  -- Constraints
  -- Unique per tenant+client+profile combination
  -- NULL client_id means tenant default (only one per tenant+profile)
  UNIQUE(tenant_id, client_id, profile_id)
);

-- Index for efficient flow lookup by tenant
CREATE INDEX IF NOT EXISTS idx_flows_tenant ON flows(tenant_id, is_active);

-- Index for flow lookup by profile
CREATE INDEX IF NOT EXISTS idx_flows_profile ON flows(tenant_id, profile_id);

-- Index for client-specific flow lookup
CREATE INDEX IF NOT EXISTS idx_flows_client ON flows(tenant_id, client_id);

-- Index for builtin flow management
CREATE INDEX IF NOT EXISTS idx_flows_builtin ON flows(is_builtin);
