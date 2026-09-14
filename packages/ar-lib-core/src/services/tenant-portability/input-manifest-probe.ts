import { TenantBundleCipherDecoder } from './bundle-cipher-decoder';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { TenantBundleReadLimits } from './bundle-framing';
import {
  decodeTenantBundleManifest,
  type TenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';
import { readTenantBackupInputFrame, type TenantBackupInputIdentity } from './input-frame-reader';

function fail(): never {
  throw new Error('backup_input_manifest_probe_failed');
}

function bundleId(session: TenantBundleKeyEnvelope): string {
  if (session.envelope.length !== 93 || session.envelope[0] !== 1) fail();
  return Array.from(session.envelope.subarray(1, 17), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/**
 * Authenticate only the cipher header and first plaintext content frame. The first content frame is
 * the canonical manifest by contract. This has no persistence side effects; callers must recheck the
 * live operation before pinning the returned manifest in an execution inventory.
 */
export async function probeTenantBackupInputManifest(input: {
  bucket: Parameters<typeof readTenantBackupInputFrame>[0]['bucket'];
  identity: Readonly<TenantBackupInputIdentity>;
  session: TenantBundleKeyEnvelope;
  limits: Readonly<TenantBundleReadLimits>;
  expected: Omit<TenantBundleManifestExpectation, 'bundleId'>;
  signal: AbortSignal;
  assertAuthorized: () => Promise<void>;
}): Promise<{
  manifest: TenantBundleManifest;
  expected: TenantBundleManifestExpectation;
}> {
  if (input.limits.maxFrames < 2) fail();
  const expected: TenantBundleManifestExpectation = {
    bundleId: bundleId(input.session),
    source: structuredClone(input.expected.source),
    selection: structuredClone(input.expected.selection),
    datasets: input.expected.datasets.map((dataset) => ({ ...dataset })),
  };
  const common = {
    bucket: input.bucket,
    identity: input.identity,
    limits: input.limits,
    signal: input.signal,
    assertAuthorized: input.assertAuthorized,
  };
  try {
    const header = await readTenantBackupInputFrame({
      ...common,
      cursor: { offset: 0, frames: 0 },
    });
    if (!header) fail();
    const cipher = await TenantBundleCipherDecoder.create(
      header.payload,
      input.session,
      input.limits
    );
    const content = await readTenantBackupInputFrame({ ...common, cursor: header.cursor });
    if (!content) fail();
    const opened = await cipher.step(content.payload);
    if (opened.kind !== 'chunk' || opened.bytes[0] !== 1) fail();
    const manifest = decodeTenantBundleManifest(opened.bytes.subarray(1), expected);
    input.signal.throwIfAborted();
    await input.assertAuthorized();
    input.signal.throwIfAborted();
    return { manifest, expected };
  } catch {
    return fail();
  }
}
