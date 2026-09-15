import { beforeEach, expect, it, vi } from 'vitest';
import { TenantBackupOperationReadModel } from '../tenant-backup-operation-read-model';

const state = vi.hoisted(() => ({
  operation: null as Record<string, unknown> | null,
  intent: null as Record<string, unknown> | null,
}));

vi.mock('@authrim/ar-lib-core/services/tenant-portability/operation-store', () => ({
  TenantBackupOperationStore: class {
    async get() {
      return state.operation;
    }
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/operation-request', () => ({
  TenantBackupRequestStore: class {
    async load() {
      return state.intent;
    }
  },
}));

const digest = 'ab'.repeat(32);
const preview = {
  version: 1,
  planDigest: digest,
  prerequisites: [],
  deliverySafety: {
    version: 1,
    sourceEnvironment: 'stopped',
    historicalDelivery: 'hold',
    scheduledCatchup: 'disabled',
    activation: 'new_events_only',
  },
  blockers: [],
};

beforeEach(() => {
  state.operation = {
    id: 'operation-a',
    tenant_id: 'tenant-a',
    kind: 'import',
    state: 'waiting',
    phase: 'await_restore_approval',
    revision: 7,
    created_at: 100,
    updated_at: 200,
    last_error_code: null,
    cursor_json: JSON.stringify({
      version: 1,
      planDigest: digest,
      restoreCursor: { version: 1, sequenceOrdinal: 0 },
      preview,
    }),
    request_digest: 'PRIVATE',
    lease_owner: 'PRIVATE',
  };
  state.intent = {
    kind: 'import',
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
    },
  };
});

function database(
  planDigest = digest,
  datasets = [
    { dataset_id: 'admin.clients', record_count: 2 },
    { dataset_id: 'core.tenant_settings', record_count: 1 },
  ]
) {
  return {
    query: vi.fn(async (sql: string) =>
      sql.includes('tenant_backup_dataset_inspections') ? datasets : [state.operation]
    ),
    queryOne: vi.fn(async (sql: string) => {
      if (sql.includes('tenant_backup_publications')) return null;
      if (sql.includes('tenant_backup_restore_plan_inventories'))
        return { state: 'sealed', item_count: 2, chain_digest: planDigest };
      return state.operation;
    }),
    execute: vi.fn(async () => ({ rowsAffected: 0 })),
  };
}

it('returns a secret-free restore preview with durable dataset totals', async () => {
  const model = new TenantBackupOperationReadModel(database() as never);
  const result = await model.get('tenant-a', 'operation-a', 300);
  expect(result?.view.preview).toEqual({
    planDigest: digest,
    datasetCount: 2,
    recordCount: 3,
    datasets: [
      { datasetId: 'admin.clients', recordCount: 2 },
      { datasetId: 'core.tenant_settings', recordCount: 1 },
    ],
    prerequisites: [],
    deliverySafety: preview.deliverySafety,
    blockers: [],
    canApprove: true,
  });
  const json = JSON.stringify(result?.view);
  expect(json).not.toContain('PRIVATE');
  expect(json).not.toContain('restoreCursor');
});

it('fails closed when the persisted preview no longer matches the sealed plan', async () => {
  const model = new TenantBackupOperationReadModel(database('cd'.repeat(32)) as never);
  await expect(model.get('tenant-a', 'operation-a', 300)).rejects.toThrow(
    'backup_restore_preview_stale'
  );
});

it('fails closed on malformed persisted dataset totals', async () => {
  const model = new TenantBackupOperationReadModel(
    database(digest, [{ dataset_id: '../private', record_count: -1 }]) as never
  );
  await expect(model.get('tenant-a', 'operation-a', 300)).rejects.toThrow(
    'backup_restore_preview_invalid'
  );
});
