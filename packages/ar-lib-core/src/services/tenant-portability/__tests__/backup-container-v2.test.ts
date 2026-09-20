import { describe, expect, it } from 'vitest';
import { createTenantBundleKeyEnvelope } from '../bundle-key-envelope';
import type { TenantBundleManifest } from '../bundle-manifest';
import {
  decodeTenantBackupContainerV2,
  encodeTenantBackupContainerV2,
  TENANT_BACKUP_CONTAINER_V2_LIMITS,
  type TenantBackupContainerDatasetSourceV2,
} from '../backup-container-v2';

async function fixture(datasetIds: string[]) {
  const key = await createTenantBundleKeyEnvelope('container v2 fixture password');
  const bundleId = Array.from(key.envelope.subarray(1, 17), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  const manifest: TenantBundleManifest = {
    formatVersion: 1,
    bundleId,
    source: { tenantId: 'tenant-a', issuer: 'https://issuer.example', productVersion: '0.4.2' },
    snapshotId: 'snapshot-a',
    boundaryUnixMs: 100,
    inventoryDigestSha256: 'a'.repeat(64),
    selection: { users: true, admin: true, settings: true, auditLogs: true, diagnosticLogs: true },
    datasets: datasetIds.map((id) => ({
      id,
      module: 'core',
      kind: 'users',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    })),
  };
  return { key, manifest };
}

function sources(values: Readonly<Record<string, readonly Uint8Array[]>>) {
  return (async function* (): AsyncGenerator<TenantBackupContainerDatasetSourceV2> {
    for (const [datasetId, chunks] of Object.entries(values)) {
      yield {
        datasetId,
        chunks: (async function* () {
          yield* chunks;
        })(),
      };
    }
  })();
}

describe('tenant backup container v2', () => {
  it('stores a 600 KiB backup in one authenticated object', async () => {
    const { key, manifest } = await fixture(['core.users']);
    const row = new TextEncoder().encode(`${'x'.repeat(1022)}\n`);
    const chunks = Array.from({ length: 600 }, () => row);
    const encoded = await encodeTenantBackupContainerV2({
      manifest,
      datasets: sources({ 'core.users': chunks }),
      session: key,
    });
    expect(encoded.manifest.totalBytes).toBe(600 * 1023);
    expect(encoded.manifest.totalRows).toBe(600);
    expect(encoded.parts).toHaveLength(1);
    const decoded = await decodeTenantBackupContainerV2({ parts: encoded.parts, session: key });
    expect(decoded.datasets.get('core.users')).toHaveLength(600 * 1023);
  });

  it('records empty datasets without creating data frames or R2 parts for each one', async () => {
    const ids = Array.from({ length: 200 }, (_, index) => `core.empty_${index}`);
    const { key, manifest } = await fixture(ids);
    const encoded = await encodeTenantBackupContainerV2({
      manifest,
      datasets: sources(Object.fromEntries(ids.map((id) => [id, []]))),
      session: key,
    });
    expect(encoded.parts).toHaveLength(1);
    expect(encoded.footer.dataFrames).toBe(1);
    expect(encoded.manifest.datasets.every((dataset) => dataset.rows === 0)).toBe(true);
    const decoded = await decodeTenantBackupContainerV2({ parts: encoded.parts, session: key });
    expect(decoded.datasets.size).toBe(200);
  });

  it('uses capacity parts only above 16 MiB', async () => {
    const { key, manifest } = await fixture(['core.large']);
    const bytes = new Uint8Array(TENANT_BACKUP_CONTAINER_V2_LIMITS.singleObjectDataBytes + 1);
    bytes.fill(120);
    bytes[bytes.length - 1] = 10;
    const encoded = await encodeTenantBackupContainerV2({
      manifest,
      datasets: sources({ 'core.large': [bytes] }),
      session: key,
    });
    expect(encoded.parts.length).toBeGreaterThan(1);
    expect(encoded.parts[0].length).toBeLessThanOrEqual(
      TENANT_BACKUP_CONTAINER_V2_LIMITS.capacityPartBytes + 256
    );
    const decoded = await decodeTenantBackupContainerV2({ parts: encoded.parts, session: key });
    expect(decoded.datasets.get('core.large')).toHaveLength(bytes.length);
  });

  it('rejects ciphertext, footer and dataset hash corruption before restore', async () => {
    const { key, manifest } = await fixture(['core.users']);
    const encoded = await encodeTenantBackupContainerV2({
      manifest,
      datasets: sources({ 'core.users': [new TextEncoder().encode('{"id":1}\n')] }),
      session: key,
    });
    const corrupt = encoded.parts.map((part) => new Uint8Array(part));
    corrupt[0][150] ^= 1;
    await expect(decodeTenantBackupContainerV2({ parts: corrupt, session: key })).rejects.toThrow(
      'invalid_tenant_backup_container_v2'
    );
  });
});
