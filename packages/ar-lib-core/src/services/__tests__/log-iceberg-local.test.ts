import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLogIcebergConfig } from '../log-iceberg-config';
import { emitLogIcebergRow } from '../log-iceberg-emitter';
import { readLogIcebergDataset } from '../log-iceberg-read';
import { exportLogIcebergBatch } from '../log-iceberg-export';
import { createLogIcebergCatalog } from '../log-iceberg-catalog';
import { logProducerFixture } from './log-iceberg-producer-fixture';

vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));

const dispose: (() => void)[] = [];
afterEach(() => {
  dispose.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});
async function localFixture() {
  const f = await logProducerFixture('scheduled');
  dispose.push(() => f.db.close());
  const env = {
    ...f.env,
    LOG_ARCHIVE_WRITER: undefined,
    AUTHRIM_LOG_ARCHIVE_LOCAL_STAGING_ONLY: 'true',
    ISSUER_URL: 'http://localhost:8787',
  };
  for (const name of [
    'AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID',
    'AUTHRIM_LOG_ARCHIVE_BUCKET',
    'AUTHRIM_LOG_ARCHIVE_CATALOG_URI',
    'AUTHRIM_LOG_ARCHIVE_WAREHOUSE',
    'AUTHRIM_LOG_ARCHIVE_NAMESPACE',
    'AUTHRIM_LOG_ARCHIVE_TABLE',
    'AUTHRIM_LOG_ARCHIVE_TABLE_UUID',
    'AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT',
  ] as const)
    delete env[name];
  return { ...f, env, local: resolveLogIcebergConfig(env) };
}

describe('scheduled local development capability limits', () => {
  it('encrypts and searches hot rows, reports cold disconnected, and retains old DB rows when export cannot run', async () => {
    const f = await localFixture(),
      fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(f.local).toMatchObject({
      mode: 'scheduled',
      localStagingOnly: true,
      tableUuid: null,
      physicalFingerprint: null,
      catalogUri: null,
    });
    await emitLogIcebergRow(f.env, {
      tenantId: 'tenant-a',
      sourceDataset: 'core.operational_logs',
      logType: 'operational',
      eventAt: f.now,
      ingestedAt: f.now - 8 * 86400000,
      expiresAt: f.now + 86400000,
      row: {
        id: 'local-event',
        tenant_id: 'tenant-a',
        action: 'local.write',
        metadata_json: 'private local payload',
      },
    });
    expect(
      JSON.stringify(f.db.prepare('SELECT * FROM log_iceberg_record_parts').all())
    ).not.toContain('private local payload');
    const result = await readLogIcebergDataset(f.env, {
      tenantId: 'tenant-a',
      sourceDataset: 'core.operational_logs',
      now: f.now,
    });
    expect(result).toMatchObject({
      hasArchive: false,
      consistency: 'local_hot_only',
      pendingDeliveries: 0,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].metadata_json).toBe('private local payload');
    await expect(exportLogIcebergBatch(f.local, f.ports)).rejects.toThrow(
      'log_iceberg_local_cold_archive_not_connected'
    );
    expect(() => createLogIcebergCatalog(f.env, f.local)).toThrow(
      'log_iceberg_local_cold_archive_not_connected'
    );
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(1);
    expect(f.objects.size).toBe(0);
    expect(f.queueMessages).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('rejects a local flag with a public issuer, Pipeline mode, or invented remote activation metadata', async () => {
    const f = await localFixture();
    for (const override of [
      { ISSUER_URL: 'https://auth.example.invalid' },
      { AUTHRIM_LOG_ARCHIVE_MODE: 'pipeline' },
      { AUTHRIM_LOG_ARCHIVE_TABLE_UUID: '00000000-0000-4000-8000-000000000000' },
      { AUTHRIM_LOG_ARCHIVE_CATALOG_URI: f.config.catalogUri },
      { AUTHRIM_LOG_ARCHIVE_LOCAL_STAGING_ONLY: 'false' },
    ])
      expect(() => resolveLogIcebergConfig({ ...f.env, ...override })).toThrow(
        'log_iceberg_configuration_invalid'
      );
  });
});
