import { describe, expect, it, vi } from 'vitest';
import { ensureManagedPluginResourceDeleted } from '../plugin-resource-cleanup';

function notFound(): Error & { status: number } {
  return Object.assign(new Error('not_found'), { status: 404 });
}

describe('managed plugin resource deletion', () => {
  it('adopts a D1 delete response loss only after exact absence', async () => {
    let database: { uuid: string; name: string } | null = { uuid: 'db-a', name: 'managed-a' };
    const getD1Database = vi.fn(async () => {
      if (!database) throw notFound();
      return database;
    });
    const deleteD1Database = vi.fn(async () => {
      database = null;
      throw new Error('response_lost');
    });

    await expect(
      ensureManagedPluginResourceDeleted({
        resource: { kind: 'd1', providerResourceId: 'db-a', providerName: 'managed-a' },
        api: {
          d1: { getD1Database, deleteD1Database },
          kv: { listKvNamespaces: vi.fn(), deleteKvNamespace: vi.fn() },
          r2: { listR2Buckets: vi.fn(), deleteR2Bucket: vi.fn() },
        },
      })
    ).resolves.toBeUndefined();
    expect(deleteD1Database).toHaveBeenCalledOnce();
  });

  it('rejects provider identity drift before deleting KV or R2', async () => {
    const deleteKvNamespace = vi.fn();
    await expect(
      ensureManagedPluginResourceDeleted({
        resource: {
          kind: 'kv_namespace',
          providerResourceId: 'kv-a',
          providerName: 'expected-name',
        },
        api: {
          d1: { getD1Database: vi.fn(), deleteD1Database: vi.fn() },
          kv: {
            listKvNamespaces: vi.fn(async () => [{ id: 'kv-a', title: 'wrong-name' }]),
            deleteKvNamespace,
          },
          r2: { listR2Buckets: vi.fn(), deleteR2Bucket: vi.fn() },
        },
      })
    ).rejects.toThrow('control_plugin_cleanup_provider_identity_mismatch');
    expect(deleteKvNamespace).not.toHaveBeenCalled();

    const deleteR2Bucket = vi.fn();
    await expect(
      ensureManagedPluginResourceDeleted({
        resource: {
          kind: 'r2_bucket',
          providerResourceId: 'bucket-id',
          providerName: 'bucket-name',
        },
        api: {
          d1: { getD1Database: vi.fn(), deleteD1Database: vi.fn() },
          kv: { listKvNamespaces: vi.fn(), deleteKvNamespace: vi.fn() },
          r2: { listR2Buckets: vi.fn(async () => []), deleteR2Bucket },
        },
      })
    ).rejects.toThrow('control_plugin_cleanup_provider_identity_mismatch');
    expect(deleteR2Bucket).not.toHaveBeenCalled();
  });
});
