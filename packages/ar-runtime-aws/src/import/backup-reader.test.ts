import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encodeTenantBackupContainerV2 } from '@authrim/ar-lib-core/services/tenant-portability/backup-container-v2';
import { createTenantBundleKeyEnvelope } from '@authrim/ar-lib-core/services/tenant-portability/bundle-key-envelope';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';
import { openVerifiedTenantBackupV2, type OpenVerifiedTenantBackupV2Input } from './backup-reader';

const TENANT = 'tenant-a';
const NOW = 1_700_000_000_000;
const PASSPHRASE = 'synthetic-test-passphrase-only';
const DATASET: TenantPortableDataset = {
  id: 'core.identity_accounts',
  module: 'users',
  kind: 'users',
  store: 'database',
  schemaVersion: 1,
  disposition: 'include',
};
const ROW = { tenant_id: ['text', TENANT], id: ['text', 'account:alice'] };
const SELECTION = {
  settings: false,
  users: true,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 7 as const },
};
const SOURCE = {
  tenantId: TENANT,
  issuer: 'https://tenant-a.example.test',
  productVersion: '0.4.2',
};

let artifact: Uint8Array;
let manifest: TenantBundleManifest;
const directories: string[] = [];

beforeAll(async () => {
  const session = await createTenantBundleKeyEnvelope(PASSPHRASE);
  const bundleId = Array.from(session.envelope.subarray(1, 17), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  manifest = {
    formatVersion: 1,
    bundleId,
    source: SOURCE,
    snapshotId: 'snapshot-a',
    boundaryUnixMs: NOW - 60_000,
    inventoryDigestSha256: 'a'.repeat(64),
    selection: SELECTION,
    datasets: [DATASET],
  };
  const encoded = await encodeTenantBackupContainerV2({
    manifest,
    session,
    datasets: (async function* () {
      yield {
        datasetId: DATASET.id,
        chunks: (async function* () {
          yield new TextEncoder().encode(`${JSON.stringify(ROW)}\n`);
        })(),
      };
    })(),
  });
  artifact = encoded.parts[0];
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function files(parts: readonly Uint8Array[]): Promise<OpenVerifiedTenantBackupV2Input> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'authrim-offline-backup-'));
  directories.push(directory);
  const partPaths: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const path = join(directory, `part-${index}.bin`);
    await writeFile(path, parts[index]);
    partPaths.push(path);
  }
  return {
    partPaths,
    receipt: {
      source: SOURCE,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      parts: parts.map((part) => ({
        size: part.length,
        sha256: createHash('sha256').update(part).digest('hex'),
      })),
    },
    passphrase: PASSPHRASE,
    selection: SELECTION,
    datasets: [DATASET],
    maxSnapshotAgeMs: 60 * 60 * 1000,
    nowMs: NOW,
  };
}

describe('offline AUTHRIM2 reader', () => {
  it('verifies ordered files before yielding any typed dataset row', async () => {
    const input = await files([
      artifact.subarray(0, 42),
      artifact.subarray(42, 170),
      artifact.subarray(170),
    ]);
    const verified = await openVerifiedTenantBackupV2(input);
    expect(verified.manifest).toEqual(manifest);
    const dataset = verified.dataset(DATASET.id);
    expect(dataset.rows).toBe(1);
    const first = await dataset.readNextRow(null);
    expect(JSON.parse(first?.rowJson ?? '{}')).toEqual(ROW);
    expect(await dataset.readNextRow(first?.nextCursor ?? null)).toBeNull();
    expect(() => verified.dataset('admin.other')).toThrow('aws_backup_reader_invalid');
    await verified.close();
    await expect(dataset.readNextRow(null)).rejects.toThrow('aws_backup_reader_invalid');
  });

  it('refuses a wrong part order, ciphertext change, and wrong passphrase without leaking input', async () => {
    const first = await files([artifact.subarray(0, 80), artifact.subarray(80)]);
    await expect(
      openVerifiedTenantBackupV2({
        ...first,
        partPaths: [...first.partPaths].reverse(),
      })
    ).rejects.toThrow('aws_backup_reader_invalid');

    const changed = artifact.slice();
    changed[180] ^= 1;
    await expect(openVerifiedTenantBackupV2(await files([changed]))).rejects.toThrow(
      'aws_backup_reader_invalid'
    );
    const wrongPassword = await files([artifact]);
    await expect(
      openVerifiedTenantBackupV2({
        ...wrongPassword,
        passphrase: 'an-intentionally-wrong-passphrase',
      })
    ).rejects.toThrow('aws_backup_reader_invalid');
  });

  it('rejects truncated footer, stale snapshot, source mismatch, and legacy AUTHRIM1', async () => {
    await expect(
      openVerifiedTenantBackupV2(await files([artifact.subarray(0, -30)]))
    ).rejects.toThrow('aws_backup_reader_invalid');
    const stale = await files([artifact]);
    await expect(
      openVerifiedTenantBackupV2({ ...stale, nowMs: NOW + 24 * 60 * 60 * 1000 })
    ).rejects.toThrow('aws_backup_reader_invalid');
    const wrongSource = await files([artifact]);
    wrongSource.receipt.source = { ...SOURCE, tenantId: 'tenant-b' };
    await expect(openVerifiedTenantBackupV2(wrongSource)).rejects.toThrow(
      'aws_backup_reader_invalid'
    );
    const legacy = await files([new TextEncoder().encode('AUTHRIM1legacy')]);
    await expect(openVerifiedTenantBackupV2(legacy)).rejects.toThrow('aws_backup_reader_invalid');
  });

  it('rejects symlink paths and changes to a pinned file after opening', async () => {
    const linked = await files([artifact]);
    const link = join(directories[directories.length - 1], 'link.bin');
    await symlink(linked.partPaths[0], link);
    await expect(openVerifiedTenantBackupV2({ ...linked, partPaths: [link] })).rejects.toThrow(
      'aws_backup_reader_invalid'
    );

    const changed = await files([artifact]);
    const verified = await openVerifiedTenantBackupV2(changed);
    const dataset = verified.dataset(DATASET.id);
    const overwritten = artifact.slice();
    overwritten[180] ^= 1;
    await writeFile(changed.partPaths[0], overwritten);
    await expect(dataset.readNextRow(null)).rejects.toThrow('aws_backup_reader_invalid');
    await expect(verified.close()).rejects.toThrow('aws_backup_reader_invalid');
  });
});
