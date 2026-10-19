import {
  decryptTenantBackupFrameV2,
  openTenantBackupContainerHeaderV2,
  readTenantBackupFramePrefixV2,
  TENANT_BACKUP_CONTAINER_V2_LIMITS,
  type TenantBackupContainerCipherV2,
  type TenantBackupContainerDatasetV2,
} from './backup-container-v2';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import {
  decodeTenantBackupContainerRow,
  parseTenantBackupContainerRowCursor,
  TENANT_BACKUP_CONTAINER_MAX_ROW_BYTES,
} from './container-dataset-reader';
import type { DatabaseAdapter } from '../../db/adapter';
import { walkTenantBackupContainerV2Frames } from './input-container-verification';
import { TenantBackupContainerInputStore } from './container-input-store';
import {
  assertTenantBackupInputFrameChain,
  TenantBackupInputFrameStore,
  type TenantBackupInputFrame,
} from './input-frame-index';
import type { TenantBackupInputIdentity } from './input-frame-reader';
import type { TenantBackupLease } from './operation-store';
import {
  PinnedTenantBackupInputObject,
  type TenantBackupContainerInputBucketV2,
} from './pinned-input-object';

/** Decrypted frames kept per reader: a row-aligned row needs one, a row split across frames two. */
const CACHED_FRAMES = 2;
/** Readers a caller should keep open at once; each holds up to two decrypted frames. */
export const TENANT_BACKUP_INPUT_READERS_KEPT = 2;
/**
 * Frames one row may span. Encoders split only rows longer than a 12 MiB capacity part, and rows
 * are at most 16 MiB, so real rows span at most three frames.
 */
const MAX_ROW_FRAMES = 4;
/** Frames a whole-dataset read may touch; callers use it only for datasets of at most 4 MiB. */
const MAX_READ_ALL_FRAMES = 64;

function concat(pieces: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    output.set(piece, offset);
    offset += piece.length;
  }
  return output;
}

/** Inputs verified before the frame index were at most 256 MiB in 12 MiB frames. */
const LEGACY_INDEX_MAX_FRAMES = 1024;

export interface TenantBackupContainerDatasetSource {
  readonly id: string;
  readonly rows: number;
  readonly bytes: number;
  /** Same cursor and failure semantics as `readNextTenantBackupContainerRow`. */
  readNextRow(sourceCursor: string | null): Promise<{ rowJson: string; nextCursor: string } | null>;
  /** The whole dataset; callers bound its size from `bytes` before calling. */
  readAll(): Promise<Uint8Array>;
  /** Whether `readAll()` stays within its frame bound; otherwise read row by row. */
  readonly canReadAll: boolean;
}

function fail(): never {
  throw new Error('backup_container_frame_reader_invalid');
}

/**
 * Read rows of a verified v2 input without decoding the whole container. The frame index and the
 * dataset table come from decode_input's durable records; every frame is fetched from the pinned
 * object and authenticated again (header hash, sequence and type are AES-GCM additional data), so a
 * stale or altered index can only make reads fail.
 */
export class TenantBackupContainerFrameReader {
  private readonly cache = new Map<number, Promise<Uint8Array>>();
  private readonly datasets: Map<string, TenantBackupContainerDatasetV2>;

  private constructor(
    private readonly object: PinnedTenantBackupInputObject,
    private readonly cipher: TenantBackupContainerCipherV2,
    private readonly frames: readonly TenantBackupInputFrame[],
    datasets: readonly TenantBackupContainerDatasetV2[]
  ) {
    this.datasets = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  }

  static async open(input: {
    object: PinnedTenantBackupInputObject;
    session: TenantBundleKeyEnvelope;
    frames: readonly TenantBackupInputFrame[];
    datasets: readonly TenantBackupContainerDatasetV2[];
    totalBytes: number;
  }): Promise<TenantBackupContainerFrameReader> {
    assertTenantBackupInputFrameChain(input.frames);
    const last = input.frames[input.frames.length - 1];
    if ((last ? last.plainOffset + last.plainBytes : 0) !== input.totalBytes) fail();
    let offset = 0;
    const ids = new Set<string>();
    for (const dataset of input.datasets) {
      if (
        !dataset?.id ||
        ids.has(dataset.id) ||
        dataset.offset !== offset ||
        !Number.isSafeInteger(dataset.bytes) ||
        dataset.bytes < 0 ||
        !Number.isSafeInteger(dataset.rows) ||
        dataset.rows < 0
      )
        fail();
      ids.add(dataset.id);
      offset += dataset.bytes;
    }
    if (offset !== input.totalBytes) fail();
    const cipher = await openTenantBackupContainerHeaderV2(
      await input.object.read(0, TENANT_BACKUP_CONTAINER_V2_LIMITS.headerBytes),
      input.session
    );
    return new TenantBackupContainerFrameReader(
      input.object,
      cipher,
      [...input.frames],
      input.datasets.map((dataset) => ({ ...dataset }))
    );
  }

