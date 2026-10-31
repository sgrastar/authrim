import {
  encodeTenantBundleManifest,
  decodeTenantBundleManifest,
  type TenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';

export const TENANT_BUNDLE_MAX_DATASET_CHUNK_BYTES = 1024 * 1024 - 7;
export interface TenantBundleEncoderCheckpoint {
  version: 1;
  manifestSha256: string;
  phase: 'manifest' | 'datasets' | 'done';
  datasetIndex: number;
  chunks: number;
  bytes: number;
  chainSha256: string;
}
export type TenantBundleEncoderCommand =
  | { kind: 'manifest' }
  | { kind: 'chunk'; datasetId: string; bytes: Uint8Array }
  | { kind: 'end'; datasetId: string };
const ZERO_CHAIN = '0'.repeat(64);
function invalid(): never {
  throw new Error('invalid_tenant_bundle_encoder_state');
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Plain content framing only. Checkpoints contain counters/digests, never row bytes or keys.
 * Restore only an operation-owned durable checkpoint committed with the ciphertext receipt and
 * source cursor. Structural validation cannot establish the authenticity of a supplied checkpoint.
 */
export class TenantBundleContentEncoder {
  private busy = false;
  private constructor(
    private readonly encodedManifest: Uint8Array,
    private readonly manifest: TenantBundleManifest,
    private state: TenantBundleEncoderCheckpoint
  ) {}
  static async create(
    manifest: TenantBundleManifest,
    expected: TenantBundleManifestExpectation,
    checkpoint?: TenantBundleEncoderCheckpoint
  ): Promise<TenantBundleContentEncoder> {
    const encoded = encodeTenantBundleManifest(manifest, expected);
    const pinned = decodeTenantBundleManifest(encoded, expected);
    const digest = hex(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(encoded)))
    );
    const state: TenantBundleEncoderCheckpoint = checkpoint
      ? { ...checkpoint }
      : {
          version: 1,
          manifestSha256: digest,
          phase: 'manifest',
          datasetIndex: 0,
          chunks: 0,
          bytes: 0,
          chainSha256: ZERO_CHAIN,
        };
    if (
      state.version !== 1 ||
      state.manifestSha256 !== digest ||
      !['manifest', 'datasets', 'done'].includes(state.phase) ||
      !Number.isInteger(state.datasetIndex) ||
      state.datasetIndex < 0 ||
      state.datasetIndex > pinned.datasets.length ||
      !Number.isSafeInteger(state.chunks) ||
      state.chunks < 0 ||
      state.chunks > 0xffffffff ||
      !Number.isSafeInteger(state.bytes) ||
      state.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(state.chainSha256)
    )
      invalid();
    if (
      (state.chunks === 0 && (state.bytes !== 0 || state.chainSha256 !== ZERO_CHAIN)) ||
      (state.chunks > 0 &&
        (state.bytes < state.chunks ||
          state.bytes > state.chunks * TENANT_BUNDLE_MAX_DATASET_CHUNK_BYTES)) ||
      (state.phase === 'manifest' && (state.datasetIndex !== 0 || state.chunks !== 0)) ||
      (state.phase === 'done' &&
        (state.datasetIndex !== pinned.datasets.length || state.chunks !== 0)) ||
      (state.phase === 'datasets' &&
        (state.datasetIndex >= pinned.datasets.length ||
          (pinned.datasets[state.datasetIndex].disposition !== 'include' && state.chunks !== 0)))
    )
      invalid();
    return new TenantBundleContentEncoder(encoded, pinned, state);
  }
  checkpoint(): TenantBundleEncoderCheckpoint {
    if (this.busy) invalid();
    return { ...this.state };
  }
  /** Caller persists next checkpoint only together with the returned frame's durable receipt. */
  async step(command: TenantBundleEncoderCommand): Promise<Uint8Array> {
    if (this.busy) invalid();
    this.busy = true;
    try {
      const previous = this.state;
      if (command.kind === 'manifest') {
        if (previous.phase !== 'manifest') invalid();
        const frame = new Uint8Array(this.encodedManifest.length + 1);
        frame[0] = 1;
        frame.set(this.encodedManifest, 1);
        this.state = { ...previous, phase: this.manifest.datasets.length ? 'datasets' : 'done' };
        return frame;
      }
      const descriptor = this.manifest.datasets[previous.datasetIndex];
      if (previous.phase !== 'datasets' || !descriptor || command.datasetId !== descriptor.id)
        invalid();
      if (command.kind === 'chunk') {
        if (
          descriptor.disposition !== 'include' ||
          !(command.bytes instanceof Uint8Array) ||
          !command.bytes.length ||
          command.bytes.length > TENANT_BUNDLE_MAX_DATASET_CHUNK_BYTES ||
          previous.chunks >= 0xffffffff
        )
          invalid();
        const bytes = previous.bytes + command.bytes.length;
        if (!Number.isSafeInteger(bytes)) invalid();
        const frame = new Uint8Array(7 + command.bytes.length);
        frame[0] = 2;
        const view = new DataView(frame.buffer);
        view.setUint16(1, previous.datasetIndex);
        view.setUint32(3, previous.chunks);
        frame.set(command.bytes, 7);
        const chainInput = new Uint8Array(32 + frame.length);
        for (let i = 0; i < 32; i++)
          chainInput[i] = parseInt(previous.chainSha256.slice(i * 2, i * 2 + 2), 16);
        chainInput.set(frame, 32);
        const chainSha256 = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', chainInput)));
        this.state = { ...previous, chunks: previous.chunks + 1, bytes, chainSha256 };
        return frame;
      }
      if (command.kind !== 'end') invalid();
      const frame = new Uint8Array(51);
      frame[0] = 3;
      const view = new DataView(frame.buffer);
      view.setUint16(1, previous.datasetIndex);
      view.setBigUint64(3, BigInt(previous.chunks));
      view.setBigUint64(11, BigInt(previous.bytes));
      for (let i = 0; i < 32; i++)
        frame[19 + i] = parseInt(previous.chainSha256.slice(i * 2, i * 2 + 2), 16);
      const datasetIndex = previous.datasetIndex + 1;
      this.state = {
        ...previous,
        datasetIndex,
        chunks: 0,
        bytes: 0,
        chainSha256: ZERO_CHAIN,
        phase: datasetIndex === this.manifest.datasets.length ? 'done' : 'datasets',
      };
      return frame;
    } finally {
      this.busy = false;
    }
  }
}
