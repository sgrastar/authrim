import { beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeTenantBackupContainerV2 } from '../backup-container-v2';
import {
  createTenantBundleKeyEnvelope,
  type TenantBundleKeyEnvelope,
} from '../bundle-key-envelope';
import type { TenantBundleManifest, TenantBundleManifestExpectation } from '../bundle-manifest';
import { probeTenantBackupInputManifest } from '../input-manifest-probe';

async function* source<T>(items: T[]) {
  yield* items;
}

const limits = { maxFrames: 100, maxTotalBytes: 8 * 1024 * 1024 };
let session: TenantBundleKeyEnvelope;
let expected: TenantBundleManifestExpectation;
let manifest: TenantBundleManifest;
let object: Uint8Array;

beforeAll(async () => {
  session = await createTenantBundleKeyEnvelope('fixture passphrase for manifest probe');
  expected = {
    bundleId: Array.from(session.envelope.subarray(1, 17), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join(''),
    source: { tenantId: 'tenant-a', issuer: 'https://issuer.example', productVersion: '0.4.2' },
    selection: {
      settings: true,
      users: false,
      admin: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
      artifacts: false,
    },
    datasets: [
      {
        id: 'core.clients',
        module: 'applications',
        kind: 'settings',
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
      },
    ],
  };
  manifest = {
    formatVersion: 1,
    bundleId: expected.bundleId,
    source: expected.source,
    snapshotId: 'snapshot-a',
    boundaryUnixMs: 123,
    inventoryDigestSha256: 'ab'.repeat(32),
    selection: expected.selection,
    datasets: [...expected.datasets],
  };
  const encoded = await encodeTenantBackupContainerV2({
    manifest,
    datasets: source([
      {
        datasetId: 'core.clients',
        chunks: source([new TextEncoder().encode('{"id":1}\n')]),
      },
    ]),
    session,
  });
  object = encoded.parts.reduce((combined, part) => {
    const next = new Uint8Array(combined.length + part.length);
    next.set(combined);
    next.set(part, combined.length);
    return next;
  }, new Uint8Array());
});

function bucket(value = object) {
  return {
    async get(
      _key: string,
      options: { range: { offset: number; length: number }; onlyIf: { etagMatches: string } }
    ) {
      const selected = value.slice(
        options.range.offset,
        options.range.offset + options.range.length
      );
      return {
        version: 'version-a',
        etag: 'etag-a',
        size: value.length,
        body: new Blob([selected]).stream(),
      };
    },
  };
}

function request(value = object) {
  return {
    bucket: bucket(value),
    identity: { key: 'input-a', version: 'version-a', etag: 'etag-a', size: value.length },
    session,
    limits,
    expected: {
      source: expected.source,
      selection: expected.selection,
      datasets: expected.datasets,
    },
    signal: new AbortController().signal,
    assertAuthorized: vi.fn(async () => {}),
  };
}

describe('tenant backup input manifest probe', () => {
  it('authenticates the first two frames and returns the canonical manifest', async () => {
    const input = request();
    const result = await probeTenantBackupInputManifest(input);
    expect(result).toEqual({ manifest, expected });
    expect(input.assertAuthorized).toHaveBeenCalledTimes(3);
  });

  it('rejects ciphertext changes, a wrong key and changed installed expectations', async () => {
    const changed = object.slice();
    changed[changed.length > 160 ? 160 : changed.length - 1] ^= 1;
    await expect(probeTenantBackupInputManifest(request(changed))).rejects.toThrow(
      'backup_input_manifest_probe_failed'
    );
    const other = await createTenantBundleKeyEnvelope('different fixture passphrase');
    await expect(probeTenantBackupInputManifest({ ...request(), session: other })).rejects.toThrow(
      'backup_input_manifest_probe_failed'
    );
    await expect(
      probeTenantBackupInputManifest({
        ...request(),
        expected: { ...request().expected, datasets: [] },
      })
    ).rejects.toThrow('backup_input_manifest_probe_failed');
  });

  it('rechecks authorization after authenticated manifest parsing', async () => {
    const input = request();
    input.assertAuthorized.mockImplementation(async () => {
      if (input.assertAuthorized.mock.calls.length === 3) throw new Error('lease changed');
    });
    await expect(probeTenantBackupInputManifest(input)).rejects.toThrow(
      'backup_input_manifest_probe_failed'
    );
  });
});
