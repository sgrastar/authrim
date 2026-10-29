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
    expect(Object.keys(PHASE8_RESTORE_HOLD_RULES)).toHaveLength(48);
    expect(
      phase8RestoreHoldReason(
        'core.account_lifecycle_event_outbox',
        JSON.stringify({ id: text('row-a') })
      )
    ).toBe('source_outbox');
    expect(() =>
      phase8RestoreHoldReason('core.plugin_hook_outbox', JSON.stringify({ id: text('row-a') }))
    ).toThrow('backup_phase8_restore_hold_invalid');
  });

  it('never activates source Guest workflows or unfinished PII erasure on the target', () => {
    const lifecycle = (phase: string, finalized: readonly [string, string | null] = nil) =>
      JSON.stringify({ phase: text(phase), upgrade_finalized_at: finalized });
    for (const phase of ['upgrading', 'deleting', 'registered'])
      expect(phase8RestoreHoldReason('core.guest_account_lifecycle', lifecycle(phase))).toBe(
        'source_guest_workflow'
      );
    for (const phase of ['active', 'deleted'])
      expect(phase8RestoreHoldReason('core.guest_account_lifecycle', lifecycle(phase))).toBeNull();
    expect(
      phase8RestoreHoldReason(
        'core.guest_account_lifecycle',
        lifecycle('registered', ['integer', '100'])
      )
    ).toBeNull();
    expect(() =>
      phase8RestoreHoldReason('core.guest_account_lifecycle', lifecycle('registered', text('100')))
    ).toThrow('backup_phase8_restore_hold_invalid');
    expect(PHASE8_RESTORE_HOLD_RULES['core.guest_account_lifecycle']).toBeDefined();
    expect(
      phase8RestoreHoldReason(
        'pii.guest_pii_erasure_markers',
        JSON.stringify({ state: text('erasing') })
      )
    ).toBe('source_guest_erasure');
    expect(
      phase8RestoreHoldReason(
        'pii.guest_pii_erasure_markers',
        JSON.stringify({ state: text('deleted') })
      )
    ).toBeNull();
    expect(() =>
      phase8RestoreHoldReason(
        'pii.guest_pii_erasure_markers',
        JSON.stringify({ state: text('active') })
      )
    ).toThrow('backup_phase8_restore_hold_invalid');
  });

  it('never restores internal source receipts or uncommitted mapping intents as live work', () => {
    for (const status of ['pending', 'aborted'])
      expect(
        phase8RestoreHoldReason(
          'admin.identity_mapping_level_history',
          JSON.stringify({
            status: text(status),
          })
        )
      ).toBe('source_pending_mapping_history');
    expect(
      phase8RestoreHoldReason(
        'admin.identity_mapping_level_history',
        JSON.stringify({
          status: text('committed'),
        })
      )
    ).toBeNull();
    expect(
      phase8RestoreHoldReason(
        'core.idempotency_keys',
        JSON.stringify({
          id: text('__authrim_internal_identity_mapping_history_v1__:history-a'),
          method: text('PUT'),
        })
      )
    ).toBe('source_mapping_history_receipt');
    expect(
      phase8RestoreHoldReason(
        'core.idempotency_keys',
        JSON.stringify({
          id: text('http-id'),
          method: text('INTERNAL_IDENTITY_MAPPING_HISTORY'),
        })
      )
    ).toBe('source_mapping_history_receipt');
    expect(
      phase8RestoreHoldReason(
        'core.idempotency_keys',
        JSON.stringify({
          id: text('http-id'),
          method: text('PUT'),
        })
      )
    ).toBeNull();
  });
});
