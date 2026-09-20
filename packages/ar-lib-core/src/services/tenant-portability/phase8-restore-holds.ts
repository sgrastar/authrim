import type { CaptureSchema } from './sqlite-snapshot';
import type { PortableSqliteRow } from './sqlite-dataset-inspector';

type HoldRule =
  | { reason: string; all: true }
  | { reason: string; column: string; holdValues: readonly string[] }
  | { reason: string; column: string; holdWhenNull: true };

/**
 * Source work that can cause an external effect or continue a source-only authentication flow.
 * Completed native history is restored where a reliable terminal state exists. Workflow families
 * with parent/child execution state are held as a unit so no child can become runnable by itself.
 */
export const PHASE8_RESTORE_HOLD_RULES: Readonly<Record<string, HoldRule>> = {
  'core.account_creation_operations': {
    reason: 'source_account_workflow',
    column: 'status',
    holdValues: ['preparing', 'reserved', 'writing', 'directory_pending', 'blocked'],
  },
  // The insert trigger only permits the initial pending state. Terminal source events remain
  // encrypted evidence instead of being replayed or rewritten into a live target outbox.
  'core.account_lifecycle_event_outbox': { reason: 'source_outbox', all: true },
  'core.account_webhook_outbox': {
    reason: 'source_outbox',
    column: 'delivered_at',
    holdWhenNull: true,
  },
  'core.guest_deletion_audit_outbox': {
    reason: 'source_outbox',
    column: 'status',
    holdValues: ['pending', 'retry'],
  },
  'core.internal_notification_delivery_attempts': {
    reason: 'source_delivery',
    column: 'status',
    holdValues: ['queued', 'failed', 'dead_letter'],
  },
  'core.internal_notification_events': {
    reason: 'source_delivery',
    column: 'status',
    holdValues: ['pending', 'failed', 'dead_letter'],
  },
  // The table only permits terminal states through a live pending->terminal transition. Restored
  // source deliveries therefore remain encrypted operator evidence and never enter a runnable table.
  'core.notification_delivery_intents': { reason: 'source_delivery', all: true },
  'core.plugin_hook_outbox': {
    reason: 'source_outbox',
    column: 'status',
    holdValues: ['queued', 'locked', 'waiting_retry', 'dead_letter'],
  },
  'core.tenant_invitations': { reason: 'source_invitation', all: true },
  'core.webhook_deliveries': {
    reason: 'source_delivery',
    column: 'status',
    holdValues: ['pending', 'retrying', 'failed'],
  },
  'pii.account_webhook_outbox': {
    reason: 'source_outbox',
    column: 'delivered_at',
    holdWhenNull: true,
  },
  'pii.external_identifier_unlink_operations': {
    reason: 'source_identity_workflow',
    column: 'state',
    holdValues: ['pending', 'directory_pending', 'blocked'],
  },
  'pii.guest_upgrade_operations': {
    reason: 'source_authentication_workflow',
    column: 'state',
    holdValues: ['awaiting_proof', 'verified', 'committing'],
  },
  'pii.identity_identifier_replacement_challenges': {
    reason: 'source_authentication_challenge',
    column: 'consumed_at',
    holdWhenNull: true,
  },
  'pii.identity_identifier_replacement_operations': {
    reason: 'source_identity_workflow',
    column: 'state',
    holdValues: [
      'directory_pending',
      'authoritative_switch_pending',
      'authoritative_switched',
      'revocation_pending',
      'blocked_forward_repair',
    ],
  },
  'admin.admin_agent_token_revocation_outbox': {
    reason: 'source_outbox',
    column: 'status',
    holdValues: ['pending', 'processing', 'dead_letter'],
  },
  'admin.admin_external_token_refresh_runs': { reason: 'source_admin_workflow', all: true },
  'admin.admin_external_token_refresh_tenant_runs': {
    reason: 'source_admin_workflow',
    all: true,
  },
  'admin.admin_invitations': { reason: 'source_invitation', all: true },
  'admin.admin_jobs': { reason: 'source_admin_workflow', all: true },
  'admin.agent_bulk_plans': { reason: 'source_admin_workflow', all: true },
  'admin.agent_bulk_tenant_executions': { reason: 'source_admin_workflow', all: true },
  'admin.agent_configuration_plan_steps': { reason: 'source_admin_workflow', all: true },
  'admin.agent_configuration_plans': { reason: 'source_admin_workflow', all: true },
  'admin.agent_management_executions': { reason: 'source_admin_workflow', all: true },
  'admin.agent_plan_confirmations': { reason: 'source_admin_workflow', all: true },
  'admin.approval_request_approvals': { reason: 'source_approval_workflow', all: true },
  'admin.approval_requests': { reason: 'source_approval_workflow', all: true },
  'admin.blind_index_rotation_jobs': { reason: 'source_admin_workflow', all: true },
  'admin.internal_notification_delivery_attempts': {
    reason: 'source_delivery',
    column: 'status',
    holdValues: ['queued', 'failed', 'dead_letter'],
  },
  'admin.internal_notification_events': {
    reason: 'source_delivery',
    column: 'status',
    holdValues: ['pending', 'failed', 'dead_letter'],
  },
  'admin.logging_catalog_repair_jobs': { reason: 'source_logging_workflow', all: true },
  'admin.logging_dlq_items': {
    reason: 'source_dlq',
    column: 'status',
    holdValues: ['open'],
  },
  'admin.logging_export_jobs': { reason: 'source_logging_workflow', all: true },
  'admin.logging_message_export_builds': { reason: 'source_logging_workflow', all: true },
  'admin.logging_message_jobs': { reason: 'source_logging_workflow', all: true },
  'admin.logging_message_repair_findings': { reason: 'source_logging_workflow', all: true },
  'admin.logging_rewrap_jobs': { reason: 'source_logging_workflow', all: true },
  'admin.replay_jobs': { reason: 'source_admin_workflow', all: true },
  'admin.review_task_groups': { reason: 'source_approval_workflow', all: true },
  'admin.review_tasks': { reason: 'source_approval_workflow', all: true },
  'admin.rewrap_jobs': { reason: 'source_admin_workflow', all: true },
};

