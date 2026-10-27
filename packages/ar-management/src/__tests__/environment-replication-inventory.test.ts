import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  readEnvironmentReplicationInventory,
  assertReplicationEnvironmentTenant,
} from '../environment-replication-inventory';
const state = vi.hoisted(() => ({
  rows: vi.fn(),
  one: vi.fn(),
  pending: vi.fn(),
  issuer: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  createD1Adapter: () => ({ query: state.rows, queryOne: state.one }),
  requireDedicatedAdminDatabaseAdapter: () => ({ queryOne: state.pending }),
}));
vi.mock('../request-issuer', () => ({ getCanonicalTenantBaseUrlAsync: state.issuer }));
const writer = {
  version: 2,
  endpoint: 'https://authority.example.test/replication/v1/rpc',
  credentialId: 'writer',
  pairId: 'pair-a',
  environmentId: 'test',
  deploymentId: 'cf-a',
  epoch: 1,
  generationId: 'initial',
};
const control = vi.fn();
const coverage = vi.fn();
const placement = vi.fn();
const env = {
  AUTHRIM_ENVIRONMENT_NAME: 'test',
  AUTHRIM_REPLICATION_WRITER: JSON.stringify(writer),
  CONTROL: {
    getEnvironmentReplicationInventory: control,
    inspectSamlDrWriterCoverage: coverage,
    getTenantPlacementPolicy: placement,
  },
} as unknown as Env;
beforeEach(() => {
  vi.resetAllMocks();
  state.rows.mockResolvedValue([
    { id: 'tenant-a', lifecycle_state: 'active' },
    { id: 'tenant-b', lifecycle_state: 'active' },
  ]);
  state.one.mockResolvedValue({ id: 'tenant-a', lifecycle_state: 'active' });
  state.pending.mockResolvedValue(null);
  state.issuer.mockImplementation(
    async (_env: unknown, id: string) => `https://${id}.example.test`
  );
  coverage.mockResolvedValue({ inventoryDigest: 'a'.repeat(64) });
  placement.mockResolvedValue({ tenantId: 'tenant-a', state: 'active' });
  control.mockResolvedValue({
    environmentId: 'test',
    complete: true,
    pendingOperations: false,
    tenants: [
      { tenantId: 'tenant-a', policyState: 'active', policyGeneration: 1 },
      { tenantId: 'tenant-b', policyState: 'active', policyGeneration: 2 },
    ],
  });
});
it('returns every canonical tenant with stable digest and no user rows', async () => {
  const first = await readEnvironmentReplicationInventory(env);
  const second = await readEnvironmentReplicationInventory(env);
  expect(first.tenants.map((t) => t.tenantId)).toEqual(['tenant-a', 'tenant-b']);
  expect(first.inventorySha256).toBe(second.inventorySha256);
  expect(first.complete).toBe(true);
  expect(state.rows.mock.calls[0][0]).toContain("lifecycle_state IS NOT 'deleted'");
});
it.each([
  'new-operation',
  'missing-placement',
  'orphan-placement',
  'migration',
  'suspended',
  'limit',
  'duplicate-issuer',
  'wrong-environment',
])('blocks %s rather than omit a tenant', async (kind) => {
  if (kind === 'new-operation')
    state.pending.mockResolvedValue({ operation_id: 'pending-created-before-directory-row' });
  if (kind === 'missing-placement')
    control.mockResolvedValue({
      environmentId: 'test',
      complete: true,
      pendingOperations: false,
      tenants: [],
    });
  if (kind === 'orphan-placement')
    control.mockResolvedValue({
      environmentId: 'test',
      complete: true,
      pendingOperations: false,
      tenants: [{ tenantId: 'tenant-a' }, { tenantId: 'orphan' }],
    });
  if (kind === 'migration')
    control.mockResolvedValue({
      environmentId: 'test',
      complete: true,
      pendingOperations: true,
      tenants: [],
    });
  if (kind === 'suspended')
    state.rows.mockResolvedValue([{ id: 'tenant-a', lifecycle_state: 'suspended' }]);
  if (kind === 'limit')
    state.rows.mockResolvedValue(
      Array.from({ length: 17 }, (_, i) => ({ id: `tenant-${i}`, lifecycle_state: 'active' }))
    );
  if (kind === 'duplicate-issuer') state.issuer.mockResolvedValue('https://same.example.test');
  if (kind === 'wrong-environment')
    control.mockResolvedValue({
      environmentId: 'other',
      complete: true,
      pendingOperations: false,
      tenants: [],
    });
  await expect(readEnvironmentReplicationInventory(env)).rejects.toThrow();
});
it('tenant export membership checks both canonical identity and active Control placement', async () => {
  await expect(assertReplicationEnvironmentTenant(env, 'tenant-a')).resolves.toBeUndefined();
  await expect(assertReplicationEnvironmentTenant(env, 'tenant-b')).rejects.toThrow();
  placement.mockResolvedValue({ tenantId: 'tenant-a', state: 'migrating' });
  await expect(assertReplicationEnvironmentTenant(env, 'tenant-a')).rejects.toThrow();
});
it('excludes retained Control history only after proving the canonical deleted tombstone', async () => {
  control.mockResolvedValue({
    environmentId: 'test',
    complete: true,
    pendingOperations: false,
    tenants: [
      { tenantId: 'old-deleted', policyState: 'active', policyGeneration: 1 },
      { tenantId: 'tenant-a', policyState: 'active', policyGeneration: 1 },
      { tenantId: 'tenant-b', policyState: 'active', policyGeneration: 2 },
    ],
  });
  state.one.mockResolvedValue({ id: 'old-deleted', lifecycle_state: 'deleted' });
  expect(
    (await readEnvironmentReplicationInventory(env)).tenants.map((row) => row.tenantId)
  ).toEqual(['tenant-a', 'tenant-b']);
  state.one.mockResolvedValue({ id: 'old-deleted', lifecycle_state: 'active' });
  await expect(readEnvironmentReplicationInventory(env)).rejects.toThrow('inventory_mismatch');
});
