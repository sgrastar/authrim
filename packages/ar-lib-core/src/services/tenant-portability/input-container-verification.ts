import {
  openTenantBackupContainerHeaderV2,
  parseTenantBackupContainerV2Metadata,
  readTenantBackupFramePrefixV2,
  tenantBackupContainerRowCountV2,
  TENANT_BACKUP_CONTAINER_V2_LIMITS,
  TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES,
  type TenantBackupContainerV2Cipher,
  type TenantBackupContainerFooterV2,
  type TenantBackupContainerManifestV2,
} from './backup-container-v2';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import { openTenantBackupCheckpointSeal, type TenantBackupCheckpointSeal } from './checkpoint-seal';
import {
  assertTenantBackupInputFrameChain,
  type TenantBackupInputFrame,
} from './input-frame-index';
import type { PinnedTenantBackupInputObject } from './pinned-input-object';
import { ResumableSha256 } from './resumable-sha256';

const {
  headerBytes: HEADER_BYTES,
  frameOverheadBytes: OVERHEAD,
  maxFramePlainBytes: MAX_FRAME_PLAIN_BYTES,
} = TENANT_BACKUP_CONTAINER_V2_LIMITS;

/** Data frames one input may have: the cap export, verification and download share. */
export const TENANT_BACKUP_INPUT_MAX_DATA_FRAMES = TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES;

/** Work one decode_input transition may do before it checkpoints. */
export interface TenantBackupContainerVerificationBudget {
  /**
   * Frame reads per transition: prefixes while indexing, whole frames (and the metadata frame)
   * while verifying, all counted together. Each is one R2 range request on large objects, so this
   * also bounds subrequests; empty frames count.
   */
  frames: number;
  /** Plaintext bytes decrypted and hashed (twice: whole data and dataset). */
  verifyBytes: number;
}

export const TENANT_BACKUP_CONTAINER_VERIFICATION_BUDGET: TenantBackupContainerVerificationBudget =
  { frames: 256, verifyBytes: 64 * 1024 * 1024 };

/**
 * Durable position of a partially verified input; small enough for the operation cursor. The two
 * hash midstates hold up to 63 unhashed plaintext bytes each, so they are stored sealed.
 */
export type TenantBackupContainerVerificationProgress =
  | { stage: 'walk'; sequence: number; objectOffset: number; plainOffset: number }
  | {
      stage: 'verify';
      metadataOffset: number;
      dataFrames: number;
      sequence: number;
      data: string;
      dataset: number;
      datasetSha256: string;
      datasetBytes: number;
      datasetNewlines: number;
      /** Whether the dataset's bytes so far end with a newline (true while it is empty). */
      datasetEndsLine: boolean;
    };
type VerifyProgress = Extract<TenantBackupContainerVerificationProgress, { stage: 'verify' }>;

export type TenantBackupContainerVerificationSlice =
  | { done: false; progress: TenantBackupContainerVerificationProgress }
  | {
      done: true;
      manifest: TenantBackupContainerManifestV2;
      footer: TenantBackupContainerFooterV2;
    };

function fail(): never {
  throw new Error('invalid_tenant_backup_container_v2');
}

const KEYS = {
  walk: 'objectOffset,plainOffset,sequence,stage',
  verify:
    'data,dataFrames,dataset,datasetBytes,datasetEndsLine,datasetNewlines,datasetSha256,metadataOffset,sequence,stage',
};
const SEALED = /^(?:[a-f0-9]{2}){28,512}$/;

