-- Tenant placement scope and per-tenant assigned shard sets. Authoritative tenant Core/PII
-- resources may be shared or tenant-exclusive; Lookup and Control resources remain shared.

CREATE TABLE IF NOT EXISTS control_tenant_placement_policies (
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  isolation_policy TEXT NOT NULL
    CHECK (isolation_policy IN ('shared_pool', 'tenant_exclusive')),
  policy_generation INTEGER NOT NULL DEFAULT 1 CHECK (policy_generation >= 1),
  policy_state TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (policy_state IN ('provisioning', 'active', 'migrating', 'retired')),
  pending_isolation_policy TEXT
    CHECK (pending_isolation_policy IS NULL OR pending_isolation_policy = 'tenant_exclusive'),
  pending_policy_generation INTEGER,
  migration_operation_id TEXT,
  source_operation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, tenant_id),
  UNIQUE (environment_id, idempotency_key),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  CHECK (
    (pending_isolation_policy IS NULL AND pending_policy_generation IS NULL
      AND migration_operation_id IS NULL) OR
    (isolation_policy = 'shared_pool' AND pending_isolation_policy = 'tenant_exclusive'
      AND pending_policy_generation = policy_generation + 1
      AND migration_operation_id IS NOT NULL AND policy_state = 'migrating')
  ),
  CHECK ((policy_state IN ('active', 'migrating') AND activated_at IS NOT NULL)
    OR policy_state IN ('provisioning', 'retired'))
);

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_policy_identity_immutable
BEFORE UPDATE OF environment_id, tenant_id, source_operation_id, idempotency_key
ON control_tenant_placement_policies
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_policy_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_policy_no_scope_weakening
BEFORE UPDATE OF isolation_policy ON control_tenant_placement_policies
WHEN OLD.isolation_policy = 'tenant_exclusive' AND NEW.isolation_policy <> 'tenant_exclusive'
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_policy_scope_weakening');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_policy_cutover_guard
BEFORE UPDATE OF isolation_policy ON control_tenant_placement_policies
WHEN OLD.isolation_policy <> NEW.isolation_policy AND NOT (
  OLD.isolation_policy = 'shared_pool'
  AND OLD.pending_isolation_policy = 'tenant_exclusive'
  AND OLD.pending_policy_generation = OLD.policy_generation + 1
  AND OLD.migration_operation_id IS NOT NULL
  AND OLD.policy_state = 'migrating'
  AND NEW.isolation_policy = 'tenant_exclusive'
  AND NEW.policy_generation = OLD.pending_policy_generation
  AND NEW.pending_isolation_policy IS NULL
  AND NEW.pending_policy_generation IS NULL
  AND NEW.migration_operation_id IS NULL
  AND NEW.policy_state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_policy_cutover_invalid');
END;

ALTER TABLE control_tenant_shards
  ADD COLUMN allocation_scope TEXT NOT NULL DEFAULT 'shared_pool'
  CHECK (allocation_scope IN ('shared_pool', 'tenant_exclusive'));

ALTER TABLE control_tenant_shards
  ADD COLUMN owner_tenant_id TEXT
  CHECK (
    (allocation_scope = 'shared_pool' AND owner_tenant_id IS NULL) OR
    (allocation_scope = 'tenant_exclusive' AND owner_tenant_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_control_tenant_shards_scope_owner
  ON control_tenant_shards(
    environment_id, allocation_scope, owner_tenant_id, data_role,
    residency_policy_id, residency_partition, status
  );

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_shard_owner_policy_insert
BEFORE INSERT ON control_tenant_shards
WHEN NEW.allocation_scope = 'tenant_exclusive' AND NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.owner_tenant_id
     AND (
       policy.isolation_policy = 'tenant_exclusive' OR
       (policy.pending_isolation_policy = 'tenant_exclusive' AND policy.policy_state = 'migrating')
     )
     AND policy.policy_state IN ('provisioning', 'active', 'migrating')
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_shard_owner_policy_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_shard_owner_immutable
BEFORE UPDATE OF allocation_scope, owner_tenant_id ON control_tenant_shards
WHEN OLD.allocation_scope <> NEW.allocation_scope
  OR OLD.owner_tenant_id IS NOT NEW.owner_tenant_id
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_shard_owner_immutable');
END;

CREATE TABLE IF NOT EXISTS control_tenant_shard_assignments (
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  data_role TEXT NOT NULL
    CHECK (data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii')),
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
  assignment_state TEXT NOT NULL DEFAULT 'active'
    CHECK (assignment_state IN ('pending', 'active', 'retired', 'quarantined')),
  source_operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, tenant_id, data_role, residency_partition, shard_id),
  UNIQUE (environment_id, tenant_id, data_role, residency_partition, assignment_generation),
  FOREIGN KEY (environment_id, tenant_id)
    REFERENCES control_tenant_placement_policies(environment_id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id),
  FOREIGN KEY (environment_id, residency_policy_id, residency_partition)
    REFERENCES control_residency_partitions(environment_id, residency_policy_id, residency_partition),
  CHECK ((assignment_state = 'active' AND activated_at IS NOT NULL AND retired_at IS NULL) OR
         (assignment_state IN ('retired', 'quarantined') AND retired_at IS NOT NULL) OR
         assignment_state = 'pending')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_tenant_default_one_live_assignment
  ON control_tenant_shard_assignments(environment_id, tenant_id, data_role, residency_partition)
  WHERE data_role = 'tenant_core/default' AND assignment_state IN ('pending', 'active');

CREATE INDEX IF NOT EXISTS idx_control_tenant_shard_assignment_candidates
  ON control_tenant_shard_assignments(
    environment_id, tenant_id, data_role, residency_partition, assignment_state, shard_id
  );

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_shard_assignment_scope_insert
BEFORE INSERT ON control_tenant_shard_assignments
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
    JOIN control_tenant_shards shard
      ON shard.shard_id = NEW.shard_id AND shard.environment_id = NEW.environment_id
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.tenant_id
     AND policy.policy_state IN ('provisioning', 'active', 'migrating')
     AND shard.data_role = NEW.data_role
     AND shard.residency_policy_id = NEW.residency_policy_id
     AND shard.residency_partition = NEW.residency_partition
     AND shard.status IN ('ready', 'active')
     AND (
       (NEW.assignment_state = 'active'
        AND policy.isolation_policy = 'shared_pool'
        AND shard.allocation_scope = 'shared_pool'
        AND shard.owner_tenant_id IS NULL) OR
       (NEW.assignment_state = 'active'
        AND policy.isolation_policy = 'tenant_exclusive'
        AND shard.allocation_scope = 'tenant_exclusive'
        AND shard.owner_tenant_id = NEW.tenant_id) OR
       (NEW.assignment_state = 'pending'
        AND policy.isolation_policy = 'shared_pool'
        AND policy.pending_isolation_policy = 'tenant_exclusive'
        AND policy.policy_state = 'migrating'
        AND shard.allocation_scope = 'tenant_exclusive'
        AND shard.owner_tenant_id = NEW.tenant_id)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_shard_assignment_scope_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_shard_assignment_identity_immutable
BEFORE UPDATE OF environment_id, tenant_id, data_role, residency_policy_id,
                 residency_partition, shard_id, assignment_generation, source_operation_id
ON control_tenant_shard_assignments
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_shard_assignment_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_account_allocation_assignment_insert
BEFORE INSERT ON control_tenant_shard_allocations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
    JOIN control_tenant_shard_assignments assignment
      ON assignment.environment_id = NEW.environment_id
     AND assignment.tenant_id = NEW.tenant_id
     AND assignment.data_role = NEW.data_role
     AND assignment.residency_partition = NEW.residency_partition
     AND assignment.shard_id = NEW.selected_shard_id
     AND assignment.assignment_state = 'active'
    JOIN control_tenant_shards shard
      ON shard.shard_id = assignment.shard_id AND shard.environment_id = assignment.environment_id
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.tenant_id
     AND policy.policy_state IN ('provisioning', 'active', 'migrating')
     AND shard.generation = NEW.route_generation
     AND shard.data_role = NEW.data_role
     AND shard.residency_partition = NEW.residency_partition
     AND (
       (policy.isolation_policy = 'shared_pool'
        AND shard.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
       (policy.isolation_policy = 'tenant_exclusive'
        AND shard.allocation_scope = 'tenant_exclusive'
        AND shard.owner_tenant_id = NEW.tenant_id)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_account_allocation_assignment_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_account_allocation_assignment_update
BEFORE UPDATE OF tenant_id, data_role, residency_partition, selected_shard_id, route_generation
ON control_tenant_shard_allocations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
    JOIN control_tenant_shard_assignments assignment
      ON assignment.environment_id = NEW.environment_id
     AND assignment.tenant_id = NEW.tenant_id
     AND assignment.data_role = NEW.data_role
     AND assignment.residency_partition = NEW.residency_partition
     AND assignment.shard_id = NEW.selected_shard_id
     AND assignment.assignment_state = 'active'
    JOIN control_tenant_shards shard
      ON shard.shard_id = assignment.shard_id AND shard.environment_id = assignment.environment_id
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.tenant_id
     AND shard.generation = NEW.route_generation
     AND (
       (policy.isolation_policy = 'shared_pool'
        AND shard.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
       (policy.isolation_policy = 'tenant_exclusive'
        AND shard.allocation_scope = 'tenant_exclusive'
        AND shard.owner_tenant_id = NEW.tenant_id)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_account_allocation_assignment_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_default_assignment_insert
BEFORE INSERT ON control_tenant_default_allocations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
    JOIN control_tenant_shard_assignments assignment
      ON assignment.environment_id = NEW.environment_id
     AND assignment.tenant_id = NEW.tenant_id
     AND assignment.data_role = 'tenant_core/default'
     AND assignment.residency_policy_id = NEW.residency_policy_id
     AND assignment.residency_partition = NEW.residency_partition
     AND assignment.shard_id = NEW.selected_shard_id
     AND assignment.assignment_state = 'active'
    JOIN control_tenant_shards shard
      ON shard.shard_id = assignment.shard_id AND shard.environment_id = assignment.environment_id
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.tenant_id
     AND shard.generation = NEW.route_generation
     AND (
       (policy.isolation_policy = 'shared_pool'
        AND shard.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
       (policy.isolation_policy = 'tenant_exclusive'
        AND shard.allocation_scope = 'tenant_exclusive'
        AND shard.owner_tenant_id = NEW.tenant_id)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_default_assignment_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_default_assignment_update
BEFORE UPDATE OF tenant_id, residency_policy_id, residency_partition,
                 selected_shard_id, route_generation
ON control_tenant_default_allocations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
    JOIN control_tenant_shard_assignments assignment
      ON assignment.environment_id = NEW.environment_id
     AND assignment.tenant_id = NEW.tenant_id
     AND assignment.data_role = 'tenant_core/default'
     AND assignment.residency_policy_id = NEW.residency_policy_id
     AND assignment.residency_partition = NEW.residency_partition
     AND assignment.shard_id = NEW.selected_shard_id
     AND assignment.assignment_state = 'active'
    JOIN control_tenant_shards shard
      ON shard.shard_id = assignment.shard_id AND shard.environment_id = assignment.environment_id
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.tenant_id
     AND shard.generation = NEW.route_generation
     AND (
       (policy.isolation_policy = 'shared_pool'
        AND shard.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
       (policy.isolation_policy = 'tenant_exclusive'
        AND shard.allocation_scope = 'tenant_exclusive'
        AND shard.owner_tenant_id = NEW.tenant_id)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_default_assignment_mismatch');
END;
