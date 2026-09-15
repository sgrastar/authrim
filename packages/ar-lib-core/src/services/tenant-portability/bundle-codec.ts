import { TenantBundleContentDecoder } from './bundle-content-decoder';
import { TenantBundleContentEncoder } from './bundle-encoder-state';
export { TENANT_BUNDLE_MAX_DATASET_CHUNK_BYTES } from './bundle-encoder-state';
import { decryptTenantBundleStream, encryptTenantBundleStream } from './bundle-cipher';
import {
  decodeTenantBundleManifest,
  type TenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { TenantBundleReadLimits } from './bundle-framing';

export interface TenantBundleDatasetSource {
  datasetId: string;
  chunks: AsyncIterable<Uint8Array>;
}
export type TenantBundleContentEvent =
  | { kind: 'manifest'; manifest: TenantBundleManifest }
  | { kind: 'chunk'; datasetId: string; ordinal: number; bytes: Uint8Array }
  | { kind: 'dataset_end'; datasetId: string; chunks: number; bytes: number; chainSha256: string }
  | { kind: 'complete'; manifest: TenantBundleManifest };

function invalid(): never {
  throw new Error('invalid_tenant_bundle_content');
}
function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function assertEnvelope(
  session: TenantBundleKeyEnvelope,
  expected: TenantBundleManifestExpectation
) {
  if (session.envelope.length !== 93 || hex(session.envelope.subarray(1, 17)) !== expected.bundleId)
    invalid();
}
/** Encodes every declared dataset, including empty and non-materialized ones. */
export async function* encodeTenantBundle(
  manifest: TenantBundleManifest,
  datasets: AsyncIterable<TenantBundleDatasetSource>,
  session: TenantBundleKeyEnvelope,
  expected: TenantBundleManifestExpectation
): AsyncGenerator<Uint8Array> {
  assertEnvelope(session, expected);
  const encoder = await TenantBundleContentEncoder.create(manifest, expected);
  async function* plain() {
    yield await encoder.step({ kind: 'manifest' });
    for await (const source of datasets) {
      for await (const bytes of source.chunks)
        yield await encoder.step({ kind: 'chunk', datasetId: source.datasetId, bytes });
      yield await encoder.step({ kind: 'end', datasetId: source.datasetId });
    }
    if (encoder.checkpoint().phase !== 'done') invalid();
  }
  yield* encryptTenantBundleStream(plain(), session);
}

/**
 * No DB/filesystem writes. All events are provisional until complete, and complete
 * proves transport/dataset integrity only. Installed module validators must still
 * check records, references, authorization and restore preconditions before activation.
 */
export async function* decodeTenantBundle(
  source: AsyncIterable<Uint8Array>,
  session: TenantBundleKeyEnvelope,
  expected: TenantBundleManifestExpectation,
  limits: TenantBundleReadLimits
): AsyncGenerator<TenantBundleContentEvent> {
  assertEnvelope(session, expected);
  let decoder: TenantBundleContentDecoder | undefined;
  for await (const event of decryptTenantBundleStream(source, session, limits)) {
    if (event.kind === 'complete') {
      if (!decoder) invalid();
      yield decoder.finish();
      return;
    }
    if (!decoder) {
      if (event.bytes[0] !== 1) invalid();
      const manifest = decodeTenantBundleManifest(event.bytes.subarray(1), expected);
      decoder = await TenantBundleContentDecoder.create(manifest, expected);
    }
    yield await decoder.step(event.bytes);
  }
  invalid();
}
