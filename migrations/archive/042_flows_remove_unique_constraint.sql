-- Migration: Remove UNIQUE constraint from flows table
-- Allows multiple flows per tenant/client/profile combination
-- Users can create multiple flows for testing and backup purposes
-- The "active" flow is determined by is_active flag

-- SQLite doesn't support ALTER TABLE DROP CONSTRAINT
-- We need to recreate the table without the constraint

-- Step 1: Create new table without the UNIQUE constraint
CREATE TABLE IF NOT EXISTS flows_new (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  graph_definition TEXT NOT NULL,
  compiled_plan TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

-- Step 2: Copy existing data
INSERT INTO flows_new SELECT * FROM flows;

-- Step 3: Drop old table
DROP TABLE flows;

-- Step 4: Rename new table
ALTER TABLE flows_new RENAME TO flows;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_flows_tenant ON flows(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_flows_profile ON flows(tenant_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_flows_client ON flows(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_flows_builtin ON flows(is_builtin);

-- Step 6: Add new composite index for FlowRegistry lookups
-- This helps with efficient flow lookup without enforcing uniqueness
CREATE INDEX IF NOT EXISTS idx_flows_lookup ON flows(tenant_id, client_id, profile_id, is_active);
