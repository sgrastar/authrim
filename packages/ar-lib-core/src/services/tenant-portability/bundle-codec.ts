import { decryptTenantBundleStream, encryptTenantBundleStream } from './bundle-cipher';
import {
  decodeTenantBundleManifest,
  encodeTenantBundleManifest,
  type TenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { TenantBundleReadLimits } from './bundle-framing';

const MAX_PAYLOAD = 1024 * 1024 - 7;
const END_BYTES = 51; // type, dataset index, chunk count, byte count, chain SHA256

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
async function nextChain(chain: Uint8Array, frame: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const input = new Uint8Array(chain.length + frame.length);
  input.set(chain);
  input.set(frame, chain.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/** Encodes every declared dataset, including empty and non-materialized ones. */
export async function* encodeTenantBundle(
  manifest: TenantBundleManifest,
  datasets: AsyncIterable<TenantBundleDatasetSource>,
  session: TenantBundleKeyEnvelope,
  expected: TenantBundleManifestExpectation
): AsyncGenerator<Uint8Array> {
  assertEnvelope(session, expected);
  const encoded = encodeTenantBundleManifest(manifest, expected);
  // Detach from caller mutation while waiting for asynchronous storage reads.
  const pinned = decodeTenantBundleManifest(encoded, expected);
  async function* plain() {
    const first = new Uint8Array(encoded.length + 1);
    first[0] = 1;
    first.set(encoded, 1);
    yield first;
    let index = 0;
    for await (const source of datasets) {
      const descriptor = pinned.datasets[index];
      if (!descriptor || source.datasetId !== descriptor.id) invalid();
      let count = 0;
      let total = 0;
      let chain = new Uint8Array(32);
      for await (const bytes of source.chunks) {
        if (
          descriptor.disposition !== 'include' ||
          !(bytes instanceof Uint8Array) ||
          !bytes.length ||
          bytes.length > MAX_PAYLOAD ||
          count >= 0xffffffff
        )
          invalid();
        const frame = new Uint8Array(7 + bytes.length);
        frame[0] = 2;
        const view = new DataView(frame.buffer);
        view.setUint16(1, index);
        view.setUint32(3, count);
        frame.set(bytes, 7);
        chain = await nextChain(chain, frame);
        count++;
        total += bytes.length;
        if (!Number.isSafeInteger(total)) invalid();
        yield frame;
      }
      const end = new Uint8Array(END_BYTES);
      end[0] = 3;
      const view = new DataView(end.buffer);
      view.setUint16(1, index);
      view.setBigUint64(3, BigInt(count));
      view.setBigUint64(11, BigInt(total));
      end.set(chain, 19);
      yield end;
      index++;
    }
    if (index !== pinned.datasets.length) invalid();
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
  let manifest: TenantBundleManifest | undefined;
  let index = 0;
  let count = 0;
  let total = 0;
  let chain = new Uint8Array(32);
  for await (const event of decryptTenantBundleStream(source, session, limits)) {
    if (event.kind === 'complete') {
      if (!manifest || index !== manifest.datasets.length || count !== 0) invalid();
      yield { kind: 'complete', manifest };
      return;
    }
    const frame = event.bytes;
    if (!manifest) {
      if (frame[0] !== 1) invalid();
      manifest = decodeTenantBundleManifest(frame.subarray(1), expected);
      // Yield a detached copy; observers cannot alter the parser's trusted state.
      yield { kind: 'manifest', manifest: structuredClone(manifest) };
      continue;
    }
    const descriptor = manifest.datasets[index];
    if (!descriptor || frame.length < 3) invalid();
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    if (view.getUint16(1) !== index) invalid();
    if (frame[0] === 2) {
      if (
        descriptor.disposition !== 'include' ||
        frame.length <= 7 ||
        frame.length > MAX_PAYLOAD + 7 ||
        count >= 0xffffffff ||
        view.getUint32(3) !== count
      )
        invalid();
      chain = await nextChain(chain, frame);
      count++;
      total += frame.length - 7;
      if (!Number.isSafeInteger(total)) invalid();
      yield { kind: 'chunk', datasetId: descriptor.id, ordinal: count - 1, bytes: frame.slice(7) };
    } else if (frame[0] === 3) {
      if (
        frame.length !== END_BYTES ||
        view.getBigUint64(3) !== BigInt(count) ||
        view.getBigUint64(11) !== BigInt(total) ||
        !frame.subarray(19).every((byte, i) => byte === chain[i])
      )
        invalid();
      yield {
        kind: 'dataset_end',
        datasetId: descriptor.id,
        chunks: count,
        bytes: total,
        chainSha256: hex(chain),
      };
      index++;
      count = 0;
      total = 0;
      chain = new Uint8Array(32);
    } else invalid();
  }
  invalid();
}
