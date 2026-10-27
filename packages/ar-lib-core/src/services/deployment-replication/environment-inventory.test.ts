import { expect, it } from 'vitest';
import {
  assertEnvironmentSourceInventory,
  replicationInventoryDigest,
} from './environment-inventory';
async function fixture() {
  const body = {
    formatVersion: 1,
    complete: true,
    environmentId: 'test',
    pairId: 'pair-a',
    sourceDeploymentId: 'cf-a',
    writerCoverageSha256: 'a'.repeat(64),
    tenants: [
      {
        tenantId: 'tenant-a',
        issuer: 'https://a.example.test',
        productVersion: '0.4.2',
        lifecycleState: 'active',
        placementGeneration: 1,
      },
    ],
  };
  return { ...body, observedAtMs: 123, inventorySha256: await replicationInventoryDigest(body) };
}
it('verifies the complete sorted metadata inventory without observation time in its digest', async () => {
  const value = await fixture();
  expect(await assertEnvironmentSourceInventory(value)).toEqual(value);
  expect(await assertEnvironmentSourceInventory({ ...value, observedAtMs: 124 })).toMatchObject({
    observedAtMs: 124,
  });
});
it.each([
  'complete',
  'digest',
  'duplicate',
  'issuer',
  'lifecycle',
  'extra',
  'limit',
  'placement',
  'version',
] as const)('rejects %s inconsistency', async (kind) => {
  const value = await fixture();
  const raw: Record<string, unknown> = { ...value };
  if (kind === 'complete') raw.complete = false;
  if (kind === 'digest') raw.inventorySha256 = 'b'.repeat(64);
  if (kind === 'duplicate') raw.tenants = [...value.tenants, ...value.tenants];
  if (kind === 'issuer')
    raw.tenants = [{ ...value.tenants[0], issuer: 'https://a.example.test/path' }];
  if (kind === 'lifecycle') raw.tenants = [{ ...value.tenants[0], lifecycleState: 'suspended' }];
  if (kind === 'extra') raw.credentials = 'must-not-be-metadata';
  if (kind === 'limit')
    raw.tenants = Array.from({ length: 17 }, (_, i) => ({
      ...value.tenants[0],
      tenantId: `t${i}`,
    }));
  if (kind === 'placement') raw.tenants = [{ ...value.tenants[0], placementGeneration: 0 }];
  if (kind === 'version') raw.formatVersion = 2;
  await expect(assertEnvironmentSourceInventory(raw)).rejects.toThrow();
});
