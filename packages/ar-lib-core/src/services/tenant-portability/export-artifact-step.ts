import {
  TENANT_BACKUP_CONTAINER_V2_MAX_OBJECT_BYTES,
  openTenantBackupContainerV2Cipher,
  tenantBackupContainerV2Metadata,
  type TenantBackupContainerDatasetV2,
} from './backup-container-v2';
import { encodeTenantBundleManifest, type TenantBundleManifest } from './bundle-manifest';
import { loadTenantBackupExportManifest } from './export-manifest-store';
import { TenantBackupArtifactWriter, type TenantBackupExportDatasetStat } from './artifact-writer';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import { ResumableSha256 } from './resumable-sha256';
import { openTenantBackupCheckpointSeal, type TenantBackupCheckpointSeal } from './checkpoint-seal';

type WriterArguments = Parameters<typeof TenantBackupArtifactWriter.resume>;
/**
 * Data frames hold this much plaintext, cut at fixed positions of the exported byte stream, never
 * where a read batch happened to end. A transition that stops on its budget writes what it holds
 * as one shorter frame. A retry re-cuts frames a failed slice already reserved at their recorded
 * lengths, so each nonce is only ever used for the same plaintext.
 */
const FRAME_BYTES = 4 * 1024 * 1024;
/** Frame header and AES-GCM tag around a frame's ciphertext. */
const FRAME_OVERHEAD_BYTES = 9 + 16;
/**
 * readNext calls after which a transition stops, with or without buffered bytes. Each call is
 * bounded by the reader's own query budget; the scheduler run has a deadline across transitions.
 */
const STEP_READ_CALLS = 120;
const CURSOR_LIMIT = 16384;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Position of a checkpointed export; saved only when every read byte is in a written part. */
interface ExportProgress {
  version: 3;
  attemptId: string;
  /** Data frames written; the next frame's nonce sequence. */
  sequence: number;
  /** Artifact parts written and their total bytes. */
  parts: number;
  objectBytes: number;
  /** Manifest index of the dataset being read and the source position inside it. */
  dataset: number;
  source: string | null;
  /** Plaintext bytes in written frames, and where the current dataset began. */
  offset: number;
  datasetOffset: number;
  /** Newlines of the current dataset so far. */
  datasetRows: number;
}
/** Values derived from plaintext. They only reach D1 sealed (see checkpoint-seal.ts). */
interface ExportSecrets {
  /** Last byte of the current dataset, -1 when it has none yet. */
  datasetLast: number;
  datasetHash: string;
  dataHash: string;
}

function fail(): never {
  throw new Error('backup_export_step_cursor');
}

function count(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function checkpointContext(state: ExportProgress): string {
  return `authrim-export-checkpoint:${JSON.stringify(state)}`;
}

function datasetContext(
  attemptId: string,
  stat: Omit<TenantBackupExportDatasetStat, 'sealedSha256'>
) {
  return `authrim-export-dataset:${JSON.stringify([attemptId, stat.ordinal, stat.id, stat.rows, stat.bytes, stat.offset])}`;
}

async function parseCursor(
  raw: string | null,
  attemptId: string,
  datasets: number,
  seal: TenantBackupCheckpointSeal
): Promise<{ state: ExportProgress; secrets: ExportSecrets }> {
  let cursor: (Partial<ExportProgress> & { sealed?: unknown }) | null;
  try {
    cursor = JSON.parse(raw ?? 'null') as typeof cursor;
  } catch {
    fail();
  }
  if (!cursor || typeof cursor !== 'object' || cursor.attemptId !== attemptId) fail();
  // A v2 cursor is the prepared attempt with nothing exported yet.
  if ((cursor.version as number) === 2) {
    if (Object.keys(cursor).length !== 2) fail();
    return {
      state: {
        version: 3,
        attemptId,
        sequence: 0,
        parts: 0,
        objectBytes: 0,
        dataset: 0,
        source: null,
        offset: 0,
        datasetOffset: 0,
        datasetRows: 0,
      },
      secrets: {
        datasetLast: -1,
        datasetHash: ResumableSha256.create().save(),
        dataHash: ResumableSha256.create().save(),
      },
    };
  }
  const { sealed, ...fields } = cursor;
  if (
    cursor.version !== 3 ||
    Object.keys(cursor).length !== 11 ||
    typeof sealed !== 'string' ||
    !count(cursor.sequence, 999_999) ||
    !count(cursor.parts, 1_000_000) ||
    // Every data frame before the last one is its own part.
    cursor.sequence !== cursor.parts ||
    !count(cursor.objectBytes) ||
    !count(cursor.dataset, datasets - 1) ||
    !(cursor.source === null || (typeof cursor.source === 'string' && cursor.source)) ||
    !count(cursor.offset) ||
    !count(cursor.datasetOffset) ||
    cursor.datasetOffset > cursor.offset ||
    !count(cursor.datasetRows)
  )
    fail();
  const state = fields as ExportProgress;
  let secrets: ExportSecrets;
  try {
    secrets = JSON.parse(await seal.open(sealed, checkpointContext(state))) as ExportSecrets;
  } catch {
    fail();
  }
  if (
    !secrets ||
    Object.keys(secrets).length !== 3 ||
    !Number.isSafeInteger(secrets.datasetLast) ||
    secrets.datasetLast < -1 ||
    secrets.datasetLast > 255 ||
    (secrets.datasetLast === -1) !== (state.datasetOffset === state.offset) ||
    typeof secrets.datasetHash !== 'string' ||
    typeof secrets.dataHash !== 'string' ||
    ResumableSha256.restore(secrets.dataHash).byteLength !== state.offset ||
    ResumableSha256.restore(secrets.datasetHash).byteLength !== state.offset - state.datasetOffset
  )
    fail();
  return { state, secrets };
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** Salt of the checkpointed format; one-shot v2 artifacts used another label, so no key is shared. */
export async function tenantBackupSlicedExportSalt(attemptId: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`authrim-backup-container-v2-sliced:${attemptId}`)
    )
  );
}

