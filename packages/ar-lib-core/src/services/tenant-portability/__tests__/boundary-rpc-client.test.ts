import { expect, it, vi } from 'vitest';
import { createTenantBackupBoundaryRpcClient } from '../boundary-rpc-client';
import type { TenantBackupBoundaryResponse } from '../boundary-rpc-contract';
const scope = {
  environmentId: 'env',
  tenantId: 'tenant',
  operationId: 'op',
  inventoryDigest: 'ab'.repeat(32),
};
const identity = { ...scope, boundaryId: 'cd'.repeat(32) };
const boundary = {
  id: identity.boundaryId,
  tenant_id: scope.tenantId,
  operation_id: scope.operationId,
  inventory_digest: scope.inventoryDigest,
  state: 'held' as const,
  created_at: 100,
  deadline_at: 2100,
  held_at: 101,
  released_at: null,
};
it('rejects a changed operation scope before sending and requires a usable binding', async () => {
  const send = vi.fn().mockResolvedValue({ environmentId: 'env', boundary: null, accepted: true });
  const client = createTenantBackupBoundaryRpcClient({ tenantBackupSnapshotBoundary: send }, scope);
  for (const override of [
    { environmentId: 'other' },
    { tenantId: 'other' },
    { operationId: 'other' },
    { inventoryDigest: 'ef'.repeat(32) },
  ])
    await expect(client.receipts.abort({ ...identity, ...override }, 100)).rejects.toThrow(
      'backup_boundary_rpc_invalid'
    );
  expect(send).not.toHaveBeenCalled();
  expect(() => createTenantBackupBoundaryRpcClient({}, scope)).toThrow(
    'backup_boundary_rpc_invalid'
  );
});
it('rejects wrong environment, identity, state and inconsistent deadline replies', async () => {
  const replies: TenantBackupBoundaryResponse[] = [
    { environmentId: 'other', boundary, accepted: true },
    { environmentId: 'env', boundary: { ...boundary, operation_id: 'other' }, accepted: true },
    { environmentId: 'env', boundary: { ...boundary, deadline_at: 2200 }, accepted: true },
    {
      environmentId: 'env',
      boundary: { ...boundary, state: 'released', released_at: 2100 },
      accepted: true,
    },
    { environmentId: 'env', boundary: null, accepted: true },
  ];
  for (const reply of replies) {
    const client = createTenantBackupBoundaryRpcClient(
      {
        async tenantBackupSnapshotBoundary() {
          return reply;
        },
      },
      scope
    );
    await expect(client.admission.hold('tenant', identity.boundaryId, 101)).rejects.toThrow(
      'backup_boundary_rpc_invalid'
    );
  }
});
