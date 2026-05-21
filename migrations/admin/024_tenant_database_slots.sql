-- Tenant D1 preallocated slot inventory.
-- tenant_database_slots tracks setup/ar-management capacity and assignment state.
-- tenant_database_registry remains the active runtime source of truth once a slot
-- is assigned to a tenant.

CREATE TABLE IF NOT EXISTS tenant_database_slots (
  slot_id TEXT PRIMARY KEY,
  slot_number INTEGER NOT NULL UNIQUE,
  core_binding_ref TEXT NOT NULL UNIQUE,
  pii_binding_ref TEXT NOT NULL UNIQUE,
  core_database_name TEXT NOT NULL,
  pii_database_name TEXT NOT NULL,
  core_database_id TEXT NOT NULL,
  pii_database_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'available',
      'reserved',
      'assigned',
      'pending_binding',
      'unavailable',
      'reset_required',
      'retired'
    )
  ),
  assigned_tenant_id TEXT,
  reserved_by TEXT,
  reserved_at INTEGER,
  assigned_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_slots_state
  ON tenant_database_slots(state, slot_number);

CREATE INDEX IF NOT EXISTS idx_tenant_database_slots_assigned_tenant
  ON tenant_database_slots(assigned_tenant_id)
  WHERE assigned_tenant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tenant_database_slot_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  slot_id TEXT,
  stage TEXT NOT NULL,
  actor TEXT,
  result TEXT NOT NULL CHECK (result IN ('started', 'succeeded', 'failed', 'skipped')),
  error_code TEXT,
  request_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_slot_audit_tenant
  ON tenant_database_slot_audit_events(tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_tenant_database_slot_audit_slot
  ON tenant_database_slot_audit_events(slot_id, created_at);
