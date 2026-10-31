import {
  TenantBundleContentEncoder,
  type TenantBundleEncoderCheckpoint,
  TENANT_BUNDLE_MAX_DATASET_CHUNK_BYTES,
} from './bundle-encoder-state';
import {
  decodeTenantBundleManifest,
  encodeTenantBundleManifest,
  type TenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';
import type { TenantBundleContentEvent } from './bundle-codec';
function invalid(): never {
  throw new Error('invalid_tenant_bundle_content');
}

/**
 * Content validation over authenticated plaintext frames. Checkpoints are operation-owned counters
 * and hashes, never uploaded state. Commit together with cipher/input offsets and staging receipts.
 * Events remain provisional until cipher footer, transport EOF and all module/reference checks pass.
 */
export class TenantBundleContentDecoder {
  private busy = false;
  private finished = false;
  private constructor(
    private readonly manifest: TenantBundleManifest,
    private readonly expected: TenantBundleManifestExpectation,
    private state: TenantBundleEncoderCheckpoint
  ) {}
  static async create(
    manifest: TenantBundleManifest,
    expected: TenantBundleManifestExpectation,
    checkpoint?: TenantBundleEncoderCheckpoint
  ): Promise<TenantBundleContentDecoder> {
    if (
      checkpoint &&
      Object.keys(checkpoint).sort().join(',') !==
        'bytes,chainSha256,chunks,datasetIndex,manifestSha256,phase,version'
    )
      invalid();
    const pinnedExpected = structuredClone(expected);
    const pinned = decodeTenantBundleManifest(
      encodeTenantBundleManifest(manifest, pinnedExpected),
      pinnedExpected
    );
    const encoder = await TenantBundleContentEncoder.create(
      pinned,
      pinnedExpected,
      checkpoint ? { ...checkpoint } : undefined
    );
    return new TenantBundleContentDecoder(pinned, pinnedExpected, encoder.checkpoint());
  }
  checkpoint(): TenantBundleEncoderCheckpoint {
    if (this.busy) invalid();
    return { ...this.state };
  }
  async step(input: Uint8Array): Promise<Exclude<TenantBundleContentEvent, { kind: 'complete' }>> {
    if (
      this.busy ||
      this.finished ||
      this.state.phase === 'done' ||
      input.length > TENANT_BUNDLE_MAX_DATASET_CHUNK_BYTES + 7
    )
      invalid();
    this.busy = true;
    try {
      const frame = new Uint8Array(input);
      const previous = this.state;
      const encoder = await TenantBundleContentEncoder.create(
        this.manifest,
        this.expected,
        previous
      );
      let encoded: Uint8Array;
      let event: Exclude<TenantBundleContentEvent, { kind: 'complete' }>;
      if (previous.phase === 'manifest') {
        encoded = await encoder.step({ kind: 'manifest' });
        event = { kind: 'manifest', manifest: structuredClone(this.manifest) };
      } else {
        const dataset = this.manifest.datasets[previous.datasetIndex];
        if (!dataset || frame.length < 3) invalid();
        if (frame[0] === 2 && frame.length > 7) {
          const bytes = frame.slice(7);
          encoded = await encoder.step({ kind: 'chunk', datasetId: dataset.id, bytes });
          event = { kind: 'chunk', datasetId: dataset.id, ordinal: previous.chunks, bytes };
        } else if (frame[0] === 3) {
          encoded = await encoder.step({ kind: 'end', datasetId: dataset.id });
          event = {
            kind: 'dataset_end',
            datasetId: dataset.id,
            chunks: previous.chunks,
            bytes: previous.bytes,
            chainSha256: previous.chainSha256,
          };
        } else invalid();
      }
      if (encoded.length !== frame.length || !encoded.every((byte, index) => byte === frame[index]))
        invalid();
      this.state = encoder.checkpoint();
      return event;
    } catch {
      return invalid();
    } finally {
      this.busy = false;
    }
  }
  /** Call only after an authenticated cipher footer and transport EOF, never from dataset EOF. */
  finish(): Extract<TenantBundleContentEvent, { kind: 'complete' }> {
    if (this.busy || this.finished || this.state.phase !== 'done') invalid();
    this.finished = true;
    return { kind: 'complete', manifest: structuredClone(this.manifest) };
  }
}