/** Reject any progress value that this module would not have produced. */
export function parseTenantBackupContainerVerificationProgress(
  value: unknown
): TenantBackupContainerVerificationProgress {
  const progress = value as TenantBackupContainerVerificationProgress;
  const integers = (...values: unknown[]) =>
    values.every((item) => Number.isSafeInteger(item) && (item as number) >= 0);
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) fail();
  if (progress.stage === 'walk') {
    if (
      Object.keys(progress).sort().join(',') !== KEYS.walk ||
      !integers(progress.sequence, progress.objectOffset, progress.plainOffset) ||
      progress.objectOffset < HEADER_BYTES ||
      progress.sequence > TENANT_BACKUP_INPUT_MAX_DATA_FRAMES
    )
      fail();
    return progress;
  }
  if (
    progress.stage !== 'verify' ||
    Object.keys(progress).sort().join(',') !== KEYS.verify ||
    !integers(
      progress.metadataOffset,
      progress.dataFrames,
      progress.sequence,
      progress.dataset,
      progress.datasetBytes,
      progress.datasetNewlines
    ) ||
    progress.sequence > progress.dataFrames ||
    progress.dataFrames > TENANT_BACKUP_INPUT_MAX_DATA_FRAMES ||
    typeof progress.datasetEndsLine !== 'boolean' ||
    typeof progress.data !== 'string' ||
    typeof progress.datasetSha256 !== 'string' ||
    !SEALED.test(progress.data) ||
    !SEALED.test(progress.datasetSha256)
  )
    fail();
  return progress;
}

export function initialTenantBackupContainerVerificationProgress(): TenantBackupContainerVerificationProgress {
  return { stage: 'walk', sequence: 0, objectOffset: HEADER_BYTES, plainOffset: 0 };
}

/** Seal contexts bind each midstate to the input and to the exact position it belongs to. */
function hashContext(
  session: TenantBundleKeyEnvelope,
  kind: 'data' | 'dataset',
  state: Pick<VerifyProgress, 'sequence' | 'dataset' | 'datasetBytes' | 'dataFrames'>
): string {
  // Prefixed like the export and verify checkpoint contexts, which share this seal key.
  return `authrim-import-decode:${JSON.stringify([
    Array.from(session.envelope.subarray(1, 17), (byte) => byte.toString(16).padStart(2, '0')).join(
      ''
    ),
    kind,
    state.dataFrames,
    state.sequence,
    ...(kind === 'dataset' ? [state.dataset, state.datasetBytes] : []),
  ])}`;
}

/**
 * Authenticate one v2 input across as many transitions as it needs, with constant memory.
 *
 * 1. walk: read each frame prefix in order and record the frame index (no decryption yet). The walk
 *    ends at the metadata frame, which must be last and end exactly at the object end.
 * 2. verify: decrypt the metadata frame, then every data frame in order, feeding the whole-data and
 *    per-dataset SHA-256 and newline counts. Hash midstates survive checkpoints, sealed.
 *
 * Accepts what `decodeTenantBackupContainerV2` accepts, except frames over 16 MiB of plaintext and
 * more than `TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES` data frames. The caller persists `frames` before it checkpoints `progress`, and
 * saves the input receipt only after `done`.
 */
