import type { D1Database } from '@cloudflare/workers-types';

interface PendingPluginOperationRow {
  operation_id: string;
  environment_id: string;
  operation_kind: 'provision_plugin_resources' | 'cleanup_plugin_resources';
}

type PluginResourceKind = 'd1' | 'kv_namespace' | 'r2_bucket';

export async function handoffPluginResourceOperationsToSetup(
  database: D1Database,
  now: number,
  options: { limit?: number; resourceKinds?: readonly PluginResourceKind[] } = {}
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const resourceKinds = options.resourceKinds
    ? [...new Set(options.resourceKinds)].sort()
    : undefined;
  if (resourceKinds?.length === 0) return 0;
  const kindPlaceholders = resourceKinds?.map(() => '?').join(', ') ?? '';
  const resourceFilter = resourceKinds
    ? `AND (
        (operation_kind = 'provision_plugin_resources' AND EXISTS (
          SELECT 1 FROM control_plugin_desired_resources resource
           WHERE resource.operation_id = control_operations.operation_id
             AND resource.environment_id = control_operations.environment_id
             AND resource.resource_kind IN (${kindPlaceholders})
             AND resource.status IN ('pending', 'provisioning', 'failed')
        )) OR
        (operation_kind = 'cleanup_plugin_resources' AND EXISTS (
          SELECT 1 FROM control_plugin_resource_cleanup_items item
           WHERE item.operation_id = control_operations.operation_id
             AND item.resource_kind IN (${kindPlaceholders})
             AND item.state IN ('pending', 'quarantined', 'deleting', 'blocked')
        ))
      )`
    : '';
  const candidates = await database
    .prepare(
      `SELECT operation_id, environment_id, operation_kind
         FROM control_operations
        WHERE operation_kind IN ('provision_plugin_resources', 'cleanup_plugin_resources')
          AND status IN ('queued', 'waiting_retry')
          AND (lock_owner IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?)
          ${resourceFilter}
          AND EXISTS (
            SELECT 1 FROM control_operation_steps step
             WHERE step.operation_id = control_operations.operation_id
               AND step.status IN ('queued', 'waiting_retry')
          )
        ORDER BY created_at, operation_id
        LIMIT ?`
    )
    .bind(now, ...(resourceKinds ?? []), ...(resourceKinds ?? []), boundedLimit)
    .all<PendingPluginOperationRow>();

  let handedOff = 0;
  for (const candidate of candidates.results) {
    const eventId = `audit_plugin_operator_handoff_${candidate.operation_id.slice(-48)}`;
    const results = await database.batch([
      database
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'blocked', next_attempt_at = NULL,
                  last_error_code = 'operator_action_required',
                  last_error_redacted = 'operator_action_required', updated_at = ?
            WHERE operation_id = ?
              AND step_key = (
                SELECT step_key FROM control_operation_steps
                 WHERE operation_id = ? AND status IN ('queued', 'waiting_retry')
                 ORDER BY display_order, step_key LIMIT 1
              )
              AND status IN ('queued', 'waiting_retry')`
        )
        .bind(now, candidate.operation_id, candidate.operation_id),
      database
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', next_attempt_at = NULL,
                  last_error_code = 'operator_action_required',
                  last_error_redacted = 'operator_action_required', updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND operation_kind = ?
              AND status IN ('queued', 'waiting_retry')
              AND EXISTS (
                SELECT 1 FROM control_operation_steps step
                 WHERE step.operation_id = control_operations.operation_id
                   AND step.status = 'blocked'
                   AND step.last_error_code = 'operator_action_required'
              )`
        )
        .bind(now, candidate.operation_id, candidate.environment_id, candidate.operation_kind),
      database
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           )
           SELECT ?, environment_id, operation_id, 'plugin.resources.operator_handoff',
                  'worker', 'ar-control', 'plugin_resource_operation', operation_id,
                  'succeeded', ?, ?
             FROM control_operations
            WHERE operation_id = ? AND environment_id = ?
              AND status = 'blocked' AND last_error_code = 'operator_action_required'`
        )
        .bind(
          eventId,
          JSON.stringify({
            reason: 'operator_action_required',
            operationKind: candidate.operation_kind,
          }),
          now,
          candidate.operation_id,
          candidate.environment_id
        ),
    ]);
    if (Number(results[1]?.meta?.changes ?? 0) === 1) handedOff += 1;
  }
  return handedOff;
}
