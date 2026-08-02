-- Online shared-pool to tenant-exclusive placement migration state.

DROP INDEX IF EXISTS idx_control_tenant_default_one_live_assignment;

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_tenant_default_one_active_assignment
  ON control_tenant_shard_assignments(environment_id, tenant_id, data_role, residency_partition)
  WHERE data_role = 'tenant_core/default' AND assignment_state = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_tenant_default_one_pending_assignment
  ON control_tenant_shard_assignments(environment_id, tenant_id, data_role, residency_partition)
  WHERE data_role = 'tenant_core/default' AND assignment_state = 'pending';

CREATE TABLE IF NOT EXISTS control_tenant_placement_migrations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  source_policy_generation INTEGER NOT NULL CHECK (source_policy_generation >= 1),
  target_policy_generation INTEGER NOT NULL CHECK (target_policy_generation = source_policy_generation + 1),
  source_isolation_policy TEXT NOT NULL CHECK (source_isolation_policy = 'shared_pool'),
  target_isolation_policy TEXT NOT NULL CHECK (target_isolation_policy = 'tenant_exclusive'),
  migration_state TEXT NOT NULL DEFAULT 'planning' CHECK (migration_state IN (
    'planning',
    'targets_provisioning',
    'inventory_verifying',
    'capture_installing',
    'backfilling',
    'catching_up',
    'verifying',
    'write_fencing',
    'cutover_ready',
    'cutover_committed',
    'source_quarantined',
    'purge_pending',
    'complete',
    'canceled',
    'blocked'
  )),
  active_operation_key TEXT CHECK (active_operation_key IS NULL OR active_operation_key = 'active'),
  idempotency_key TEXT NOT NULL,
  inventory_digest TEXT,
  inventory_verified_at INTEGER,
  write_fence_state TEXT NOT NULL DEFAULT 'inactive'
    CHECK (write_fence_state IN ('inactive', 'requested', 'active', 'released')),
  write_fence_started_at INTEGER,
  write_fence_released_at INTEGER,
  owner_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at INTEGER,
  cancel_requested_at INTEGER,
  canceled_at INTEGER,
  cutover_committed_at INTEGER,
  source_quarantined_at INTEGER,
  source_retention_expires_at INTEGER,
  purge_approved_by TEXT,
  purge_approved_at INTEGER,
  completed_at INTEGER,
  last_error_code TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES control_operations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id, tenant_id)
    REFERENCES control_tenant_placement_policies(environment_id, tenant_id),
  UNIQUE (environment_id, idempotency_key),
  UNIQUE (environment_id, tenant_id, active_operation_key),
  CHECK (
    (migration_state IN ('complete', 'canceled') AND active_operation_key IS NULL) OR
    (migration_state NOT IN ('complete', 'canceled') AND active_operation_key = 'active')
  ),
  CHECK ((inventory_verified_at IS NULL AND inventory_digest IS NULL) OR
         (inventory_verified_at IS NOT NULL AND length(inventory_digest) = 64)),
  CHECK ((write_fence_state IN ('requested', 'active', 'released')
          AND write_fence_started_at IS NOT NULL) OR write_fence_state = 'inactive'),
  CHECK ((write_fence_state = 'released' AND write_fence_released_at IS NOT NULL)
         OR write_fence_state <> 'released'),
  CHECK ((migration_state IN (
           'cutover_committed', 'source_quarantined', 'purge_pending', 'complete'
         ) AND cutover_committed_at IS NOT NULL) OR
         migration_state NOT IN ('cutover_committed', 'source_quarantined', 'purge_pending', 'complete')),
  CHECK ((migration_state = 'canceled' AND canceled_at IS NOT NULL) OR migration_state <> 'canceled'),
  CHECK ((migration_state = 'complete' AND completed_at IS NOT NULL) OR migration_state <> 'complete')
);

CREATE INDEX IF NOT EXISTS idx_control_tenant_placement_migrations_due
  ON control_tenant_placement_migrations(
    environment_id, migration_state, lease_expires_at, updated_at
  );

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_migration_identity_immutable
BEFORE UPDATE OF operation_id, environment_id, tenant_id, source_policy_generation,
                 target_policy_generation, source_isolation_policy, target_isolation_policy,
                 idempotency_key, created_by, created_at
