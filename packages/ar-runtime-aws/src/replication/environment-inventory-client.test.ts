import { describe, expect, it, vi } from 'vitest';
import {
  replicationInventoryDigest,
  type EnvironmentReplicationInventory,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-inventory';
import { environmentTestConfiguration } from './environment-test-fixture';
import { readEnvironmentReplicationInventory } from './environment-inventory-client';
const configuration = environmentTestConfiguration('/synthetic/schema.sql', 'a'.repeat(64));
const now = 1900000000000;
async function inventory(): Promise<EnvironmentReplicationInventory> {
  const body = {
    formatVersion: 1 as const,
    complete: true as const,
    environmentId: 'env-a',
    pairId: 'pair-a',
    sourceDeploymentId: 'cf-a',
    writerCoverageSha256: 'c'.repeat(64),
    tenants: configuration.tenants.map((tenant) => ({
      tenantId: tenant.pair.tenantId,
      issuer: tenant.source.identity.issuer,
      productVersion: '0.4.2',
      lifecycleState: 'active',
      placementGeneration: 1,
    })),
  };
  return { ...body, observedAtMs: now, inventorySha256: await replicationInventoryDigest(body) };
}
async function pinned(value: EnvironmentReplicationInventory) {
  const { observedAtMs: _now, inventorySha256: _hash, ...body } = value;
  value.inventorySha256 = await replicationInventoryDigest(body);
  return value;
}
describe('authenticated complete source inventory client', () => {
  it('uses only the dedicated metadata grant and pins every configured tenant identity', async () => {
    const source = await inventory();
    const transport = vi.fn(async () => Response.json(source));
    expect(
      await readEnvironmentReplicationInventory({
        configuration,
        credential: 'b'.repeat(64),
        nowMs: now,
        fetch: transport as typeof fetch,
      })
    ).toEqual(source);
    expect(transport).toHaveBeenCalledWith(
      'https://management.example.test/api/replication-environments/inventory-a/inventory',
      expect.objectContaining({
        redirect: 'error',
        cache: 'no-store',
        headers: { Authorization: `Bearer ${'b'.repeat(64)}`, 'X-Tenant-Id': 'tenant-a' },
      })
    );
  });
  it.each([
    'missing',
    'extra',
    'wrong-pair',
    'wrong-environment',
    'wrong-source',
    'wrong-issuer',
    'wrong-version',
    'old',
    'future',
    'partial',
    'bad-digest',
  ])('rejects %s before a partial environment can be accepted', async (kind) => {
    const value = await inventory();
    if (kind === 'missing') value.tenants.pop();
    if (kind === 'extra')
      value.tenants.push({
        ...value.tenants[0],
        tenantId: 'tenant-c',
        issuer: 'https://tenant-c.example.test',
      });
    if (kind === 'wrong-pair') value.pairId = 'other-pair';
    if (kind === 'wrong-environment') value.environmentId = 'other-env';
    if (kind === 'wrong-source') value.sourceDeploymentId = 'other-source';
    if (kind === 'wrong-issuer') value.tenants[1].issuer = 'https://wrong.example.test';
    if (kind === 'wrong-version') value.tenants[1].productVersion = '0.4.1';
    if (kind === 'old') value.observedAtMs = now - 61000;
    if (kind === 'future') value.observedAtMs = now + 31000;
    if (kind === 'partial') Object.assign(value, { complete: false });
    await pinned(value);
    if (kind === 'bad-digest') value.inventorySha256 = 'f'.repeat(64);
    await expect(
      readEnvironmentReplicationInventory({
        configuration,
        credential: 'b'.repeat(64),
        nowMs: now,
        fetch: vi.fn(async () => Response.json(value)) as typeof fetch,
      })
    ).rejects.toThrow('environment_replication_inventory_unavailable');
  });
  it('rejects an inventory observed before the global drain', async () => {
    await expect(
      readEnvironmentReplicationInventory({
        configuration,
        credential: 'b'.repeat(64),
        nowMs: now,
        minimumObservedAtMs: now + 1,
        fetch: vi.fn(async () => Response.json(await inventory())) as typeof fetch,
      })
    ).rejects.toThrow();
  });
  it('cancels an oversized metadata response and emits no remote diagnostic', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65537));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readEnvironmentReplicationInventory({
        configuration,
        credential: 'b'.repeat(64),
        nowMs: now,
        fetch: vi.fn(async () => new Response(stream)) as typeof fetch,
      })
    ).rejects.toThrow('environment_replication_inventory_unavailable');
    expect(cancelled).toBe(true);
  });
});
