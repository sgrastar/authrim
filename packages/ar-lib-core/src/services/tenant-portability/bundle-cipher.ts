import {
  decodeTenantBundleFrames,
  encodeTenantBundleFrames,
  type TenantBundleReadLimits,
} from './bundle-framing';
import { deriveTenantBundleStreamKey, type TenantBundleKeyEnvelope } from './bundle-key-envelope';

const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNKS = 0xffffffff;
const HEADER_LENGTH = 125; // key envelope (93) + fresh stream salt (32)

export class TenantBundleCipherError extends Error {
  constructor() {
    super('invalid_tenant_bundle_ciphertext');
    this.name = 'TenantBundleCipherError';
  }
}
function invalid(): never {
  throw new TenantBundleCipherError();
}
function parameters(hash: Uint8Array<ArrayBuffer>, sequence: number, type: number) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(sequence));
  const additionalData = new Uint8Array(hash.length + 9);
  additionalData.set(hash);
  new DataView(additionalData.buffer).setBigUint64(hash.length, BigInt(sequence));
  additionalData[additionalData.length - 1] = type;
  return { name: 'AES-GCM', iv, additionalData, tagLength: 128 };
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
        await crypto.subtle.encrypt(parameters(hash, count, type), key, plain)
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
  let key: CryptoKey | undefined;
  let hash: Uint8Array<ArrayBuffer> | undefined;
  let count = 0;
  let bytes = 0;
  let complete = false;
  for await (const frame of decodeTenantBundleFrames(source, limits)) {
    if (!key) {
      if (
        frame.length !== HEADER_LENGTH ||
        !frame.subarray(0, 93).every((b, i) => b === session.envelope[i])
      )
        invalid();
      key = await deriveTenantBundleStreamKey(session.contentKey, frame.slice(93));
      hash = new Uint8Array(await crypto.subtle.digest('SHA-256', frame));
      continue;
    }
    if (complete || !hash || frame.length < 17 || (frame[0] !== 1 && frame[0] !== 2)) invalid();
    const type = frame[0];
    if (
      (type === 1 && (count >= MAX_CHUNKS || frame.length > MAX_CHUNK_BYTES + 17)) ||
      (type === 2 && frame.length !== 33)
    )
      invalid();
    let plain: Uint8Array<ArrayBuffer>;
    try {
      plain = new Uint8Array(
        await crypto.subtle.decrypt(parameters(hash, count, type), key, frame.slice(1))
      );
    } catch {
      invalid();
    }
    if (type === 1) {
      if (!plain.length) invalid();
      bytes += plain.length;
      count++;
      yield { kind: 'chunk', bytes: plain };
    } else {
      const footer = new DataView(plain.buffer);
      if (footer.getBigUint64(0) !== BigInt(count) || footer.getBigUint64(8) !== BigInt(bytes))
        invalid();
      complete = true;
    }
  }
  if (!complete) invalid();
  yield { kind: 'complete', chunks: count, bytes };
}
