import { deriveTenantBundleStreamKey, type TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { TenantBundleReadLimits } from './bundle-framing';
import { TenantBundleCipherError, tenantBundleCipherParameters } from './bundle-cipher-parameters';

export interface TenantBundleCipherCheckpoint {
  version: 1;
  headerSha256: string;
  chunks: number;
  bytes: number;
  complete: boolean;
}
const MAX_CHUNK = 1024 * 1024;
const MAX_CHUNKS = 0xffffffff;
const invalid = (): never => {
  throw new TenantBundleCipherError();
};
const transportBytes = (state: TenantBundleCipherCheckpoint) =>
  137 + state.bytes + 21 * state.chunks + (state.complete ? 37 : 0);

/**
 * Decrypt one already-framed ciphertext at a time. Resume only operation-owned checkpoints bound
 * to the same immutable input and committed with the frame offset and staging receipt. Structural
 * checkpoint checks cannot authenticate externally supplied counters. Plain rows/keys are not saved.
 * Footer completion is provisional until the transport reader also confirms EOF and content/module
 * validation succeeds. This decoder never grants permission to apply or activate imported data.
 */
export class TenantBundleCipherDecoder {
  private busy = false;
  private constructor(
    private readonly key: CryptoKey,
    private readonly headerHash: Uint8Array<ArrayBuffer>,
    private readonly limits: TenantBundleReadLimits,
    private state: TenantBundleCipherCheckpoint
  ) {}
  static async create(
    header: Uint8Array,
    session: TenantBundleKeyEnvelope,
    limits: TenantBundleReadLimits,
    checkpoint?: TenantBundleCipherCheckpoint
  ): Promise<TenantBundleCipherDecoder> {
    const pinned = new Uint8Array(header);
    const bound = { ...limits };
    const restored = checkpoint ? { ...checkpoint } : undefined;
    if (
      pinned.length !== 125 ||
      session.envelope.length !== 93 ||
      session.envelope[0] !== 1 ||
      !pinned.subarray(0, 93).every((b, i) => b === session.envelope[i]) ||
      !Number.isSafeInteger(bound.maxTotalBytes) ||
      bound.maxTotalBytes < 137 ||
      !Number.isSafeInteger(bound.maxFrames) ||
      bound.maxFrames < 1
    )
      invalid();
    const headerHash = new Uint8Array(await crypto.subtle.digest('SHA-256', pinned));
    const headerSha256 = Array.from(headerHash, (b) => b.toString(16).padStart(2, '0')).join('');
    const state = restored
      ? restored
      : { version: 1 as const, headerSha256, chunks: 0, bytes: 0, complete: false };
    if (
      Object.keys(state).sort().join(',') !== 'bytes,chunks,complete,headerSha256,version' ||
      state.version !== 1 ||
      state.headerSha256 !== headerSha256 ||
      typeof state.complete !== 'boolean' ||
      !Number.isSafeInteger(state.chunks) ||
      state.chunks < 0 ||
      state.chunks > MAX_CHUNKS ||
      !Number.isSafeInteger(state.bytes) ||
      state.bytes < state.chunks ||
      state.bytes > state.chunks * MAX_CHUNK ||
      transportBytes(state) > bound.maxTotalBytes ||
      state.chunks + 1 + Number(state.complete) > bound.maxFrames
    )
      invalid();
    const key = await deriveTenantBundleStreamKey(session.contentKey, pinned.slice(93));
    return new TenantBundleCipherDecoder(key, headerHash, bound, state);
  }
  checkpoint(): TenantBundleCipherCheckpoint {
    if (this.busy) invalid();
    return { ...this.state };
  }
  async step(
    input: Uint8Array
  ): Promise<{ kind: 'chunk'; bytes: Uint8Array } | { kind: 'footer' }> {
    if (this.busy || this.state.complete) invalid();
    this.busy = true;
    try {
      const frame = new Uint8Array(input);
      const type = frame[0];
      if (
        frame.length < 17 ||
        (type !== 1 && type !== 2) ||
        (type === 1 && (this.state.chunks >= MAX_CHUNKS || frame.length > MAX_CHUNK + 17)) ||
        (type === 2 && frame.length !== 33) ||
        transportBytes(this.state) + frame.length + 4 > this.limits.maxTotalBytes ||
        this.state.chunks + 2 > this.limits.maxFrames
      )
        invalid();
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          tenantBundleCipherParameters(this.headerHash, this.state.chunks, type),
          this.key,
          frame.slice(1)
        )
      );
      if (type === 1) {
        if (!plain.length) invalid();
        this.state = {
          ...this.state,
          chunks: this.state.chunks + 1,
          bytes: this.state.bytes + plain.length,
        };
        return { kind: 'chunk', bytes: plain };
      }
      const footer = new DataView(plain.buffer);
      if (
        footer.getBigUint64(0) !== BigInt(this.state.chunks) ||
        footer.getBigUint64(8) !== BigInt(this.state.bytes)
      )
        invalid();
      this.state = { ...this.state, complete: true };
      return { kind: 'footer' };
    } catch {
      return invalid();
    } finally {
      this.busy = false;
    }
  }
}
