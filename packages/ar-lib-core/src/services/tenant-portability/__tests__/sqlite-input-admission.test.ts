import { describe, expect, it, vi } from 'vitest';
import type { TenantBackupStepContext } from '../operation-executor';
import { inspectSqliteInputRow } from '../sqlite-input-inspection';
import {
  sqliteDatasetInspectionPolicyDescriptor,
  cloneSqliteDatasetInspectionPolicy,
  TENANT_BACKUP_RESTORE_AUTHORITY_REQUIRED,
  type SqliteDatasetInspectionPolicy,
} from '../sqlite-dataset-inspector';

const dataset = {
  id: 'core.clients',
  module: 'applications' as const,
  kind: 'settings' as const,
  store: 'database' as const,
  schemaVersion: 1,
  disposition: 'include' as const,
};
const manifest = {
  formatVersion: 1 as const,
  bundleId: 'ab'.repeat(16),
  source: { tenantId: 'tenant', issuer: 'https://issuer.example', productVersion: '0.4.2' },
  snapshotId: 'snapshot',
  boundaryUnixMs: 10,
  inventoryDigestSha256: '12'.repeat(32),
  selection: {
    settings: true,
    users: false,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
  },
  datasets: [dataset],
};
const context = {
  lease: { tenantId: 'tenant', operationId: 'operation', owner: 'worker', fencingToken: 1 },
} as unknown as TenantBackupStepContext;
const rowJson = '{"client_id":["text","client"],"tenant_id":["text","tenant"]}';

function policy(admit: (context: TenantBackupStepContext, rowJson: string) => Promise<void>) {
  return {
    dataset,
    schema: {
      table: 'oauth_clients',
      columns: ['client_id', 'tenant_id'],
      primaryKey: ['client_id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    inspectRow: vi.fn(async () => []),
    admitRow: { id: 'test-admission-v1', admit: vi.fn(admit) },
  } satisfies SqliteDatasetInspectionPolicy;
}

function index() {
  return { recordOnce: vi.fn(async () => true), referenceOnce: vi.fn(async () => {}) };
}

describe('SQL input row admission', () => {
  it('admits every validated row for the validating operation before recording it', async () => {
    const admitted = policy(async () => {});
    const records = index();
    await inspectSqliteInputRow({
      context,
      policy: admitted,
      manifest,
      rowJson,
      rowOrdinal: 0,
      index: records,
      assertPinnedInput: async () => {},
    });
    expect(admitted.admitRow.admit).toHaveBeenCalledWith(context, rowJson);
    expect(records.recordOnce).toHaveBeenCalled();
  });

  it('stops validation on a refused row before anything about it is recorded', async () => {
    const refused = policy(async () => {
      throw new Error(TENANT_BACKUP_RESTORE_AUTHORITY_REQUIRED);
    });
    const records = index();
    await expect(
      inspectSqliteInputRow({
        context,
        policy: refused,
        manifest,
        rowJson,
        rowOrdinal: 0,
        index: records,
        assertPinnedInput: async () => {},
      })
    ).rejects.toThrow(TENANT_BACKUP_RESTORE_AUTHORITY_REQUIRED);
    expect(records.recordOnce).not.toHaveBeenCalled();
    expect(records.referenceOnce).not.toHaveBeenCalled();
    expect(refused.inspectRow).not.toHaveBeenCalled();
  });

  it('pins the admission into the policy digest and keeps it when cloned', async () => {
    const admitted = policy(async () => {});
    expect(sqliteDatasetInspectionPolicyDescriptor(admitted).admitRowId).toBe('test-admission-v1');
    const clone = cloneSqliteDatasetInspectionPolicy(admitted);
    await clone.admitRow?.admit(context, rowJson);
    expect(admitted.admitRow.admit).toHaveBeenCalledWith(context, rowJson);
  });
});