/**
 * Export the pinned T0 snapshot into one v2 container across as many transitions as it needs.
 * Each transition writes whole data frames as artifact parts and checkpoints only when nothing is
 * buffered, so memory stays near one frame and invocation limits apply to one slice, not the
 * tenant. Small tenants still finish in one transition with one part.
 */
export async function runTenantBackupArtifactStep(
  context: TenantBackupStepContext,
  input: {
    database: WriterArguments[0];
    bucket: WriterArguments[1];
    attemptId: string;
    key: TenantBundleKeyEnvelope;
    now: () => number;
    manifest?: TenantBundleManifest;
    expected: {
      bundleId: string;
      source: TenantBundleManifest['source'];
      selection: TenantBundleManifest['selection'];
      datasets: TenantBundleManifest['datasets'];
    };
    /** Zero bytes with a new cursor means the source moved past rows it omits. */
    readNext: (
      datasetId: string,
      cursor: string | null,
      signal: AbortSignal,
      manifest?: TenantBundleManifest,
      readSession?: object
    ) => Promise<{ bytes: Uint8Array; nextCursor: string } | null>;
    assertBoundary: () => Promise<void>;
    /** Smaller frames, budgets and size caps let tests cross many slices with little data. */
    slice?: { frameBytes: number; readCalls: number; maxObjectBytes?: number };
  }
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = context;
  signal.throwIfAborted();
  if (
    operation.kind !== 'export' ||
    operation.phase !== 'export_artifact' ||
    operation.state !== 'running' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    input.expected.source.tenantId !== lease.tenantId
  )
    throw new Error('backup_export_step_context');
  const frameBytes = input.slice?.frameBytes ?? FRAME_BYTES;
  const readCalls = input.slice?.readCalls ?? STEP_READ_CALLS;
  const maxObjectBytes = input.slice?.maxObjectBytes ?? TENANT_BACKUP_CONTAINER_V2_MAX_OBJECT_BYTES;
  if (
    !Number.isSafeInteger(frameBytes) ||
    frameBytes < 1 ||
    frameBytes > FRAME_BYTES ||
    !Number.isSafeInteger(readCalls) ||
    readCalls < 1 ||
    !Number.isSafeInteger(maxObjectBytes) ||
    maxObjectBytes < 1 ||
    maxObjectBytes > TENANT_BACKUP_CONTAINER_V2_MAX_OBJECT_BYTES
  )
    throw new Error('backup_export_step_context');
  const salt = await tenantBackupSlicedExportSalt(input.attemptId);
  const seal = await openTenantBackupCheckpointSeal(input.key, salt);
  const { state, secrets } = await parseCursor(
    operation.cursor_json,
    input.attemptId,
    input.expected.datasets.length,
    seal
  );
  const writer = await TenantBackupArtifactWriter.resume(
    input.database,
    input.bucket,
    input.attemptId,
    lease,
    input.now
  );
  const manifest = await loadTenantBackupExportManifest({
    database: input.database,
    lease,
    attemptId: input.attemptId,
    expected: input.expected,
    now: input.now,
  });
  if (
    input.manifest &&
    new TextDecoder().decode(encodeTenantBundleManifest(input.manifest, input.expected)) !==
      new TextDecoder().decode(encodeTenantBundleManifest(manifest, input.expected))
  )
    throw new Error('backup_export_manifest_changed');
  const verify: TenantBackupStepResult = {
    phase: 'verify_artifact',
    cursor: JSON.stringify({ version: 2, attemptId: input.attemptId }),
    disposition: 'continue',
  };

  await input.assertBoundary();
  const written = await writer.progress();
  // A sealed attempt means the last slice finished but its checkpoint was lost.
  if (written.state === 'sealed') return verify;
  if (written.reservedParts < state.parts) fail();
  // Parts that a failed slice reserved after this checkpoint fix the frames this retry must cut.
  const reserved =
    written.reservedParts > state.parts
      ? await writer.reservedPartSizes(state.parts)
      : new Map<number, number>();

  const cipher = await openTenantBackupContainerV2Cipher(input.key, salt);
  const dataHash = ResumableSha256.restore(secrets.dataHash);
  let datasetHash = ResumableSha256.restore(secrets.datasetHash);
  let datasetLast = secrets.datasetLast;
  const completed: TenantBackupExportDatasetStat[] = [];
  let buffer: Uint8Array[] = [];
  let bufferBytes = 0;
  let calls = 0;
  const readSession = {};

  const writePart = async (pieces: Uint8Array[]): Promise<void> => {
    if (state.parts === 0) pieces.unshift(cipher.header);
    const part = join(pieces);
    // Import decodes whole containers up to this size; a larger artifact could not be restored.
    if (state.objectBytes + part.length > maxObjectBytes)
      throw new Error('backup_export_too_large');
    signal.throwIfAborted();
    await input.assertBoundary();
    await writer.writePart(state.parts, part);
    state.parts++;
    state.objectBytes += part.length;
  };
  const sealFrame = async (plain: Uint8Array): Promise<Uint8Array> => {
    const frame = await cipher.seal(state.sequence, 1, plain);
    state.sequence++;
    state.offset += plain.length;
    return frame;
  };
  const takeBuffer = (length = bufferBytes): Uint8Array => {
    const all = join(buffer);
    buffer = length < all.length ? [all.slice(length)] : [];
    bufferBytes = all.length - length;
    return all.subarray(0, length);
  };
  /** Plaintext of the next data frame: what its reserved part holds, else a full frame. */
  const nextFrameBytes = (): number => {
    const size = reserved.get(state.parts);
    if (size === undefined) return frameBytes;
    const plain = size - FRAME_OVERHEAD_BYTES - (state.parts === 0 ? cipher.header.length : 0);
    if (plain < 1) fail();
    return plain;
  };
  const writeFrame = async (length: number): Promise<void> => {
    await writePart([await sealFrame(takeBuffer(length))]);
  };

  for (;;) {
    signal.throwIfAborted();
    if (state.dataset === manifest.datasets.length) {
      // Data frames a failed slice already wrote come first, cut where they were. Every other
      // last data frame shares the last part with the metadata frame.
      while (bufferBytes && reserved.has(state.parts) && bufferBytes >= nextFrameBytes())
        await writeFrame(nextFrameBytes());
      const pieces: Uint8Array[] = [];
      if (bufferBytes || state.sequence === 0) pieces.push(await sealFrame(takeBuffer()));
      const stats = [...(await writer.datasetStats()), ...completed];
      const digests = new Map<number, string>();
      for (const stat of stats)
        digests.set(
          stat.ordinal,
          await seal.open(stat.sealedSha256, datasetContext(input.attemptId, stat))
        );
      const datasets = finalDatasets(manifest, stats, digests);
      if (datasets.reduce((sum, dataset) => sum + dataset.bytes, 0) !== state.offset) fail();
      const metadata = await tenantBackupContainerV2Metadata({
        manifest,
        datasets,
        dataFrames: state.sequence,
        dataSha256: dataHash.digestHex(),
      });
      pieces.push(await cipher.seal(state.sequence, 2, metadata.bytes));
      await writePart(pieces);
      await writer.seal(state.parts, state.objectBytes);
      await input.assertBoundary();
      return verify;
    }
    if (calls >= readCalls) {
      // Write what is buffered as a shorter frame, so the checkpoint carries no unwritten bytes.
      // A frame a failed slice reserved must keep its recorded length, which may need more reads.
      while (bufferBytes && (!reserved.has(state.parts) || bufferBytes >= nextFrameBytes()))
        await writeFrame(Math.min(bufferBytes, nextFrameBytes()));
    }
    if (!bufferBytes && calls >= readCalls) {
      await writer.saveDatasetStats(completed);
      const cursor = JSON.stringify({
        ...state,
        sealed: await seal.seal(
          JSON.stringify({
            datasetLast,
            datasetHash: datasetHash.save(),
            dataHash: dataHash.save(),
          } satisfies ExportSecrets),
          checkpointContext(state)
        ),
      });
      if (cursor.length > CURSOR_LIMIT) throw new Error('backup_export_step_cursor_limit');
      await input.assertBoundary();
      return { phase: 'export_artifact', cursor, disposition: 'continue' };
    }
    const descriptor = manifest.datasets[state.dataset];
    const next =
      descriptor.disposition === 'include'
        ? await input.readNext(descriptor.id, state.source, signal, manifest, readSession)
        : null;
    calls++;
    if (!next) {
      const offset = state.offset + bufferBytes;
      const bytes = offset - state.datasetOffset;
      if (bytes) {
        const stat = {
          ordinal: state.dataset,
          id: descriptor.id,
          rows: state.datasetRows + (datasetLast === 10 ? 0 : 1),
          bytes,
          offset: state.datasetOffset,
        };
        completed.push({
          ...stat,
          sealedSha256: await seal.seal(
            datasetHash.digestHex(),
            datasetContext(input.attemptId, stat)
          ),
        });
      }
      state.dataset++;
      state.source = null;
      state.datasetOffset = offset;
      state.datasetRows = 0;
      datasetLast = -1;
      datasetHash = ResumableSha256.create();
      continue;
    }
    if (
      !(next.bytes instanceof Uint8Array) ||
      typeof next.nextCursor !== 'string' ||
      !next.nextCursor ||
      next.nextCursor === state.source
    )
      throw new Error('backup_export_source_invalid');
    state.source = next.nextCursor;
    if (!next.bytes.length) continue;
    const bytes = new Uint8Array(next.bytes);
    dataHash.update(bytes);
    datasetHash.update(bytes);
    for (const byte of bytes) if (byte === 10) state.datasetRows++;
    datasetLast = bytes[bytes.length - 1];
    buffer.push(bytes);
    bufferBytes += bytes.length;
    // Frames may end inside a row; verification and readers carry row state across frames.
    while (bufferBytes >= nextFrameBytes()) await writeFrame(nextFrameBytes());
  }
}