export async function verifyTenantBackupContainerV2Slice(input: {
  object: PinnedTenantBackupInputObject;
  session: TenantBundleKeyEnvelope;
  progress: TenantBackupContainerVerificationProgress;
  /** Recorded frames `from`..`from + count - 1` in sequence order (fewer at the end). */
  loadFrames: (from: number, count: number) => Promise<readonly TenantBackupInputFrame[]>;
  saveFrames: (frames: readonly TenantBackupInputFrame[]) => Promise<void>;
  /** Checked as soon as the authenticated manifest is known, before any data frame is decrypted. */
  acceptManifest: (manifest: TenantBackupContainerManifestV2) => void | Promise<void>;
  budget?: TenantBackupContainerVerificationBudget;
  signal: AbortSignal;
}): Promise<TenantBackupContainerVerificationSlice> {
  const budget = input.budget ?? TENANT_BACKUP_CONTAINER_VERIFICATION_BUDGET;
  const header = await input.object.read(0, HEADER_BYTES);
  const cipher = await openTenantBackupContainerHeaderV2(header, input.session);
  const seal = await openTenantBackupCheckpointSeal(
    input.session,
    header.subarray(101, HEADER_BYTES)
  );
  let progress = parseTenantBackupContainerVerificationProgress(input.progress);
  let reads = budget.frames;
  if (progress.stage === 'walk') {
    const walked = await walk(input.object, progress, budget.frames, input.signal);
    await input.saveFrames(walked.frames);
    if (!walked.metadataOffset) return { done: false, progress: walked.progress };
    reads -= walked.frames.length + 1;
    const start = {
      metadataOffset: walked.metadataOffset,
      dataFrames: walked.progress.sequence,
      sequence: 0,
      dataset: 0,
      datasetBytes: 0,
      datasetNewlines: 0,
      datasetEndsLine: true,
    };
    const empty = ResumableSha256.create().save();
    progress = {
      stage: 'verify',
      ...start,
      data: await seal.seal(empty, hashContext(input.session, 'data', start)),
      datasetSha256: await seal.seal(empty, hashContext(input.session, 'dataset', start)),
    };
    // The verify stage reads the metadata frame and at least one data frame; leave it for the
    // next transition when the walk used this one's reads.
    if (reads < 2 && progress.dataFrames > 0) return { done: false, progress };
  }
  if (progress.stage !== 'verify') fail();
  const metadata = await readMetadata(
    input.object,
    cipher,
    progress.metadataOffset,
    progress.dataFrames
  );
  reads -= 1;
  const { manifest, footer } = await parseTenantBackupContainerV2Metadata(
    metadata,
    header.subarray(8, 101),
    progress.dataFrames
  );
  await input.acceptManifest(manifest);
  return verifyData({
    ...input,
    cipher,
    seal,
    manifest,
    footer,
    progress,
    budget: { frames: Math.max(1, reads), verifyBytes: budget.verifyBytes },
  });
}

/**
 * Read up to `limit` frame prefixes (data and metadata alike) from `start`. A data frame at or past
 * `maxDataFrames` fails; reaching the limit only pauses the walk.
 */
async function walk(
  object: Pick<PinnedTenantBackupInputObject, 'size' | 'read'>,
  start: Extract<TenantBackupContainerVerificationProgress, { stage: 'walk' }>,
  limit: number,
  signal: AbortSignal,
  maxDataFrames = TENANT_BACKUP_INPUT_MAX_DATA_FRAMES
) {
  const frames: TenantBackupInputFrame[] = [];
  let { sequence, objectOffset, plainOffset } = start;
  for (let reads = 0; reads < limit; reads++) {
    signal.throwIfAborted();
    if (object.size - objectOffset < 9) fail();
    const { type, frameBytes } = readTenantBackupFramePrefixV2(
      await object.read(objectOffset, 9),
      sequence
    );
    const end = objectOffset + frameBytes;
    if (end > object.size || frameBytes - OVERHEAD > MAX_FRAME_PLAIN_BYTES) fail();
    if (type === 2) {
      if (end !== object.size) fail();
      return {
        frames,
        metadataOffset: objectOffset,
        progress: { stage: 'walk' as const, sequence, objectOffset, plainOffset },
      };
    }
    if (sequence >= Math.min(maxDataFrames, TENANT_BACKUP_INPUT_MAX_DATA_FRAMES)) fail();
    frames.push({
      sequence,
      objectOffset,
      frameBytes,
      plainOffset,
      plainBytes: frameBytes - OVERHEAD,
    });
    sequence++;
    objectOffset = end;
    plainOffset += frameBytes - OVERHEAD;
    if (objectOffset >= object.size) fail();
  }
  return {
    frames,
    metadataOffset: 0,
    progress: { stage: 'walk' as const, sequence, objectOffset, plainOffset },
  };
}

async function readMetadata(
  object: Pick<PinnedTenantBackupInputObject, 'size' | 'read'>,
  cipher: TenantBackupContainerV2Cipher,
  metadataOffset: number,
  dataFrames: number
): Promise<Uint8Array> {
  const frameBytes = object.size - metadataOffset;
  if (frameBytes < OVERHEAD || frameBytes - OVERHEAD > MAX_FRAME_PLAIN_BYTES) fail();
  const bytes = await object.read(metadataOffset, frameBytes);
  const prefix = readTenantBackupFramePrefixV2(bytes.subarray(0, 9), dataFrames);
  if (prefix.type !== 2 || prefix.frameBytes !== frameBytes) fail();
  return cipher.open(dataFrames, 2, bytes.subarray(9));
}

