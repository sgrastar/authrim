import { describe, expect, it } from 'vitest';
import {
  PHASE8_RESTORE_HOLD_RULES,
  phase8RestoreHoldReason,
  phase8RestoreHoldRecordId,
} from '../phase8-restore-holds.js';

const text = (value: string) => ['text', value] as const;
const nil = ['null', null] as const;

describe('Phase 8 restored work holds', () => {
  it('holds runnable and dead-letter work while leaving completed history restorable', () => {
    const row = (column: string, value: readonly [string, string | null]) =>
      JSON.stringify({ id: text('row-a'), tenant_id: text('tenant-a'), [column]: value });
    expect(phase8RestoreHoldReason('core.plugin_hook_outbox', row('status', text('queued')))).toBe(
      'source_outbox'
    );
    expect(
      phase8RestoreHoldReason('core.plugin_hook_outbox', row('status', text('dead_letter')))
    ).toBe('source_outbox');
    expect(
      phase8RestoreHoldReason('core.plugin_hook_outbox', row('status', text('succeeded')))
    ).toBeNull();
    expect(
      phase8RestoreHoldReason('core.notification_delivery_intents', row('state', text('delivered')))
    ).toBe('source_delivery');
    expect(phase8RestoreHoldReason('pii.account_webhook_outbox', row('delivered_at', nil))).toBe(
      'source_outbox'
    );
    expect(
      phase8RestoreHoldReason('pii.account_webhook_outbox', row('delivered_at', ['integer', '100']))
    ).toBeNull();
  });

  it('holds linked workflow families as a unit and preserves composite identities', () => {
    const row = JSON.stringify({
      tenant_id: text('tenant-a'),
      idempotency_key: text('request-a'),
      execution_attempt: ['integer', '1'],
      execution_fence: ['integer', '2'],
    });
    expect(phase8RestoreHoldReason('admin.agent_management_executions', row)).toBe(
      'source_admin_workflow'
    );
    expect(
      phase8RestoreHoldRecordId(
        {
          table: 'agent_management_executions',
          columns: ['tenant_id', 'idempotency_key', 'execution_attempt', 'execution_fence'],
          primaryKey: ['tenant_id', 'idempotency_key', 'execution_attempt', 'execution_fence'],
          uniqueKeys: [],
          tenantColumn: 'tenant_id',
        },
        row
      )
    ).toBe(
      JSON.stringify([text('tenant-a'), text('request-a'), ['integer', '1'], ['integer', '2']])
    );
  });

  it('keeps a finite reviewed rule registry and rejects malformed discriminator fields', () => {
    expect(Object.keys(PHASE8_RESTORE_HOLD_RULES)).toHaveLength(42);
    expect(() =>
      phase8RestoreHoldReason(
        'core.account_lifecycle_event_outbox',
        JSON.stringify({ id: text('row-a') })
      )
    ).toThrow('backup_phase8_restore_hold_invalid');
  });
});