/** Stats for every manifest dataset; empty ones were never stored and are derived here. */
function finalDatasets(
  manifest: TenantBundleManifest,
  stats: readonly TenantBackupExportDatasetStat[],
  digests: ReadonlyMap<number, string>
): TenantBackupContainerDatasetV2[] {
  const byOrdinal = new Map<number, TenantBackupExportDatasetStat>();
  for (const stat of stats) {
    const saved = byOrdinal.get(stat.ordinal);
    if (
      saved &&
      (saved.id !== stat.id ||
        saved.rows !== stat.rows ||
        saved.bytes !== stat.bytes ||
        saved.offset !== stat.offset)
    )
      fail();
    byOrdinal.set(stat.ordinal, stat);
  }
  let offset = 0;
  const datasets = manifest.datasets.map((descriptor, ordinal) => {
    const stat = byOrdinal.get(ordinal);
    if (!stat) return { id: descriptor.id, rows: 0, bytes: 0, sha256: EMPTY_SHA256, offset };
    byOrdinal.delete(ordinal);
    const sha256 = digests.get(ordinal);
    if (
      stat.id !== descriptor.id ||
      stat.offset !== offset ||
      !sha256 ||
      !/^[a-f0-9]{64}$/.test(sha256)
    )
      fail();
    offset += stat.bytes;
    return { id: stat.id, rows: stat.rows, bytes: stat.bytes, sha256, offset: stat.offset };
  });
  if (byOrdinal.size) fail();
  return datasets;
}