/** Load the frames this slice may verify, plus the previous frame to anchor the chain. */
async function framePage(
  loadFrames: (from: number, count: number) => Promise<readonly TenantBackupInputFrame[]>,
  progress: VerifyProgress,
  count: number
): Promise<TenantBackupInputFrame[]> {
  const from = Math.max(0, progress.sequence - 1);
  const wanted =
    Math.min(count, progress.dataFrames - progress.sequence) + (progress.sequence - from);
  const page = [...(await loadFrames(from, wanted))];
  if (page.length !== wanted) fail();
  if (from === 0 && progress.sequence === 0) assertTenantBackupInputFrameChain(page);
  else assertTenantBackupInputFrameChain(page.slice(1), nextFrame(page[0]));
  return progress.sequence === from ? page : page.slice(1);
}

function nextFrame(frame: TenantBackupInputFrame): TenantBackupInputFrame {
  return {
    sequence: frame.sequence + 1,
    objectOffset: frame.objectOffset + frame.frameBytes,
    frameBytes: 0,
    plainOffset: frame.plainOffset + frame.plainBytes,
    plainBytes: 0,
  };
}

async function verifyData(input: {
  object: PinnedTenantBackupInputObject;
  session: TenantBundleKeyEnvelope;
  cipher: TenantBackupContainerV2Cipher;
  seal: TenantBackupCheckpointSeal;
  manifest: TenantBackupContainerManifestV2;
  footer: TenantBackupContainerFooterV2;
  loadFrames: (from: number, count: number) => Promise<readonly TenantBackupInputFrame[]>;
  progress: VerifyProgress;
  budget: TenantBackupContainerVerificationBudget;
  signal: AbortSignal;
}): Promise<TenantBackupContainerVerificationSlice> {
  const { manifest, seal, session } = input;
  const state = { ...input.progress };
  const data = ResumableSha256.restore(
    await seal.open(state.data, hashContext(session, 'data', state))
  );
  let datasetHash = ResumableSha256.restore(
    await seal.open(state.datasetSha256, hashContext(session, 'dataset', state))
  );
  const frames = await framePage(input.loadFrames, state, input.budget.frames);
  if (data.byteLength !== (frames[0]?.plainOffset ?? manifest.totalBytes)) fail();

  // Close every dataset whose bytes are complete, including empty ones.
  const settle = () => {
    for (;;) {
      const dataset = manifest.datasets[state.dataset];
      if (!dataset || state.datasetBytes !== dataset.bytes) return;
      if (
        datasetHash.byteLength !== dataset.bytes ||
        datasetHash.digestHex() !== dataset.sha256 ||
        tenantBackupContainerRowCountV2(
          state.datasetNewlines,
          state.datasetBytes,
          state.datasetEndsLine ? 10 : 0
        ) !== dataset.rows
      )
        fail();
      state.dataset++;
      state.datasetBytes = 0;
      state.datasetNewlines = 0;
      state.datasetEndsLine = true;
      datasetHash = ResumableSha256.create();
    }
  };

  let decrypted = 0;
  let last: TenantBackupInputFrame | undefined;
  settle();
  for (const frame of frames) {
    if (decrypted >= input.budget.verifyBytes) break;
    input.signal.throwIfAborted();
    const bytes = await input.object.read(frame.objectOffset, frame.frameBytes);
    const prefix = readTenantBackupFramePrefixV2(bytes.subarray(0, 9), frame.sequence);
    if (prefix.type !== 1 || prefix.frameBytes !== frame.frameBytes) fail();
    const plain = await input.cipher.open(frame.sequence, 1, bytes.subarray(9));
    if (plain.length !== frame.plainBytes) fail();
    data.update(plain);
    let offset = 0;
    while (offset < plain.length) {
      const dataset = manifest.datasets[state.dataset];
      if (!dataset) fail();
      const take = Math.min(dataset.bytes - state.datasetBytes, plain.length - offset);
      const piece = plain.subarray(offset, offset + take);
      datasetHash.update(piece);
      for (let index = 0; index < piece.length; index++)
        if (piece[index] === 10) state.datasetNewlines++;
      if (piece.length) state.datasetEndsLine = piece[piece.length - 1] === 10;
      state.datasetBytes += take;
      offset += take;
      settle();
    }
    decrypted += plain.length;
    state.sequence++;
    last = frame;
  }
  if (state.sequence < state.dataFrames)
    return {
      done: false,
      progress: {
        ...state,
        data: await seal.seal(data.save(), hashContext(session, 'data', state)),
        datasetSha256: await seal.seal(datasetHash.save(), hashContext(session, 'dataset', state)),
      },
    };
  settle();
  if (
    (last ? last.objectOffset + last.frameBytes : HEADER_BYTES) !== state.metadataOffset ||
    (state.dataFrames > 0 && !last) ||
    (await input.loadFrames(state.dataFrames, 1)).length ||
    state.dataset !== manifest.datasets.length ||
    data.byteLength !== manifest.totalBytes ||
    data.digestHex() !== manifest.dataSha256
  )
    fail();
  return { done: true, manifest, footer: input.footer };
}

