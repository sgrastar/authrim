import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock('@authrim/ar-lib-core/services/sensitive-detail-chunk-store', () => ({
  loadChunkedSensitiveDetailJson: mocks.load,
}));

import { createTenantBackupPiiLogTransformPort } from '../tenant-backup-pii-log-port';

describe('tenant backup external PII log transform port', () => {
  beforeEach(() => mocks.load.mockReset());

  it('resolves the held PII database and loads only the referenced tenant catalog value', async () => {
    const source = { queryOne: vi.fn() };
    const resolveSource = vi.fn(async () => source);
    mocks.load.mockResolvedValue({
      ciphertext: 'ciphertext',
      iv: 'iv',
      keyId: 'pii-key-v1',
    });
    const bucket = {} as NonNullable<
      Parameters<typeof createTenantBackupPiiLogTransformPort>[0]['SENSITIVE_DETAILS']
    >;
    const port = createTenantBackupPiiLogTransformPort(
      { SENSITIVE_DETAILS: bucket, OBJECT_ENCRYPTION_ROOT_KEY: '11'.repeat(32) },
      vi.fn()
    );
    const result = await port.loadExternalPiiLogValues(
      {
        context: {
          lease: { tenantId: 'tenant-a' },
          signal: new AbortController().signal,
        },
        databases: {
          tenant: [
            {
              databaseId: 'pii-db-other',
              assignments: [{ role: 'tenant_pii' }],
            },
            {
              databaseId: 'pii-db-a',
              assignments: [{ role: 'tenant_pii' }],
            },
          ],
        },
        resourceId: 'pii-db-a',
        resolveSource,
      } as never,
      'sensitive-detail-catalog:catalog-a'
    );
    expect(resolveSource).toHaveBeenCalledWith({ resourceId: 'pii-db-a', family: 'pii' });
    expect(mocks.load).toHaveBeenCalledWith(
      source,
      expect.objectContaining({
        SENSITIVE_DETAILS: bucket,
      }),
      {
        tenantId: 'tenant-a',
        objectCatalogId: 'catalog-a',
        expectedClass: 'pii_log_values',
      }
    );
    expect(JSON.parse(result ?? 'null')).toMatchObject({ keyId: 'pii-key-v1' });
  });

  it('does not resolve a different PII shard when the row source is missing', async () => {
    const port = createTenantBackupPiiLogTransformPort({}, vi.fn());
    await expect(
      port.loadExternalPiiLogValues(
        {
          context: {
            lease: { tenantId: 'tenant-a' },
            signal: new AbortController().signal,
          },
          resourceId: 'pii-db-missing',
          databases: {
            tenant: [
              {
                databaseId: 'pii-db-a',
                assignments: [{ role: 'tenant_pii' }],
              },
              {
                databaseId: 'pii-db-b',
                assignments: [{ role: 'tenant_pii' }],
              },
            ],
          },
        } as never,
        'sensitive-detail-catalog:catalog-a'
      )
    ).rejects.toThrow('backup_pii_log_external_value_invalid');
  });

  it('fails closed when the PII resource or catalog payload is unavailable', async () => {
    const port = createTenantBackupPiiLogTransformPort({}, vi.fn());
    await expect(
      port.loadExternalPiiLogValues(
        {
          context: {
            lease: { tenantId: 'tenant-a' },
            signal: new AbortController().signal,
          },
          databases: { tenant: [] },
        } as never,
        'sensitive-detail-catalog:catalog-a'
      )
    ).rejects.toThrow('backup_pii_log_external_value_invalid');
  });
});
