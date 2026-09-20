import {
  decodeTenantBundleFrames,
  encodeTenantBundleFrames,
  type TenantBundleReadLimits,
} from './bundle-framing';
import { deriveTenantBundleStreamKey, type TenantBundleKeyEnvelope } from './bundle-key-envelope';

const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNKS = 0xffffffff;
const HEADER_LENGTH = 125; // key envelope (93) + fresh stream salt (32)

export { TenantBundleCipherError, tenantBundleCipherParameters } from './bundle-cipher-parameters';
import { TenantBundleCipherError, tenantBundleCipherParameters } from './bundle-cipher-parameters';
import { TenantBundleCipherDecoder } from './bundle-cipher-decoder';
function invalid(): never {
  throw new TenantBundleCipherError();
}

/** Encrypt opaque module-codec chunks. Never treats chunk JSON as executable input. */
export async function* encryptTenantBundleStream(
  source: AsyncIterable<Uint8Array>,
  session: TenantBundleKeyEnvelope
): AsyncGenerator<Uint8Array> {
  if (session.envelope.length !== 93 || session.envelope[0] !== 1) invalid();
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(session.envelope);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  header.set(salt, 93);
  const key = await deriveTenantBundleStreamKey(session.contentKey, salt);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', header));
  async function* frames() {
    yield header;
    let count = 0;
    let bytes = 0;
    async function seal(plain: Uint8Array<ArrayBuffer>, type: number) {
      const encrypted = new Uint8Array(
        await crypto.subtle.encrypt(tenantBundleCipherParameters(hash, count, type), key, plain)
      );
      const frame = new Uint8Array(encrypted.length + 1);
      frame[0] = type;
      frame.set(encrypted, 1);
      return frame;
    }
    for await (const chunk of source) {
      if (
        !(chunk instanceof Uint8Array) ||
        !chunk.length ||
        chunk.length > MAX_CHUNK_BYTES ||
        count >= MAX_CHUNKS
      )
        invalid();
      bytes += chunk.length;
      yield await seal(new Uint8Array(chunk), 1);
      count++;
    }
    const footer = new Uint8Array(16);
    new DataView(footer.buffer).setBigUint64(0, BigInt(count));
    new DataView(footer.buffer).setBigUint64(8, BigInt(bytes));
    yield await seal(footer, 2);
  }
  yield* encodeTenantBundleFrames(frames());
}

export type TenantBundleDecryptionEvent =
  | { kind: 'chunk'; bytes: Uint8Array }
  | { kind: 'complete'; chunks: number; bytes: number };

/**
 * Authenticated chunks remain provisional until `complete`. Consumers may write
 * only to isolated staging; module/manifest/reference validation is still required.
 */
export async function* decryptTenantBundleStream(
  source: AsyncIterable<Uint8Array>,
  session: TenantBundleKeyEnvelope,
  limits: TenantBundleReadLimits
): AsyncGenerator<TenantBundleDecryptionEvent> {
  let decoder: TenantBundleCipherDecoder | undefined;
  for await (const frame of decodeTenantBundleFrames(source, limits)) {
    if (!decoder) {
      decoder = await TenantBundleCipherDecoder.create(frame, session, limits);
      continue;
    }
    const event = await decoder.step(frame);
    if (event.kind === 'chunk') yield event;
  }
  const state = decoder?.checkpoint();
  if (!state?.complete) invalid();
  yield { kind: 'complete', chunks: state.chunks, bytes: state.bytes };
}
