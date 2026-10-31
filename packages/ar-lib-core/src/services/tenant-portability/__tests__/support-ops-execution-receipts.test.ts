import { describe, expect, it } from 'vitest';
import { TENANT_DATASET_POLICIES } from '../dataset-registry';
import { parseTenantBackupSelection, tenantDatasetSelectionRule } from '../selection-contract';
import { phase8RestoreHoldReason } from '../phase8-restore-holds';

describe('source-only Support Ops execution evidence', () => {
  it('excludes account result receipts even when every portable category is selected', () => {
    const policy = TENANT_DATASET_POLICIES.filter(
      ({ family, table }) => family === 'core' && table === 'support_ops_account_result_receipts'
    );
    expect(policy).toHaveLength(1);
    expect(policy[0]?.kind).toBe('ephemeral');
    const selected = parseTenantBackupSelection({
      settings: true,
      users: true,
      admin: true,
      logs: { audit: true, other: true, sensitive: true, period: 'all' },
      artifacts: true,
    });
    expect(tenantDatasetSelectionRule('ephemeral', selected)).toEqual({
      action: 'excluded',
      reason: 'ephemeral',
    });
  });
  it('holds Admin workflows and running Core actions instead of replaying source work', () => {
    expect(
      phase8RestoreHoldReason('admin.admin_jobs', JSON.stringify({ id: ['text', 'source-job'] }))
    ).toBe('source_admin_workflow');
    expect(
      phase8RestoreHoldReason(
        'core.support_operation_actions',
        JSON.stringify({ status: ['text', 'running'] })
      )
    ).toBe('source_support_operation');
    expect(
      phase8RestoreHoldReason(
        'core.support_operation_actions',
        JSON.stringify({ status: ['text', 'completed'] })
      )
    ).toBeNull();
  });
});