  dataset(id: string): TenantBackupContainerDatasetSource {
    const dataset = this.datasets.get(id) ?? fail();
    const start = dataset.offset;
    const end = dataset.offset + dataset.bytes;
    const spanned = dataset.bytes ? this.frameIndex(end - 1) - this.frameIndex(start) + 1 : 0;
    return {
      id,
      rows: dataset.rows,
      bytes: dataset.bytes,
      canReadAll: spanned <= MAX_READ_ALL_FRAMES,
      readNextRow: async (sourceCursor) => {
        const offset = parseTenantBackupContainerRowCursor(sourceCursor, dataset.bytes);
        if (offset > 0 && (await this.range(start + offset - 1, start + offset, 1))[0] !== 10)
          fail();
        if (offset === dataset.bytes) return null;
        const limit = Math.min(end, start + offset + TENANT_BACKUP_CONTAINER_MAX_ROW_BYTES + 1);
        return decodeTenantBackupContainerRow(await this.row(start + offset, limit), offset);
      },
      readAll: () => this.range(start, end, MAX_READ_ALL_FRAMES),
    };
  }

  /**
   * The row starting at `from` (without its newline), found and assembled in one pass. A row may
   * span at most `MAX_ROW_FRAMES` frames, so a row cannot turn into an unbounded number of reads.
   */
  private async row(from: number, to: number): Promise<Uint8Array> {
    const pieces: Uint8Array[] = [];
    let position = from;
    while (position < to) {
      if (pieces.length === MAX_ROW_FRAMES) fail();
      const index = this.frameIndex(position);
      const frame = this.frames[index];
      const plain = await this.plain(index);
      const local = position - frame.plainOffset;
      const stop = Math.min(to, frame.plainOffset + frame.plainBytes) - frame.plainOffset;
      const found = plain.subarray(0, stop).indexOf(10, local);
      if (found >= 0) {
        pieces.push(plain.subarray(local, found));
        return pieces.length === 1 ? pieces[0] : concat(pieces);
      }
      pieces.push(plain.subarray(local, stop));
      position = frame.plainOffset + stop;
    }
    return fail();
  }

  /** Plaintext bytes [from, to), assembled across at most `maxFrames` frames. */
  private async range(from: number, to: number, maxFrames: number): Promise<Uint8Array> {
    if (from < 0 || to < from) fail();
    const output = new Uint8Array(to - from);
    let position = from;
    let frames = 0;
    while (position < to) {
      if (frames++ === maxFrames) fail();
      const index = this.frameIndex(position);
      const frame = this.frames[index];
      const plain = await this.plain(index);
      const stop = Math.min(to, frame.plainOffset + frame.plainBytes);
      output.set(
        plain.subarray(position - frame.plainOffset, stop - frame.plainOffset),
        position - from
      );
      position = stop;
    }
    return output;
  }

  /** The frame whose plaintext contains `position` (empty frames never contain a position). */
  private frameIndex(position: number): number {
    let low = 0;
    let high = this.frames.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.frames[middle].plainOffset <= position) low = middle;
      else high = middle - 1;
    }
    const frame = this.frames[low];
    if (!frame || position < frame.plainOffset || position >= frame.plainOffset + frame.plainBytes)
      fail();
    // Empty frames share their plainOffset with the next frame; the search lands on the last one.
    return low;
  }

  private plain(index: number): Promise<Uint8Array> {
    const cached = this.cache.get(index);
    if (cached) {
      this.cache.delete(index);
      this.cache.set(index, cached);
      return cached;
    }
    const frame = this.frames[index];
    const loaded = (async () => {
      const bytes = await this.object.read(frame.objectOffset, frame.frameBytes);
      const prefix = readTenantBackupFramePrefixV2(bytes.subarray(0, 9), frame.sequence);
      if (prefix.type !== 1 || prefix.frameBytes !== frame.frameBytes) fail();
      const plain = await decryptTenantBackupFrameV2(
        this.cipher,
        frame.sequence,
        1,
        bytes.subarray(9)
      );
      if (plain.length !== frame.plainBytes) fail();
      return plain;
    })();
    loaded.catch(() => this.cache.delete(index));
    this.cache.set(index, loaded);
    while (this.cache.size > CACHED_FRAMES) this.cache.delete(this.cache.keys().next().value!);
    return loaded;
  }
}

