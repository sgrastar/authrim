-- Promote a provisioned account shard into a tenant's active assignment set before the
-- currently selected shard is exhausted. Predictive provisioning can finish while the
-- current shard still has more than 20% headroom; without this transition, the spare remains
-- unassigned and the first request after exhaustion must take the capacity-retry path.
CREATE INDEX idx_control_account_allocations_pending_capacity
  ON control_tenant_shard_allocations(
    selected_shard_id, capacity_counted_at, tenant_id, data_role, residency_partition
  )
  WHERE capacity_counted_at IS NULL
    AND reservation_state IN ('reserved', 'committed');

CREATE TRIGGER trg_control_account_capacity_assigns_ready_spare
AFTER UPDATE OF allocated_account_count ON control_shard_capacity
WHEN NEW.allocated_account_count > OLD.allocated_account_count
 AND NEW.shard_id IN (
   SELECT shard.shard_id
     FROM control_tenant_shards shard
    WHERE shard.data_role IN ('tenant_core/users', 'tenant_pii')
 )
 AND (NEW.target_account_count - NEW.allocated_account_count) * 5 < NEW.target_account_count
BEGIN
  INSERT OR IGNORE INTO control_tenant_shard_assignments (
    environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
    shard_id, assignment_generation, assignment_state, source_operation_id,
    created_at, activated_at, updated_at
  )
  SELECT source.environment_id, source.tenant_id, source.data_role,
         source.residency_policy_id, source.residency_partition, spare.shard_id,
         COALESCE((
           SELECT MAX(existing.assignment_generation) + 1
             FROM control_tenant_shard_assignments existing
            WHERE existing.environment_id = source.environment_id
              AND existing.tenant_id = source.tenant_id
              AND existing.data_role = source.data_role
              AND existing.residency_partition = source.residency_partition
         ), 1),
         'active', desired.origin_operation_id,
         NEW.updated_at, NEW.updated_at, NEW.updated_at
    FROM control_tenant_shard_assignments source
    JOIN control_tenant_shard_allocations pending_allocation
      ON pending_allocation.environment_id = source.environment_id
     AND pending_allocation.tenant_id = source.tenant_id
     AND pending_allocation.data_role = source.data_role
     AND pending_allocation.residency_partition = source.residency_partition
     AND pending_allocation.selected_shard_id = source.shard_id
     AND pending_allocation.reservation_state IN ('reserved', 'committed')
     AND pending_allocation.capacity_counted_at IS NULL
    JOIN control_tenant_placement_policies placement
      ON placement.environment_id = source.environment_id
     AND placement.tenant_id = source.tenant_id
     AND placement.policy_state IN ('provisioning', 'active', 'migrating')
    JOIN control_tenant_shards current_shard
      ON current_shard.environment_id = source.environment_id
     AND current_shard.shard_id = source.shard_id
     AND current_shard.status = 'active'
    JOIN control_tenant_shards spare
      ON spare.environment_id = source.environment_id
     AND spare.data_role = source.data_role
     AND spare.residency_policy_id = source.residency_policy_id
     AND spare.residency_partition = source.residency_partition
     AND spare.status = 'active'
     AND spare.quarantine_state = 'none'
     AND spare.shard_id <> source.shard_id
    JOIN control_shard_capacity spare_capacity
      ON spare_capacity.shard_id = spare.shard_id
     AND spare_capacity.health_status = 'healthy'
     AND spare_capacity.allocation_status = 'eligible'
     AND spare_capacity.allocated_account_count < spare_capacity.target_account_count
    JOIN control_desired_resources desired
      ON desired.environment_id = spare.environment_id
     AND desired.desired_resource_id = spare.d1_desired_resource_id
     AND desired.desired_state = 'present'
     AND desired.provisioning_state = 'ready'
   WHERE source.shard_id = NEW.shard_id
     AND source.assignment_state = 'active'
     AND current_shard.data_role = source.data_role
     AND current_shard.residency_policy_id = source.residency_policy_id
     AND current_shard.residency_partition = source.residency_partition
     AND (
       (placement.isolation_policy = 'shared_pool'
        AND current_shard.allocation_scope = 'shared_pool'
        AND current_shard.owner_tenant_id IS NULL
        AND spare.allocation_scope = 'shared_pool'
        AND spare.owner_tenant_id IS NULL) OR
       (placement.isolation_policy = 'tenant_exclusive'
        AND current_shard.allocation_scope = 'tenant_exclusive'
        AND current_shard.owner_tenant_id = source.tenant_id
        AND spare.allocation_scope = 'tenant_exclusive'
        AND spare.owner_tenant_id = source.tenant_id)
     )
     AND NOT EXISTS (
       SELECT 1
         FROM control_tenant_shard_assignments existing_spare
        WHERE existing_spare.environment_id = source.environment_id
          AND existing_spare.tenant_id = source.tenant_id
          AND existing_spare.data_role = source.data_role
          AND existing_spare.residency_partition = source.residency_partition
          AND existing_spare.shard_id = spare.shard_id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM control_tenant_shard_assignments assigned
         JOIN control_tenant_shards assigned_shard
           ON assigned_shard.environment_id = assigned.environment_id
          AND assigned_shard.shard_id = assigned.shard_id
         JOIN control_shard_capacity assigned_capacity
           ON assigned_capacity.shard_id = assigned.shard_id
        WHERE assigned.environment_id = source.environment_id
          AND assigned.tenant_id = source.tenant_id
          AND assigned.data_role = source.data_role
          AND assigned.residency_policy_id = source.residency_policy_id
          AND assigned.residency_partition = source.residency_partition
          AND assigned.assignment_state = 'active'
          AND assigned.shard_id <> source.shard_id
          AND assigned_shard.status = 'active'
          AND assigned_shard.quarantine_state = 'none'
          AND assigned_capacity.health_status = 'healthy'
          AND assigned_capacity.allocation_status = 'eligible'
          AND (assigned_capacity.target_account_count -
               assigned_capacity.allocated_account_count) * 5 >=
              assigned_capacity.target_account_count
     )
     AND spare.shard_id = (
       SELECT candidate.shard_id
         FROM control_tenant_shards candidate
         JOIN control_shard_capacity candidate_capacity
           ON candidate_capacity.shard_id = candidate.shard_id
         JOIN control_desired_resources candidate_desired
           ON candidate_desired.environment_id = candidate.environment_id
          AND candidate_desired.desired_resource_id = candidate.d1_desired_resource_id
        WHERE candidate.environment_id = source.environment_id
          AND candidate.data_role = source.data_role
          AND candidate.residency_policy_id = source.residency_policy_id
          AND candidate.residency_partition = source.residency_partition
          AND candidate.status = 'active'
          AND candidate.quarantine_state = 'none'
          AND candidate_capacity.health_status = 'healthy'
          AND candidate_capacity.allocation_status = 'eligible'
          AND candidate_capacity.allocated_account_count < candidate_capacity.target_account_count
          AND candidate_desired.desired_state = 'present'
          AND candidate_desired.provisioning_state = 'ready'
          AND (
            (placement.isolation_policy = 'shared_pool'
             AND candidate.allocation_scope = 'shared_pool'
             AND candidate.owner_tenant_id IS NULL) OR
            (placement.isolation_policy = 'tenant_exclusive'
             AND candidate.allocation_scope = 'tenant_exclusive'
             AND candidate.owner_tenant_id = source.tenant_id)
          )
          AND NOT EXISTS (
            SELECT 1
              FROM control_tenant_shard_assignments existing_candidate
             WHERE existing_candidate.environment_id = source.environment_id
               AND existing_candidate.tenant_id = source.tenant_id
               AND existing_candidate.data_role = source.data_role
               AND existing_candidate.residency_partition = source.residency_partition
               AND existing_candidate.shard_id = candidate.shard_id
          )
        ORDER BY (1.0 * candidate_capacity.allocated_account_count /
                  candidate_capacity.target_account_count),
                 candidate_capacity.allocated_account_count,
                 candidate.shard_id
        LIMIT 1
     );
END;
