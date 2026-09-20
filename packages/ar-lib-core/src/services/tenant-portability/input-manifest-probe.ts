import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { TenantBundleReadLimits } from './bundle-framing';
import {
  decodeTenantBundleManifest,
  decodeTenantBundleImportManifest,
  encodeTenantBundleManifest,
  type TenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';
import type { TenantBackupInputIdentity } from './input-frame-reader';
import {
  readTenantBackupContainerV2Input,
  type TenantBackupContainerInputBucketV2,
} from './input-container-v2';

function fail(): never {
  throw new Error('backup_input_manifest_probe_failed');
}

function bundleId(session: TenantBundleKeyEnvelope): string {
  if (session.envelope.length !== 93 || session.envelope[0] !== 1) fail();
  return Array.from(session.envelope.subarray(1, 17), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/** Authenticate the pinned v2 object and its manifest/footer before persisting an import plan. */
export async function probeTenantBackupInputManifest(input: {
  bucket: TenantBackupContainerInputBucketV2;
  identity: Readonly<TenantBackupInputIdentity>;
  session: TenantBundleKeyEnvelope;
  limits: Readonly<TenantBundleReadLimits>;
  expected: Omit<TenantBundleManifestExpectation, 'bundleId'>;
  signal: AbortSignal;
  assertAuthorized: () => Promise<void>;
  selectionMode?: 'exact' | 'subset';
}): Promise<{
  manifest: TenantBundleManifest;
  expected: TenantBundleManifestExpectation;
}> {
  if (input.identity.size > input.limits.maxTotalBytes) fail();
  const expected: TenantBundleManifestExpectation = {
    bundleId: bundleId(input.session),
    source: structuredClone(input.expected.source),
    selection: structuredClone(input.expected.selection),
    datasets: input.expected.datasets.map((dataset) => ({ ...dataset })),
  };
  try {
    const decoded = await readTenantBackupContainerV2Input(input);
    const encoded = encodeTenantBundleManifest(decoded.manifest.backup, {
      bundleId: decoded.manifest.backup.bundleId,
      source: decoded.manifest.backup.source,
      selection: decoded.manifest.backup.selection,
      datasets: decoded.manifest.backup.datasets,
    });
    const manifest =
      input.selectionMode === 'subset'
        ? decodeTenantBundleImportManifest(encoded, expected)
        : decodeTenantBundleManifest(encoded, expected);
    if (
      decoded.manifest.datasets.length !== manifest.datasets.length ||
      decoded.manifest.datasets.some(
        (dataset, index) => dataset.id !== manifest.datasets[index]?.id
      )
    )
      fail();
    return {
      manifest,
      expected: {
        bundleId: manifest.bundleId,
        source: structuredClone(manifest.source),
        selection: structuredClone(manifest.selection),
        datasets: manifest.datasets.map((dataset) => ({ ...dataset })),
      },
    };
  } catch {
    return fail();
  }
}