function parsed(rowJson: string): PortableSqliteRow {
  let value: unknown;
  try {
    value = JSON.parse(rowJson);
  } catch {
    throw new Error('backup_phase8_restore_hold_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('backup_phase8_restore_hold_invalid');
  return value as PortableSqliteRow;
}

/** Return a stable reason only when this row must stay outside the live target table. */
export function phase8RestoreHoldReason(datasetId: string, rowJson: string): string | null {
  const rule = PHASE8_RESTORE_HOLD_RULES[datasetId];
  if (!rule) return null;
  if ('all' in rule) return rule.reason;
  const value = parsed(rowJson)[rule.column];
  if (!value || value.length !== 2) throw new Error('backup_phase8_restore_hold_invalid');
  if ('holdWhenNull' in rule) return value[0] === 'null' && value[1] === null ? rule.reason : null;
  if (value[0] !== 'text' || value[1] === null)
    throw new Error('backup_phase8_restore_hold_invalid');
  return rule.holdValues.includes(value[1]) ? rule.reason : null;
}

/** Canonical source primary key retained with the encrypted held row. */
export function phase8RestoreHoldRecordId(schema: CaptureSchema, rowJson: string): string {
  const row = parsed(rowJson);
  const values = schema.primaryKey.map((column) => {
    const value = row[column];
    if (!value || value[0] === 'null' || value[1] === null)
      throw new Error('backup_phase8_restore_hold_invalid');
    return value;
  });
  const encoded = JSON.stringify(values);
  if (!values.length || encoded.length > 4096)
    throw new Error('backup_phase8_restore_hold_invalid');
  return encoded;
}
