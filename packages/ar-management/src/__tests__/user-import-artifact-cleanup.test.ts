import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveAuthCorePersistenceAdapterFromEnv, mockAdapter } = vi.hoisted(() => ({
  mockResolveAuthCorePersistenceAdapterFromEnv: vi.fn(),
  mockAdapter: { queryOne: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: mockResolveAuthCorePersistenceAdapterFromEnv,
  };
});

import {
  cleanupOrphanedUserImportUploads,
  deleteTerminalUserImportInput,
  USER_IMPORT_ORPHAN_RETENTION_MS,
} from '../user-import-jobs';

describe('user import input artifact cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAuthCorePersistenceAdapterFromEnv.mockResolvedValue(mockAdapter);
    mockAdapter.queryOne.mockImplementation(async (_sql: string, params: unknown[]) =>
      String(params[0]).includes('active-upload') ? { id: 'job-active' } : null
    );
  });

  it('deletes expired orphan uploads while retaining active and young inputs', async () => {
    const now = Date.now();
    const objects = [
      {
        key: 'imports/tenant-a/orphan-upload/users.csv',
        uploaded: new Date(now - USER_IMPORT_ORPHAN_RETENTION_MS - 1),
        size: 1,
      },
      {
        key: 'imports/tenant-a/active-upload/users.csv',
        uploaded: new Date(now - USER_IMPORT_ORPHAN_RETENTION_MS - 1),
        size: 1,
      },
      {
        key: 'imports/tenant-b/young-upload/users.csv',
        uploaded: new Date(now - 1000),
        size: 1,
      },
    ];
    const bucket = {
      list: vi.fn().mockResolvedValue({ objects, truncated: false, delimitedPrefixes: [] }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const logger = { info: vi.fn(), error: vi.fn() };

    const result = await cleanupOrphanedUserImportUploads(
      { IMPORT_ARTIFACTS: bucket, AUTHRIM_CONFIG: kv } as never,
      logger,
      now
    );

    expect(result).toEqual({
      scanned: 3,
      deleted: 1,
      retainedActive: 1,
      retainedYoung: 1,
      failures: 0,
      cursor: null,
    });
    expect(bucket.delete).toHaveBeenCalledOnce();
    expect(bucket.delete).toHaveBeenCalledWith('imports/tenant-a/orphan-upload/users.csv');
    expect(mockAdapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('pending', 'processing')"),
      ['imports/tenant-a/orphan-upload/users.csv']
    );
  });

  it('deletes a terminal job input only when the key belongs to that tenant', async () => {
    const bucket = { delete: vi.fn().mockResolvedValue(undefined) };
    const logger = { error: vi.fn() };

    await deleteTerminalUserImportInput(
      bucket as never,
      {
        id: 'job-1',
        tenant_id: 'tenant-a',
        input_r2_key: 'imports/tenant-a/upload/users.csv',
      },
      logger
    );
    await deleteTerminalUserImportInput(
      bucket as never,
      {
        id: 'job-2',
        tenant_id: 'tenant-a',
        input_r2_key: 'imports/tenant-b/upload/users.csv',
      },
      logger
    );

    expect(bucket.delete).toHaveBeenCalledOnce();
    expect(bucket.delete).toHaveBeenCalledWith('imports/tenant-a/upload/users.csv');
  });

  it('uses upload expiry metadata and persists a bounded scan cursor', async () => {
    const now = Date.now();
    const bucket = {
      list: vi.fn().mockResolvedValue({
        objects: [
          {
            key: 'imports/tenant-a/upload/users.csv',
            uploaded: new Date(now),
            size: 1,
            customMetadata: { expires_at: String(now - 1) },
          },
        ],
        truncated: true,
        cursor: 'next-page',
        delimitedPrefixes: [],
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const kv = {
      get: vi.fn().mockResolvedValue('previous-page'),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const result = await cleanupOrphanedUserImportUploads(
      { IMPORT_ARTIFACTS: bucket, AUTHRIM_CONFIG: kv } as never,
      { info: vi.fn(), error: vi.fn() },
      now
    );

    expect(bucket.list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'imports/', cursor: 'previous-page', limit: 200 })
    );
    expect(bucket.delete).toHaveBeenCalledWith('imports/tenant-a/upload/users.csv');
    expect(kv.put).toHaveBeenCalledWith('jobs:r2-maintenance:import-artifacts-cursor', 'next-page');
    expect(result.cursor).toBe('next-page');
  });
});