/**
 * Recover the frame index of an input from its frame prefixes alone. Used for inputs whose receipt
 * predates the index: the receipt already proves full authentication, and every frame is
 * authenticated again whenever it is read.
 */
export async function walkTenantBackupContainerV2Frames(input: {
  object: PinnedTenantBackupInputObject;
  maxFrames: number;
  signal: AbortSignal;
}): Promise<TenantBackupInputFrame[]> {
  const walked = await walk(
    input.object,
    { stage: 'walk', sequence: 0, objectOffset: HEADER_BYTES, plainOffset: 0 },
    input.maxFrames,
    input.signal
  );
  if (!walked.metadataOffset) fail();
  return walked.frames;
}

/**
 * Read only the authenticated manifest: walk frame prefixes to the metadata frame and decrypt it.
 * Data frames are not authenticated here; decode_input does that before any row is used. Long walks
 * resume from `progress`; `maxFrames` bounds the whole walk, `frames` one call.
 */
export async function readTenantBackupContainerV2Manifest(input: {
  /** Any random-access source: a pinned R2 object, or a browser File. */
  object: Pick<PinnedTenantBackupInputObject, 'size' | 'read'>;
  session: TenantBundleKeyEnvelope;
  progress?: unknown;
  frames?: number;
  maxFrames: number;
  signal: AbortSignal;
}): Promise<
  | { done: false; progress: TenantBackupContainerVerificationProgress }
  | { done: true; manifest: TenantBackupContainerManifestV2; footer: TenantBackupContainerFooterV2 }
> {
  const header = await input.object.read(0, HEADER_BYTES);
  const cipher = await openTenantBackupContainerHeaderV2(header, input.session);
  const start =
    input.progress === undefined
      ? initialTenantBackupContainerVerificationProgress()
      : parseTenantBackupContainerVerificationProgress(input.progress);
  if (start.stage !== 'walk' || start.sequence > input.maxFrames) fail();
  const walked = await walk(
    input.object,
    start,
    input.frames ?? TENANT_BACKUP_CONTAINER_VERIFICATION_BUDGET.frames,
    input.signal,
    // `maxFrames` counts every frame, the metadata frame included.
    input.maxFrames - 1
  );
  if (!walked.metadataOffset) return { done: false, progress: walked.progress };
  const dataFrames = walked.progress.sequence;
  const metadata = await readMetadata(input.object, cipher, walked.metadataOffset, dataFrames);
  const parsed = await parseTenantBackupContainerV2Metadata(
    metadata,
    header.subarray(8, 101),
    dataFrames
  );
  if (walked.progress.plainOffset !== parsed.manifest.totalBytes) fail();
  return { done: true, ...parsed };
}
