-- Allow failed pre-activation shards to use the audited quarantine/cleanup workflow.
-- Active assignments, allocations, and runtime routes remain hard blockers.

DROP TRIGGER IF EXISTS trg_control_shard_quarantine_insert_guard;

CREATE TRIGGER trg_control_shard_quarantine_insert_guard
BEFORE INSERT ON control_shard_quarantine_operations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_tenant_shards shard
    JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
   WHERE shard.shard_id = NEW.shard_id
     AND shard.environment_id = NEW.environment_id
     AND shard.status IN ('failed', 'retired')
     AND shard.quarantine_state = 'none'
     AND capacity.allocation_status IN ('draining', 'blocked')
     AND NOT EXISTS (
       SELECT 1 FROM control_tenant_shard_assignments assignment
        WHERE assignment.shard_id = shard.shard_id
          AND assignment.assignment_state IN ('pending', 'active')
     )
     AND NOT EXISTS (
       SELECT 1 FROM control_tenant_shard_allocations allocation
        WHERE allocation.selected_shard_id = shard.shard_id
          AND allocation.reservation_state IN ('reserved', 'committed')
     )
     AND NOT EXISTS (
       SELECT 1 FROM control_tenant_default_allocations allocation
        WHERE allocation.selected_shard_id = shard.shard_id
          AND allocation.reservation_state IN ('reserved', 'committed')
     )
     AND NOT EXISTS (
       SELECT 1 FROM control_runtime_registry_routes route
        WHERE route.environment_id = shard.environment_id
          AND (
            json_extract(route.route_projection_json, '$.target.shardId') = shard.shard_id OR
            EXISTS (
              SELECT 1 FROM json_each(route.route_projection_json, '$.targets') target
               WHERE json_extract(target.value, '$.shardId') = shard.shard_id
            )
          )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_quarantine_precondition_failed');
END;

DROP TRIGGER IF EXISTS trg_control_shard_cleanup_insert_guard;

CREATE TRIGGER trg_control_shard_cleanup_insert_guard
BEFORE INSERT ON control_shard_cleanup_operations
WHEN NOT EXISTS (
  SELECT 1
    FROM control_shard_quarantine_operations quarantine
    JOIN control_tenant_shards shard
      ON shard.shard_id = quarantine.shard_id
     AND shard.environment_id = quarantine.environment_id
   WHERE quarantine.operation_id = NEW.quarantine_operation_id
     AND quarantine.environment_id = NEW.environment_id
     AND quarantine.shard_id = NEW.shard_id
     AND quarantine.state = 'ready_for_cleanup'
     AND shard.status IN ('failed', 'retired')
     AND shard.quarantine_state = 'quarantined'
)
BEGIN
  SELECT RAISE(ABORT, 'control_shard_cleanup_quarantine_required');
END;
