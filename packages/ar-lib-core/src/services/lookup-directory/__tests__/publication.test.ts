import { describe, expect, it, vi } from 'vitest';
import { createLookupBlindIndex } from '../blind-index';
import {
  accountDirectoryOutboxId,
  markAccountDirectoryPublicationReady,
  validateAccountDirectoryPublication,
} from '../publication';

const key = { generation: 1, secret: '0123456789abcdef0123456789abcdef' };
const routeProjection = {
  schemaVersion: 1,
  accountRouteGeneration: 1,
  residencyPolicyId: 'default-policy',
  targets: [
    {
      dataRole: 'tenant_core/users' as const,
      residencyPartition: 'default',
      shardId: 'users-1',
      bindingRef: 'TDB_USERS_1',
      requiredBindingRouteGeneration: 1,
    },
  ],
};

async function publication() {
  return {
    operationId: 'operation-1',
    tenantId: 'tenant-a',
    accountId: 'account-a',
    routeProjection,
    idempotencyKey: 'publish-account-a',
    indexes: [await createLookupBlindIndex('account_id', 'account-a', key)],
  };
}

describe('account directory publication contract', () => {
  it('accepts blind-index-only publication data', async () => {
    await expect(validateAccountDirectoryPublication(await publication())).resolves.toEqual(
      await publication()
    );
  });

  it('rejects a forged bucket and requires an account ID route index', async () => {
    const valid = await publication();
    await expect(
      validateAccountDirectoryPublication({
        ...valid,
        indexes: [
          { ...valid.indexes[0], virtualBucket: (valid.indexes[0].virtualBucket + 1) % 4096 },
        ],
      })
    ).rejects.toThrow('invalid_directory_publication_index');

    await expect(
      validateAccountDirectoryPublication({
        ...valid,
        indexes: [await createLookupBlindIndex('email_exact', 'person@example.com', key)],
      })
    ).rejects.toThrow('invalid_directory_publication_index_set');
  });

  it('rejects raw identifier fields before they can enter an outbox payload', async () => {
    await expect(
      validateAccountDirectoryPublication({
        ...(await publication()),
        rawEmail: 'person@example.com',
      } as Awaited<ReturnType<typeof publication>>)
    ).rejects.toThrow('invalid_directory_publication_shape');
    await expect(
      validateAccountDirectoryPublication({
        ...(await publication()),
        note: 'person@example.com',
      } as Awaited<ReturnType<typeof publication>>)
    ).rejects.toThrow('invalid_directory_publication_shape');
    const valid = await publication();
    await expect(
      validateAccountDirectoryPublication({
        ...valid,
        indexes: [{ ...valid.indexes[0], note: 'person@example.com' }],
      } as Awaited<ReturnType<typeof publication>>)
    ).rejects.toThrow('invalid_directory_publication_index');
  });

  it('releases only a prepared outbox for scheduled or immediate delivery', async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1, success: true });
    await markAccountDirectoryPublicationReady({ execute } as never, 'operation-1', 1_800_000_001);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status = 'pending'"), [
      1_800_000_001,
      1_800_000_001,
      'account-routing:operation-1',
    ]);
  });

  it('adopts a response-loss retry after the outbox became runnable', async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 0, success: true });
    const queryOne = vi.fn().mockResolvedValue({ status: 'pending' });
    await expect(
      markAccountDirectoryPublicationReady(
        { execute, queryOne } as never,
        'operation-1',
        1_800_000_001
      )
    ).resolves.toBeUndefined();
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('FROM account_routing_outbox'), [
      'account-routing:operation-1',
    ]);
  });

  it('does not revive a blocked or missing routing outbox', async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 0, success: true });
    for (const reflected of [null, { status: 'blocked' }]) {
      await expect(
        markAccountDirectoryPublicationReady(
          { execute, queryOne: vi.fn().mockResolvedValue(reflected) } as never,
          'operation-1',
          1_800_000_001
        )
      ).rejects.toThrow('directory_routing_outbox_ready_failed');
    }
  });
});