function receiptDatasets(statsJson: string): {
  datasets: TenantBackupContainerDatasetV2[];
  totalBytes: number;
} {
  let stats: { formatVersion?: unknown; datasets?: unknown; totalBytes?: unknown };
  try {
    stats = JSON.parse(statsJson) as typeof stats;
  } catch {
    return fail();
  }
  if (
    stats?.formatVersion !== 2 ||
    !Array.isArray(stats.datasets) ||
    !Number.isSafeInteger(stats.totalBytes)
  )
    fail();
  return {
    datasets: stats.datasets as TenantBackupContainerDatasetV2[],
    totalBytes: stats.totalBytes as number,
  };
}

/**
 * Keep at most `TENANT_BACKUP_INPUT_READERS_KEPT` readers in a per-lease cache. The most recent
 * use moves to the end; the oldest is dropped with its decrypted frames.
 */
export function rememberTenantBackupInputReader<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > TENANT_BACKUP_INPUT_READERS_KEPT) cache.delete(cache.keys().next().value!);
}

/**
 * Row and byte counts of every dataset of a verified input, from its receipt alone. decode_input
 * authenticated them and validation parsed every row, so planning needs no object reads.
 */
export async function loadVerifiedTenantBackupInputStats(input: {
  database: Pick<DatabaseAdapter, 'queryOne'>;
  lease: TenantBackupLease;
  now: () => number;
  bundleId: string;
  identity: Readonly<TenantBackupInputIdentity>;
}): Promise<ReadonlyMap<string, { rows: number; bytes: number }>> {
  const receipt = await new TenantBackupContainerInputStore(
    input.database,
    input.lease,
    input.now
  ).load(input.bundleId);
  if (
    receipt.object_key !== input.identity.key ||
    receipt.object_version !== input.identity.version ||
    receipt.object_etag !== input.identity.etag ||
    receipt.object_size !== input.identity.size
  )
    fail();
  const { datasets, totalBytes } = receiptDatasets(receipt.dataset_stats_json);
  let offset = 0;
  const stats = new Map<string, { rows: number; bytes: number }>();
  for (const dataset of datasets) {
    if (
      !dataset?.id ||
      stats.has(dataset.id) ||
      dataset.offset !== offset ||
      !Number.isSafeInteger(dataset.bytes) ||
      dataset.bytes < 0 ||
      !Number.isSafeInteger(dataset.rows) ||
      dataset.rows < 0
    )
      fail();
    stats.set(dataset.id, { rows: dataset.rows, bytes: dataset.bytes });
    offset += dataset.bytes;
  }
  if (offset !== totalBytes) fail();
  return stats;
}

/**
 * Reopen an input that decode_input verified: its receipt must name exactly this pinned object, and
 * the frame index recorded with it drives every later read.
 */
export async function openVerifiedTenantBackupInput(input: {
  database: ConstructorParameters<typeof TenantBackupInputFrameStore>[0] &
    Pick<DatabaseAdapter, 'queryOne'>;
  lease: TenantBackupLease;
  now: () => number;
  bundleId: string;
  bucket: TenantBackupContainerInputBucketV2;
  identity: Readonly<TenantBackupInputIdentity>;
  session: TenantBundleKeyEnvelope;
  signal: AbortSignal;
  assertAuthorized: () => Promise<void>;
}): Promise<TenantBackupContainerFrameReader> {
  const receipts = new TenantBackupContainerInputStore(input.database, input.lease, input.now);
  const receipt = await receipts.load(input.bundleId);
  if (
    receipt.object_key !== input.identity.key ||
    receipt.object_version !== input.identity.version ||
    receipt.object_etag !== input.identity.etag ||
    receipt.object_size !== input.identity.size
  )
    fail();
  const { datasets, totalBytes } = receiptDatasets(receipt.dataset_stats_json);
  const object = new PinnedTenantBackupInputObject({
    bucket: input.bucket,
    identity: input.identity,
    signal: input.signal,
    assertAuthorized: async () => {
      await input.assertAuthorized();
      await receipts.load(input.bundleId);
    },
  });
  const store = new TenantBackupInputFrameStore(input.database, input.lease, input.now);
  let frames = await store.load(input.bundleId);
  const last = frames[frames.length - 1];
  if ((last ? last.plainOffset + last.plainBytes : 0) !== totalBytes) {
    // A receipt written before the index existed, or a rebuild that stopped between write
    // batches: walk the prefixes again. Rows already present must match what the walk finds.
    frames = await walkTenantBackupContainerV2Frames({
      object,
      maxFrames: LEGACY_INDEX_MAX_FRAMES,
      signal: input.signal,
    });
    await store.save(input.bundleId, frames);
    frames = await store.load(input.bundleId);
  }
  return TenantBackupContainerFrameReader.open({
    object,
    session: input.session,
    frames,
    datasets,
    totalBytes,
  });
}
