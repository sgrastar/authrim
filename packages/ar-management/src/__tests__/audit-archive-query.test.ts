import { describe, expect, it, vi } from 'vitest';
import {
  buildCanonicalAuditArchiveRecordFromEntry,
  type AuditProfile,
  type EventLogEntry,
} from '@authrim/ar-lib-core';
import {
  deriveLogChunkEncryptionKey,
  writeLogChunkToR2,
  type LogChunkRecordIndexRow,
  type LogObjectCatalogRow,
} from '@authrim/ar-lib-logging/chunks';

const { queryRows } = vi.hoisted(() => ({ queryRows: [] as Array<Record<string, unknown>> }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ensureDatabaseAdapter: vi.fn(() => ({
      query: vi.fn(async (_sql: string, params: unknown[]) => {
        const requestedId = params.find(
          (value) => typeof value === 'string' && value.startsWith('evt-')
        );
        return requestedId ? queryRows.filter((row) => row.record_id === requestedId) : queryRows;
      }),
    })),
  };
});

import {
  getArchiveAuditEventById,
  getAuditArchiveQuerySupportForProfile,
  listArchiveAuditEvents,
} from '../audit-archive-query';

const ROOT_KEY = '11'.repeat(32);

function createEventEntry(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id: 'evt-1',
    tenantId: 'tenant-1',
    eventType: 'user.login',
    eventCategory: 'user',
    result: 'success',
    severity: 'info',
    createdAt: 1_710_000_000_000,
    ...overrides,
  };
}

async function createEncryptedArchive(entries: EventLogEntry[]) {
  const objects = new Map<string, Uint8Array>();
  let catalog: LogObjectCatalogRow | null = null;
  let indexes: LogChunkRecordIndexRow[] = [];
  const bucket = {
    put: vi.fn(async (key: string, value: Uint8Array) => {
      objects.set(key, value);
    }),
    get: vi.fn(async (key: string) => {
      const value = objects.get(key);
      return value
        ? {
            size: value.byteLength,
            arrayBuffer: async () => value.buffer.slice(0),
          }
        : null;
    }),
    list: vi.fn(),
  } as unknown as R2Bucket;
  const catalogStore = {
    createPendingObject: vi.fn(async (row: LogObjectCatalogRow) => {
      catalog = row;
    }),
    createPendingRecordIndexes: vi.fn(async (rows: LogChunkRecordIndexRow[]) => {
      indexes = rows;
    }),
    commitObject: vi.fn(
      async (_id: string, update: { checksumSha256: string; committedAt: number }) => {
        catalog = catalog ? { ...catalog, ...update, status: 'committed' as const } : catalog;
      }
    ),
    commitRecordIndexes: vi.fn(async () => {
      indexes = indexes.map((row) => ({ ...row, status: 'committed' as const }));
    }),
    markObjectOrphanCandidate: vi.fn(),
  };
  const target = { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'audit' } as const;
  await writeLogChunkToR2({
    bucket,
    tenantKey: 'tenant-key-1',
    logType: 'audit',
    plane: 'archive',
    prefix: 'audit',
    compression: 'none',
    catalogStore,
    chunkId: 'chunk-1',
    objectCatalogId: 'object-1',
    now: entries[0].createdAt,
    encryption: {
      keyBytes: await deriveLogChunkEncryptionKey({
        rootKeyHex: ROOT_KEY,
        tenantKey: 'tenant-key-1',
        logType: 'audit',
        plane: 'archive',
        keyVersion: 1,
      }),
      encryptionScope: 'tenant:tenant-key-1:audit:archive',
      keyVersion: 1,
    },
    records: entries.map((entry) => ({
      id: entry.id,
      eventAt: entry.createdAt,
      payload: buildCanonicalAuditArchiveRecordFromEntry(
        target,
        'event_log',
        entry,
        'tenant-key-1'
      ),
    })),
  });
  if (!catalog) throw new Error('catalog was not created');
  queryRows.splice(
    0,
    queryRows.length,
    ...indexes.map((index) => ({
      record_id: index.recordId,
      tenant_key: index.tenantKey,
      object_catalog_id: index.objectCatalogId,
      chunk_id: index.chunkId,
      object_key: catalog!.objectKey,
      checksum_sha256: catalog!.checksumSha256,
      compression: catalog!.compression,
      encryption_scope: catalog!.encryptionScope,
      key_version: catalog!.keyVersion,
      line_number: index.lineNumber,
      block_offset: index.blockOffset,
      block_length: index.blockLength,
      record_offset: index.recordOffset,
      record_length: index.recordLength,
      event_at: index.eventAt,
      index_profile: index.indexProfile,
      indexed_fields: null,
      created_at: index.createdAt,
    }))
  );
  return bucket;
}

describe('audit-archive-query', () => {
  it('queries only checksummed encrypted chunks through the Admin catalog', async () => {
    const older = createEventEntry({ id: 'evt-older', createdAt: 1_709_000_000_000 });
    const newer = createEventEntry({
      id: 'evt-newer',
      createdAt: 1_710_000_000_000,
      eventType: 'client.updated',
      eventCategory: 'client',
      clientId: 'client-2',
    });
    const bucket = await createEncryptedArchive([newer, older]);
    const profile: AuditProfile = {
      id: 'archive-only',
      kind: 'audit',
      label: 'Archive Only',
      primary: null,
      archive: { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'audit' },
      sinks: [],
    };
    const support = getAuditArchiveQuerySupportForProfile(
      {
        AUDIT_ARCHIVE: bucket,
        DB: {},
        DB_ADMIN: {},
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      } as never,
      profile
    );
    expect(support.status).toBe('supported');
    support.context!.tenantKeyResolver = async () => 'tenant-key-1';

    const listed = await listArchiveAuditEvents(support.context!, {
      tenantId: 'tenant-1',
      page: 1,
      limit: 10,
      eventType: 'client.updated',
    });
    expect(listed.entries.map((entry) => entry.id)).toEqual(['evt-newer']);
    expect(
      (await getArchiveAuditEventById(support.context!, 'tenant-1', 'evt-newer'))?.clientId
    ).toBe('client-2');
  });

  it('fails closed when encrypted archive dependencies are missing', () => {
    const profile: AuditProfile = {
      id: 'archive-only',
      kind: 'audit',
      label: 'Archive Only',
      primary: null,
      archive: { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'audit' },
      sinks: [],
    };
    expect(getAuditArchiveQuerySupportForProfile({} as never, profile).status).toBe(
      'pending_runtime_support'
    );
  });

  it('rejects the removed DIAGNOSTIC_LOGS audit archive layout', () => {
    const profile: AuditProfile = {
      id: 'legacy-archive',
      kind: 'audit',
      label: 'Legacy Archive',
      primary: null,
      archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit' },
      sinks: [],
    };
    expect(
      getAuditArchiveQuerySupportForProfile(
        {
          DIAGNOSTIC_LOGS: {},
          DB: {},
          DB_ADMIN: {},
          OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
        } as never,
        profile
      ).status
    ).toBe('pending_runtime_support');
  });
});
