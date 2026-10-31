import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';

import { logArchivePhysicalFingerprint } from '@authrim/ar-lib-logging/iceberg';
import {
  MemoryCatalog,
  MemoryStore,
} from '../../../../ar-lib-logging/src/iceberg/__tests__/fixtures';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import type { LogIcebergConfig } from '../log-iceberg-config';
import { buildLogIcebergRecord } from '../log-iceberg-record';
import { encodeLogIcebergRow } from '../log-iceberg-row-codec';
import { SqlLogIcebergRecordStore } from '../log-iceberg-store';

export async function icebergFixture() {
  const fixture = sqliteAdapter();
  fixture.db.exec('PRAGMA foreign_keys=ON');
  fixture.db.exec(
    readMigrationSource(
      new URL('../../../../../migrations/admin/d1/', import.meta.url),
      '053_log_iceberg_storage.sql'
    )
  );
  fixture.db.exec(
    `CREATE TABLE scheduled_task_leases(task_id TEXT NOT NULL PRIMARY KEY,lease_token TEXT NOT NULL,lease_until INTEGER NOT NULL,updated_at INTEGER NOT NULL)`
  );
  const catalog = new MemoryCatalog();
  const store = new MemoryStore();
  const now = Date.now();
  const config: LogIcebergConfig = {
    mode: 'scheduled',
    generation: 'new-generation',
    schemaVersion: 1,
    activatedAt: now - 30 * 86400000,
    accountId: 'a'.repeat(32),
    bucket: 'authrim-test',
    warehouse: `${'a'.repeat(32)}_authrim-test`,
    catalogUri: `https://catalog.cloudflarestorage.com/${'a'.repeat(32)}/authrim-test`,
    namespace: 'authrim',
    table: 'logs_v1',
    tableUuid: catalog.metadata['table-uuid'],
    physicalFingerprint: await logArchivePhysicalFingerprint(catalog.metadata),
    dbRetentionDays: 7,
    exportIntervalMinutes: 10,
  };
  const keys = { rootKeyHex: 'ab'.repeat(32), contentHmacKeyHex: 'cd'.repeat(32), keyVersion: 1 };
  const staging = new SqlLogIcebergRecordStore(fixture.adapter);
  const record = async (
    id = 'event-1',
    options: {
      tenantId?: string;
      tenantKey?: string;
      sourceDataset?: string;
      ingestedAt?: number;
      expiresAt?: number | null;
      subjectId?: string;
      row?: Record<string, string | number | null>;
    } = {}
  ) => {
    const tenantId = options.tenantId ?? 'tenant-a',
      tenantKey = options.tenantKey ?? 'key-a',
      sourceDataset = options.sourceDataset ?? 'core.audit_log';
    const body = await encodeLogIcebergRow({
      context: {
        tenantKey,
        sourceDataset,
        eventId: id,
        generation: config.generation,
        schemaVersion: 1,
      },
      row: {
        id,
        tenant_id: tenantId,
        action: 'user.login',
        created_at: Math.floor((now - 8 * 86400000) / 1000),
        metadata_json: '{"email":"private@example.invalid"}',
        ...options.row,
      },
      keys,
    });
    return buildLogIcebergRecord(
      config,
      {
        eventId: id,
        tenantKey,
        sourceDataset,
        logType: 'audit',
        eventAt: now - 8 * 86400000,
        ingestedAt: options.ingestedAt ?? now - 8 * 86400000,
        expiresAt: options.expiresAt === undefined ? now + 86400000 : options.expiresAt,
        overview: {
          subject_id:
            sourceDataset === 'pii.pii_log'
              ? (options.subjectId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
              : null,
        },
        body,
      },
      keys
    );
  };
  return {
    ...fixture,
    config,
    catalog,
    store,
    keys,
    now,
    staging,
    record,
    ports: { admin: fixture.adapter, catalog, store: () => store },
  };
}
