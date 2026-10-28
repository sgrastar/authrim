/** Real canonical persistence for matrix audits; transport doubles do not replace the writer. */
import { afterEach } from 'vitest';
import { logProducerFixture } from '../../helpers/log-iceberg-producer-fixture.mjs';
import { deriveTenantKeyFromTenantId } from '../../../packages/ar-lib-logging/src/contract/index';
import {
  assertLogArchiveRecord,
  type LogArchiveRecord,
} from '../../../packages/ar-lib-logging/src/iceberg/schema';
import {
  logIcebergRecordId,
  type LogIcebergStagedHead,
} from '../../../packages/ar-lib-core/src/services/log-iceberg-store';
import { decryptLogIcebergRecord } from '../../../packages/ar-lib-core/src/services/log-iceberg-record';
import { decodeLogIcebergRow } from '../../../packages/ar-lib-core/src/services/log-iceberg-row-codec';
import type { LogArchiveWriteServiceBinding } from '../../../packages/ar-lib-core/src/services/log-iceberg-runtime';
import type { SecurityMatrixEnvKit } from './env';
import type { CallLedger } from './call-ledger';

type ProducerFixture = Awaited<ReturnType<typeof logProducerFixture>>;
export type SecurityMatrixLogStorage = ProducerFixture & { writer: LogArchiveWriteServiceBinding };
const cache = new WeakMap<SecurityMatrixEnvKit, Map<string, SecurityMatrixLogStorage>>();
const active = new Set<SecurityMatrixLogStorage>();
afterEach(() => {
  for (const fixture of active) fixture.close();
  active.clear();
});

/** Preserve the business adapters. Queue consumers may explicitly use the returned real log DB. */
export async function installSecurityMatrixLogStorage(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  options: { mode?: 'scheduled' | 'pipeline'; rootKeyHex?: string } = {}
): Promise<SecurityMatrixLogStorage> {
  const mode = options.mode ?? 'scheduled';
  const key = `${mode}:${options.rootKeyHex ?? 'fixed-test-root'}`;
  let installed = cache.get(kit);
  if (!installed) {
    installed = new Map();
    cache.set(kit, installed);
  }
  let fixture = installed.get(key);
  if (!fixture) {
    const real = await logProducerFixture(mode, { tenantId: 'default' });
    for (const tenantId of ['default', 'foreign']) {
      const tenantKey = await deriveTenantKeyFromTenantId(tenantId);
      real.db
        .prepare(
          'INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tenant_key=excluded.tenant_key'
        )
        .run(tenantId, tenantId, tenantKey, tenantId, real.now, real.now);
    }
    if (options.rootKeyHex) {
      real.keys.rootKeyHex = options.rootKeyHex;
      real.env.OBJECT_ENCRYPTION_ROOT_KEY = options.rootKeyHex;
      real.env.LOG_ARCHIVE_ROOT_KEYRING = JSON.stringify({
        schema_version: 1,
        current_version: 1,
        roots: { 1: options.rootKeyHex },
      });
    }
    real.env.CONTROL = {
      ...real.env.CONTROL,
      acquireEnvironmentBackupMutationPermit: async () => ({ admitted: true }),
      completeEnvironmentBackupMutationPermit: async () => {},
    };
    const original = real.env.LOG_ARCHIVE_WRITER;
    if (!original) throw new Error('matrix_log_writer_missing');
    const writer: LogArchiveWriteServiceBinding = {
      ...original,
      writeRecords: async (request) => {
        const result = await original.writeRecords(request);
        for (const input of request.records) {
          const recordId = await logIcebergRecordId(input);
          let record: LogArchiveRecord | undefined;
          if (mode === 'scheduled') {
            const heads = await real.adapter.query<LogIcebergStagedHead>(
              'SELECT * FROM log_iceberg_records WHERE id=? AND tenant_id=? AND payload_hmac=?',
              [recordId, request.tenantId, input.payload_hmac]
            );
            record = (await real.staging.read(heads))[0];
          } else {
            const retry = real.adminDb
              .prepare(
                "SELECT payload_key FROM log_iceberg_outbox WHERE id=? AND tenant_id=? AND payload_hmac=? AND state IN('pending','queued','ingested')"
              )
              .get(recordId, request.tenantId, input.payload_hmac);
            const text =
              typeof retry?.payload_key === 'string'
                ? real.objects.get(retry.payload_key)?.text
                : undefined;
            if (text) {
              const parsed: unknown = JSON.parse(text);
              assertLogArchiveRecord(parsed);
              record = parsed;
            }
          }
          // An erased/filtered record is not a successful audit. Count only committed, readable,
          // authenticated data; never manufacture a ledger event from a method invocation alone.
          if (!record) continue;
          if (record.payload_hmac !== input.payload_hmac)
            throw new Error('matrix_log_persisted_content_changed');
          const body = await decryptLogIcebergRecord(
            record,
            {
              tenantKey: record.tenant_key,
              sourceDataset: record.source_dataset,
              eventId: record.event_id,
            },
            async () => real.keys
          );
          decodeLogIcebergRow(body, request.tenantId, record.event_id);
          ledger.record('audit', `log_iceberg.persisted:${record.source_dataset}`, {
            tenantId: request.tenantId,
            tenantKey: record.tenant_key,
            eventId: record.event_id,
            payloadHmac: record.payload_hmac,
            recordId,
          });
        }
        return result;
      },
    };
    real.env.LOG_ARCHIVE_WRITER = writer;
    fixture = { ...real, writer };
    installed.set(key, fixture);
    active.add(fixture);
  }
  const encryptionNames = new Set([
    'OBJECT_ENCRYPTION_ROOT_KEY',
    'LOG_ARCHIVE_ROOT_KEYRING',
    'LOG_ARCHIVE_CONTENT_HMAC_KEY',
  ]);
  const settings = Object.fromEntries(
    Object.entries(fixture.env).filter(
      ([name]) => name.startsWith('AUTHRIM_LOG_ARCHIVE_') || encryptionNames.has(name)
    )
  );
  Object.assign(kit.env, settings, {
    LOG_ARCHIVE_WRITER: fixture.writer,
    LOG_ARCHIVE: fixture.env.LOG_ARCHIVE,
    LOG_ARCHIVE_STREAM: fixture.env.LOG_ARCHIVE_STREAM,
    CONTROL: fixture.env.CONTROL,
    AUTHRIM_ENVIRONMENT_NAME: 'test',
  });
  return fixture;
}

export function canonicalAuditPersistCount(ledger: CallLedger): number {
  return ledger
    .all()
    .filter(
      (entry) => entry.kind === 'audit' && entry.target === 'log_iceberg.persisted:core.event_log'
    ).length;
}
