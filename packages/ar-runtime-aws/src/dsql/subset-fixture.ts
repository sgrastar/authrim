import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTenantBackupContainerV2 } from '@authrim/ar-lib-core/services/tenant-portability/backup-container-v2';
import { createTenantBundleKeyEnvelope } from '@authrim/ar-lib-core/services/tenant-portability/bundle-key-envelope';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import {
  openVerifiedTenantBackupV2,
  type OpenVerifiedTenantBackupV2Input,
  type VerifiedTenantBackupV2,
} from '../import/backup-reader';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';
import { restoreEvidenceDigest } from '../import/restore-evidence';

export interface DsqlSubsetFixture {
  readonly backup: VerifiedTenantBackupV2;
  readonly trustedReceiptDigest: string;
  readonly tenantId: string;
  readonly expectedRows: Readonly<Record<string, number>>;
  /** Re-verifies the same encrypted artifact, for process-restart/resume experiments. */
  reopen(): Promise<VerifiedTenantBackupV2>;
  /** Closes all readers and removes only the temporary directory created by this fixture. */
  close(): Promise<void>;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Creates real encrypted portable bytes, then uses the production verified reader. */
export async function createDsqlSubsetFixture(options: {
  kind: 'identity' | 'configuration';
  tenantId: string;
  issuer: string;
  expectedRows: Readonly<Record<string, number>>;
  row(datasetId: string, index: number, now: number): PortableSqliteRow;
}): Promise<DsqlSubsetFixture> {
  function invalid(): never {
    throw new Error(`dsql_${options.kind}_fixture_invalid`);
  }
  const now = Date.now();
  const datasets: TenantPortableDataset[] = POSTGRES_RESTORE_TABLE_CONTRACTS.map((spec) => ({
    id: spec.datasetId,
    module:
      options.kind === 'identity' && (options.expectedRows[spec.datasetId] ?? 0) > 0
        ? 'users'
        : 'tenant-runtime',
    kind:
      options.kind === 'identity' && (options.expectedRows[spec.datasetId] ?? 0) > 0
        ? 'users'
        : 'settings',
    store: 'database',
    schemaVersion: 1,
    disposition: 'include',
  }));
  const expectedRows = Object.freeze(
    Object.fromEntries(datasets.map(({ id }) => [id, options.expectedRows[id] ?? 0]))
  );
  const passphrase = hex(randomBytes(32));
  const session = await createTenantBundleKeyEnvelope(passphrase);
  const manifest: TenantBundleManifest = {
    formatVersion: 1,
    bundleId: hex(session.envelope.subarray(1, 17)),
    source: {
      tenantId: options.tenantId,
      issuer: options.issuer,
      productVersion: '0.4.2',
    },
    snapshotId: `synthetic-${options.kind}-${randomUUID()}`,
    boundaryUnixMs: now,
    inventoryDigestSha256: restoreEvidenceDigest(datasets),
    selection: {
      settings: true,
      users: true,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 7 },
    },
    datasets,
  };
  const encoded = await encodeTenantBackupContainerV2({
    manifest,
    session,
    datasets: (async function* () {
      for (const { id } of datasets) {
        yield {
          datasetId: id,
          chunks: (async function* () {
            for (let index = 0; index < expectedRows[id]; index++) {
              yield new TextEncoder().encode(`${JSON.stringify(options.row(id, index, now))}\n`);
            }
          })(),
        };
      }
    })(),
  });
  const directory = await mkdtemp(join(await realpath(tmpdir()), `authrim-dsql-${options.kind}-`));
  const readers = new Set<VerifiedTenantBackupV2>();
  let closed = false;
  try {
    await chmod(directory, 0o700);
    const partPaths: string[] = [];
    for (const [index, bytes] of encoded.parts.entries()) {
      const path = join(directory, `encrypted-${index}.bin`);
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      partPaths.push(path);
    }
    const input: OpenVerifiedTenantBackupV2Input = {
      partPaths,
      receipt: {
        source: manifest.source,
        bundleId: manifest.bundleId,
        snapshotId: manifest.snapshotId,
        inventoryDigestSha256: manifest.inventoryDigestSha256,
        parts: encoded.parts.map((bytes) => ({
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })),
      },
      passphrase,
      selection: manifest.selection,
      datasets,
      maxSnapshotAgeMs: 60 * 60 * 1000,
    };
    const reopen = async () => {
      if (closed) invalid();
      const reader = await openVerifiedTenantBackupV2(input);
      if (closed) {
        await reader.close();
        return invalid();
      }
      readers.add(reader);
      return reader;
    };
    const backup = await reopen();
    return {
      backup,
      trustedReceiptDigest: restoreEvidenceDigest(input.receipt),
      tenantId: options.tenantId,
      expectedRows,
      reopen,
      async close() {
        if (closed) return;
        closed = true;
        const results = await Promise.allSettled([...readers].map((reader) => reader.close()));
        await rm(directory, { recursive: true, force: true });
        if (results.some((result) => result.status === 'rejected')) invalid();
      },
    };
  } catch {
    await Promise.allSettled([...readers].map((reader) => reader.close()));
    await rm(directory, { recursive: true, force: true });
    return invalid();
  }
}
