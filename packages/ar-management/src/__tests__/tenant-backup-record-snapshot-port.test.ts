import { describe, expect, it, vi } from 'vitest';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';
import { createEncryptedTenantBackupRecordSnapshotPort } from '../tenant-backup-record-snapshot-port';

function bucket() {
  const values = new Map<string, string>();
  return {
    values,
    async put(key: string, value: string) {
      values.set(key, value);
      return {};
    },
    async get(key: string) {
      const value = values.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async list(input: { prefix: string; limit: number; cursor?: string }) {
      const keys = [...values.keys()].filter((key) => key.startsWith(input.prefix)).sort();
      const offset = input.cursor ? Number(input.cursor) : 0;
      const selected = keys.slice(offset, offset + input.limit);
      const next = offset + selected.length;
      return {
        objects: selected.map((key) => ({ key })),
        truncated: next < keys.length,
        cursor: next < keys.length ? String(next) : undefined,
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
  };
}

function context(): AdapterContext {
  return {
    boundaryUnixMs: 100,
    context: {
      lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
      signal: new AbortController().signal,
    },
  } as AdapterContext;
}

async function* rows(values: readonly string[]) {
  for (const value of values) yield new TextEncoder().encode(`${JSON.stringify({ value })}\n`);
}

describe('encrypted tenant backup record snapshot port', () => {
  it('freezes encrypted records, retries exactly, streams them and removes staging objects', async () => {
    const storage = bucket();
    let source = ['private-key', 'connector-secret'];
    const assertSource = vi.fn(async () => {});
    const port = createEncryptedTenantBackupRecordSnapshotPort({
      env: {
        EXPORT_ARTIFACTS: storage as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: '11'.repeat(32),
        OBJECT_ENCRYPTION_KEY_VERSION: '3',
      },
      resourceId: 'saml-signing:tenant',
      assertSource,
      capture: () => rows(source),
    });
    const held = vi.fn(async () => {});
    const input = context();

    await port.start(input, 'snapshot-a', held, 100);
    expect([...storage.values.values()].join('')).not.toContain('private-key');
    expect(storage.values.size).toBe(3);

    source = ['changed-after-snapshot'];
    await port.start(input, 'snapshot-a', held, 100);
    expect(storage.values.size).toBe(3);
    await expect(port.start(input, 'snapshot-a', held, 101)).rejects.toThrow(
      'backup_record_snapshot_invalid'
    );

    const first = await port.readNext(input, 'snapshot-a', null, input.context.signal);
    const second = await port.readNext(
      input,
      'snapshot-a',
      first?.nextCursor ?? null,
      input.context.signal
    );
    expect(new TextDecoder().decode(first?.bytes)).toContain('private-key');
    expect(new TextDecoder().decode(second?.bytes)).toContain('connector-secret');
    await expect(
      port.readNext(input, 'snapshot-a', second?.nextCursor ?? null, input.context.signal)
    ).resolves.toBeNull();

    await port.release(input, 'snapshot-a');
    await expect(port.assertReleased(input, 'snapshot-a')).resolves.toBeUndefined();
    expect(storage.values.size).toBe(0);
    expect(assertSource).toHaveBeenCalledTimes(4);
    expect(held.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('removes every staging object when the R2 listing spans multiple pages', async () => {
    const storage = bucket();
    const port = createEncryptedTenantBackupRecordSnapshotPort({
      env: {
        EXPORT_ARTIFACTS: storage as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: '33'.repeat(32),
      },
      resourceId: 'public-assets:tenant',
      assertSource: async () => {},
      capture: () => rows([]),
    });
    const input = context();
    const prefix = 'tenant-backup-snapshots/tenant-a/operation-a/public-assets:tenant/snapshot-c/';
    for (let index = 0; index < 1001; index += 1)
      storage.values.set(`${prefix}${index}`, 'staging');

    await port.release(input, 'snapshot-c');

    expect(storage.values.size).toBe(0);
    await expect(port.assertReleased(input, 'snapshot-c')).resolves.toBeUndefined();
  });

  it('rejects malformed capture records before publishing an index', async () => {
    const storage = bucket();
    const port = createEncryptedTenantBackupRecordSnapshotPort({
      env: {
        EXPORT_ARTIFACTS: storage as unknown as R2Bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: '22'.repeat(32),
      },
      resourceId: 'directory-secrets:tenant',
      assertSource: async () => {},
      capture: async function* () {
        yield new TextEncoder().encode('not-json\n');
      },
    });
    await expect(port.start(context(), 'snapshot-b', async () => {}, 100)).rejects.toThrow(
      'backup_record_snapshot_invalid'
    );
    expect([...storage.values.keys()].some((key) => key.endsWith('index.json'))).toBe(false);
  });
});