ON control_tenant_placement_migrations
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_migration_transition_guard
BEFORE UPDATE OF migration_state ON control_tenant_placement_migrations
WHEN NOT (
  OLD.migration_state = NEW.migration_state OR
  (OLD.migration_state = 'planning' AND NEW.migration_state IN (
    'targets_provisioning', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'targets_provisioning' AND NEW.migration_state IN (
    'inventory_verifying', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'inventory_verifying' AND NEW.migration_state IN (
    'capture_installing', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'capture_installing' AND NEW.migration_state IN (
    'backfilling', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'backfilling' AND NEW.migration_state IN (
    'catching_up', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'catching_up' AND NEW.migration_state IN (
    'verifying', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'verifying' AND NEW.migration_state IN (
    'write_fencing', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'write_fencing' AND NEW.migration_state IN (
    'cutover_ready', 'verifying', 'canceled', 'blocked'
  )) OR
  (OLD.migration_state = 'cutover_ready' AND NEW.migration_state IN (
    'cutover_committed', 'write_fencing', 'blocked'
  )) OR
  (OLD.migration_state = 'cutover_committed' AND NEW.migration_state IN (
    'source_quarantined', 'blocked'
  )) OR
  (OLD.migration_state = 'source_quarantined' AND NEW.migration_state IN (
    'purge_pending', 'complete', 'blocked'
  )) OR
  (OLD.migration_state = 'purge_pending' AND NEW.migration_state IN ('complete', 'blocked')) OR
  (OLD.migration_state = 'blocked' AND NEW.migration_state IN (
    'targets_provisioning', 'inventory_verifying', 'capture_installing', 'backfilling',
    'catching_up', 'verifying', 'write_fencing', 'cutover_ready', 'cutover_committed',
    'source_quarantined', 'purge_pending', 'complete', 'canceled'
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_transition_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_migration_insert_guard
BEFORE INSERT ON control_tenant_placement_migrations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_policies policy
   WHERE policy.environment_id = NEW.environment_id
     AND policy.tenant_id = NEW.tenant_id
     AND policy.isolation_policy = 'shared_pool'
     AND policy.policy_generation = NEW.source_policy_generation
     AND policy.policy_state = 'active'
     AND policy.pending_isolation_policy IS NULL
     AND policy.migration_operation_id IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_source_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_policy_migration_start_guard
BEFORE UPDATE OF pending_isolation_policy, pending_policy_generation,
                 migration_operation_id, policy_state
ON control_tenant_placement_policies
WHEN OLD.pending_isolation_policy IS NULL AND NEW.pending_isolation_policy = 'tenant_exclusive'
  AND NOT EXISTS (
    SELECT 1
      FROM control_tenant_placement_migrations migration
     WHERE migration.operation_id = NEW.migration_operation_id
       AND migration.environment_id = NEW.environment_id
       AND migration.tenant_id = NEW.tenant_id
       AND migration.source_policy_generation = OLD.policy_generation
       AND migration.target_policy_generation = NEW.pending_policy_generation
       AND migration.migration_state IN ('planning', 'targets_provisioning')
  )
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_start_invalid');
END;

CREATE TABLE IF NOT EXISTS control_tenant_placement_migration_shards (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  data_role TEXT NOT NULL
    CHECK (data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii')),
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  source_assignment_generation INTEGER NOT NULL CHECK (source_assignment_generation >= 1),
  target_shard_id TEXT,
  target_assignment_generation INTEGER CHECK (target_assignment_generation >= 1),
  shard_state TEXT NOT NULL DEFAULT 'target_pending' CHECK (shard_state IN (
    'target_pending', 'inventory_pending', 'capture_pending', 'backfilling', 'catching_up', 'verifying',
    'verified', 'write_fenced', 'cutover_committed', 'quarantined', 'purged', 'blocked'
  )),
  table_cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(table_cursor_json)),
  source_row_count INTEGER CHECK (source_row_count IS NULL OR source_row_count >= 0),
  target_row_count INTEGER CHECK (target_row_count IS NULL OR target_row_count >= 0),
  source_checksum TEXT CHECK (source_checksum IS NULL OR length(source_checksum) = 64),
  target_checksum TEXT CHECK (target_checksum IS NULL OR length(target_checksum) = 64),
  last_observed_source_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (last_observed_source_sequence >= 0),
  last_applied_source_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (last_applied_source_sequence >= 0),
  capture_fencing_token INTEGER CHECK (capture_fencing_token IS NULL OR capture_fencing_token >= 1),
  inventory_table_count INTEGER CHECK (inventory_table_count IS NULL OR inventory_table_count >= 1),
  inventory_verified_at INTEGER,
  capture_installed_at INTEGER,
  backfill_completed_at INTEGER,
  verified_at INTEGER,
  write_fenced_at INTEGER,
  cutover_committed_at INTEGER,
  quarantined_at INTEGER,
  purged_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, source_shard_id),
  UNIQUE (operation_id, target_shard_id),
  FOREIGN KEY (operation_id)
    REFERENCES control_tenant_placement_migrations(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (source_shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id),
  FOREIGN KEY (target_shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id),
  CHECK (target_shard_id IS NULL OR source_shard_id <> target_shard_id),
  CHECK ((target_shard_id IS NULL AND target_assignment_generation IS NULL
          AND shard_state = 'target_pending') OR
         (target_shard_id IS NOT NULL AND target_assignment_generation IS NOT NULL)),
  CHECK (last_applied_source_sequence <= last_observed_source_sequence),
  CHECK ((shard_state IN ('verified', 'write_fenced', 'cutover_committed', 'quarantined', 'purged')
          AND verified_at IS NOT NULL AND source_row_count = target_row_count
          AND source_checksum = target_checksum) OR
         shard_state NOT IN ('verified', 'write_fenced', 'cutover_committed', 'quarantined', 'purged'))
);

CREATE INDEX IF NOT EXISTS idx_control_tenant_placement_migration_shards_state
  ON control_tenant_placement_migration_shards(operation_id, shard_state, data_role);

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_migration_shard_insert_guard
BEFORE INSERT ON control_tenant_placement_migration_shards
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_placement_migrations migration
    JOIN control_tenant_shard_assignments source_assignment
      ON source_assignment.environment_id = migration.environment_id
     AND source_assignment.tenant_id = migration.tenant_id
     AND source_assignment.data_role = NEW.data_role
     AND source_assignment.residency_policy_id = NEW.residency_policy_id
     AND source_assignment.residency_partition = NEW.residency_partition
     AND source_assignment.shard_id = NEW.source_shard_id
     AND source_assignment.assignment_generation = NEW.source_assignment_generation
     AND source_assignment.assignment_state = 'active'
    JOIN control_tenant_shards source
      ON source.environment_id = migration.environment_id
     AND source.shard_id = source_assignment.shard_id
     AND source.allocation_scope = 'shared_pool'
     AND source.owner_tenant_id IS NULL
   WHERE migration.operation_id = NEW.operation_id
     AND migration.environment_id = NEW.environment_id
     AND migration.tenant_id = NEW.tenant_id
     AND migration.migration_state NOT IN ('cutover_committed', 'source_quarantined',
                                            'purge_pending', 'complete', 'canceled')
     AND (
       (NEW.target_shard_id IS NULL AND NEW.target_assignment_generation IS NULL
        AND NEW.shard_state = 'target_pending') OR
       EXISTS (
         SELECT 1
           FROM control_tenant_shard_assignments target_assignment
           JOIN control_tenant_shards target
             ON target.environment_id = target_assignment.environment_id
            AND target.shard_id = target_assignment.shard_id
          WHERE target_assignment.environment_id = migration.environment_id
            AND target_assignment.tenant_id = migration.tenant_id
            AND target_assignment.data_role = NEW.data_role
            AND target_assignment.residency_policy_id = NEW.residency_policy_id
            AND target_assignment.residency_partition = NEW.residency_partition
            AND target_assignment.shard_id = NEW.target_shard_id
            AND target_assignment.assignment_generation = NEW.target_assignment_generation
            AND target_assignment.assignment_state = 'pending'
            AND target.allocation_scope = 'tenant_exclusive'
            AND target.owner_tenant_id = migration.tenant_id
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_shard_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_migration_shard_identity_immutable
BEFORE UPDATE OF operation_id, environment_id, tenant_id, data_role, residency_policy_id,
                 residency_partition, source_shard_id, source_assignment_generation, created_at
ON control_tenant_placement_migration_shards
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_shard_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_migration_target_update_guard
BEFORE UPDATE OF target_shard_id, target_assignment_generation, shard_state
ON control_tenant_placement_migration_shards
WHEN OLD.target_shard_id IS NULL AND NEW.target_shard_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM control_tenant_placement_migrations migration
      JOIN control_tenant_shard_assignments target_assignment
        ON target_assignment.environment_id = migration.environment_id
       AND target_assignment.tenant_id = migration.tenant_id
       AND target_assignment.data_role = NEW.data_role
       AND target_assignment.residency_policy_id = NEW.residency_policy_id
       AND target_assignment.residency_partition = NEW.residency_partition
       AND target_assignment.shard_id = NEW.target_shard_id
       AND target_assignment.assignment_generation = NEW.target_assignment_generation
       AND target_assignment.assignment_state = 'pending'
      JOIN control_tenant_shards target
        ON target.environment_id = target_assignment.environment_id
       AND target.shard_id = target_assignment.shard_id
       AND target.allocation_scope = 'tenant_exclusive'
       AND target.owner_tenant_id = migration.tenant_id
     WHERE migration.operation_id = NEW.operation_id
       AND migration.environment_id = NEW.environment_id
       AND migration.tenant_id = NEW.tenant_id
       AND NEW.shard_state = 'inventory_pending'
  )
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_target_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_migration_target_immutable
BEFORE UPDATE OF target_shard_id, target_assignment_generation
ON control_tenant_placement_migration_shards
WHEN OLD.target_shard_id IS NOT NULL
  AND (OLD.target_shard_id IS NOT NEW.target_shard_id OR
       OLD.target_assignment_generation IS NOT NEW.target_assignment_generation)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_target_immutable');
END;

CREATE TABLE IF NOT EXISTS control_tenant_placement_migration_inventory (
  operation_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN (
    'tenant_column', 'tenant_row', 'tenant_key', 'tenant_or_key', 'tenant_scope',
    'parent', 'shard_local', 'global_reference'
  )),
  disposition TEXT NOT NULL CHECK (disposition IN ('migrate', 'retain_target_local')),
  primary_key_json TEXT NOT NULL CHECK (json_valid(primary_key_json)),
  columns_json TEXT NOT NULL CHECK (json_valid(columns_json)),
  foreign_keys_json TEXT NOT NULL CHECK (json_valid(foreign_keys_json)),
  ownership_json TEXT NOT NULL CHECK (json_valid(ownership_json)),
  columns_digest TEXT NOT NULL CHECK (length(columns_digest) = 64),
  inventory_state TEXT NOT NULL CHECK (inventory_state IN ('verified', 'blocked')),
  error_code TEXT,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, source_shard_id, table_name),
  FOREIGN KEY (operation_id, source_shard_id)
    REFERENCES control_tenant_placement_migration_shards(operation_id, source_shard_id)
      ON DELETE CASCADE,
  CHECK ((inventory_state = 'blocked' AND error_code IS NOT NULL) OR
         (inventory_state = 'verified' AND error_code IS NULL))
);

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_migration_inventory_immutable
BEFORE UPDATE ON control_tenant_placement_migration_inventory
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_inventory_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_migration_inventory_no_delete
BEFORE DELETE ON control_tenant_placement_migration_inventory
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_inventory_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_migration_shard_inventory_guard
BEFORE UPDATE OF shard_state ON control_tenant_placement_migration_shards
WHEN NEW.shard_state IN (
  'capture_pending', 'backfilling', 'catching_up', 'verifying', 'verified',
  'write_fenced', 'cutover_committed', 'quarantined', 'purged'
) AND (
  NEW.inventory_verified_at IS NULL OR NEW.inventory_table_count IS NULL OR
  (SELECT COUNT(*)
     FROM control_tenant_placement_migration_inventory inventory
    WHERE inventory.operation_id = NEW.operation_id
      AND inventory.source_shard_id = NEW.source_shard_id
      AND inventory.inventory_state = 'verified') <> NEW.inventory_table_count OR
  EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_inventory inventory
     WHERE inventory.operation_id = NEW.operation_id
       AND inventory.source_shard_id = NEW.source_shard_id
       AND inventory.inventory_state = 'blocked'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_inventory_incomplete');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_migration_cutover_ready_guard
BEFORE UPDATE OF migration_state ON control_tenant_placement_migrations
WHEN NEW.migration_state = 'cutover_ready' AND (
  NEW.inventory_verified_at IS NULL OR NEW.inventory_digest IS NULL OR
  NEW.write_fence_state <> 'active' OR NEW.write_fence_started_at IS NULL OR
  NOT EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_shards shard
     WHERE shard.operation_id = NEW.operation_id
  ) OR
  NOT EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_shards shard
     WHERE shard.operation_id = NEW.operation_id
       AND shard.data_role = 'tenant_core/default'
  ) OR
  NOT EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_shards shard
     WHERE shard.operation_id = NEW.operation_id
       AND shard.data_role = 'tenant_core/users'
  ) OR
  NOT EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_shards shard
     WHERE shard.operation_id = NEW.operation_id
       AND shard.data_role = 'tenant_pii'
  ) OR
  EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_shards shard
     WHERE shard.operation_id = NEW.operation_id
       AND (
         shard.shard_state <> 'write_fenced' OR
         shard.last_applied_source_sequence <> shard.last_observed_source_sequence
       )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_cutover_not_ready');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_policy_migration_cutover_guard
BEFORE UPDATE OF isolation_policy ON control_tenant_placement_policies
WHEN OLD.isolation_policy = 'shared_pool' AND NEW.isolation_policy = 'tenant_exclusive'
  AND NOT EXISTS (
    SELECT 1
      FROM control_tenant_placement_migrations migration
     WHERE migration.operation_id = OLD.migration_operation_id
       AND migration.environment_id = OLD.environment_id
       AND migration.tenant_id = OLD.tenant_id
       AND migration.source_policy_generation = OLD.policy_generation
       AND migration.target_policy_generation = NEW.policy_generation
       AND migration.migration_state = 'cutover_ready'
       AND migration.write_fence_state = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_policy_migration_not_ready');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_placement_migration_cutover_commit_guard
BEFORE UPDATE OF migration_state ON control_tenant_placement_migrations
WHEN NEW.migration_state = 'cutover_committed' AND (
  NEW.write_fence_state <> 'active' OR NEW.cutover_committed_at IS NULL OR
  NOT EXISTS (
    SELECT 1 FROM control_tenant_placement_policies policy
     WHERE policy.environment_id = NEW.environment_id
       AND policy.tenant_id = NEW.tenant_id
       AND policy.isolation_policy = 'tenant_exclusive'
       AND policy.policy_generation = NEW.target_policy_generation
       AND policy.policy_state = 'active'
       AND policy.pending_isolation_policy IS NULL
       AND policy.migration_operation_id IS NULL
  ) OR
  EXISTS (
    SELECT 1 FROM control_tenant_placement_migration_shards shard
     WHERE shard.operation_id = NEW.operation_id
       AND shard.shard_state <> 'cutover_committed'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_placement_migration_cutover_commit_invalid');
END;

-- A placement cutover mutates Lookup routes under the shared directory rewrite lease. Once the
-- source is quarantined, the forward cutover is durable and the lease can be released without
-- pretending that a rollback was verified.
DROP TRIGGER IF EXISTS trg_control_directory_rewrite_delete;
CREATE TRIGGER trg_control_directory_rewrite_delete
BEFORE DELETE ON control_directory_rewrite_leases
WHEN OLD.mutation_started = 1
 AND NOT EXISTS (
   SELECT 1 FROM control_operations operation
    WHERE operation.operation_id = OLD.operation_id AND operation.status = 'succeeded'
 )
 AND NOT (
   OLD.operation_kind = 'tenant_placement_migration'
   AND EXISTS (
     SELECT 1 FROM control_tenant_placement_migrations migration
      WHERE migration.environment_id = OLD.environment_id
        AND migration.operation_id = OLD.operation_id
        AND migration.migration_state IN ('source_quarantined', 'purge_pending', 'complete')
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'control_directory_rewrite_delete_forbidden_after_mutation');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_shard_assignment_activation_guard
BEFORE UPDATE OF assignment_state ON control_tenant_shard_assignments
WHEN OLD.assignment_state = 'pending' AND NEW.assignment_state = 'active'
  AND NOT EXISTS (
    SELECT 1
      FROM control_tenant_placement_policies policy
      JOIN control_tenant_shards shard
        ON shard.environment_id = NEW.environment_id
       AND shard.shard_id = NEW.shard_id
     WHERE policy.environment_id = NEW.environment_id
       AND policy.tenant_id = NEW.tenant_id
       AND policy.policy_state = 'active'
       AND policy.isolation_policy = 'tenant_exclusive'
       AND shard.allocation_scope = 'tenant_exclusive'
       AND shard.owner_tenant_id = NEW.tenant_id
       AND shard.data_role = NEW.data_role
       AND shard.residency_policy_id = NEW.residency_policy_id
       AND shard.residency_partition = NEW.residency_partition
  )
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_shard_assignment_activation_invalid');
END;
