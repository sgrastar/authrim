import {
  openTenantBackupContainerV2Cipher,
  parseTenantBackupContainerV2Metadata,
  tenantBackupContainerV2Frames,
  type TenantBackupContainerManifestV2,
  type TenantBackupContainerV2Cipher,
  type TenantBackupContainerV2Frame,
} from './backup-container-v2';
import { readTenantBackupArtifactPart } from './artifact-reader';
import { loadTenantBackupExportManifest } from './export-manifest-store';
import { encodeTenantBundleManifest } from './bundle-manifest';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { DatabaseAdapter } from '../../db/adapter';
import { ResumableSha256 } from './resumable-sha256';
import { openTenantBackupCheckpointSeal } from './checkpoint-seal';

interface Bucket {
  get(key: string): Promise<{
    size: number;
    body: {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>;
        cancel(): Promise<void>;
        releaseLock(): void;
      };
    };
  } | null>;
}

/** Ciphertext bytes after which a transition stops at the next part boundary. */
const STEP_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 8 + 93 + 32;

/** Durable position between verification transitions, always at a part boundary. */
interface VerifyProgress {
  version: 3;
  attemptId: string;
  /** Stream salt read from part 0's header; artifacts may come from either export format. */
  salt: string;
  nextPart: number;
  verifiedBytes: number;
  /** Next data frame sequence and plaintext bytes verified so far. */
  sequence: number;
  offset: number;
  /** Manifest index of the dataset the next plaintext byte belongs to, and its newline count. */
  dataset: number;
  datasetRows: number;
}
/** Values derived from plaintext. They only reach D1 sealed (see checkpoint-seal.ts). */
interface VerifySecrets {
  datasetLast: number;
  datasetHash: string;
  dataHash: string;
}

function cursorFail(): never {
  throw new Error('backup_verify_step_cursor');
}

function invalid(): never {
  throw new Error('invalid_tenant_backup_container_v2');
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function checkpointContext(state: VerifyProgress): string {
  return `authrim-verify-checkpoint:${JSON.stringify(state)}`;
}

/** Public cursor fields, or null for the initial cursor written by the export step. */
function parseCursor(
  raw: string | null,
  attemptId: string
): { state: VerifyProgress; sealed: string } | null {
  let cursor: (Partial<VerifyProgress> & { sealed?: unknown }) | null;
  try {
    cursor = JSON.parse(raw ?? 'null') as typeof cursor;
  } catch {
    cursorFail();
  }
  if (!cursor || typeof cursor !== 'object' || cursor.attemptId !== attemptId) cursorFail();
  if ((cursor.version as number) === 2) return null;
  const { sealed, ...fields } = cursor;
  if (
    cursor.version !== 3 ||
    Object.keys(cursor).length !== 10 ||
    typeof sealed !== 'string' ||
    typeof cursor.salt !== 'string' ||
    !/^[a-f0-9]{64}$/.test(cursor.salt) ||
    !count(cursor.nextPart) ||
    cursor.nextPart < 1 ||
    !count(cursor.verifiedBytes) ||
    !count(cursor.sequence) ||
    !count(cursor.offset) ||
    !count(cursor.dataset) ||
    !count(cursor.datasetRows)
  )
    cursorFail();
  return { state: fields as VerifyProgress, sealed };
}

/**
 * Verify R2 receipts, authenticated metadata, footer and every dataset digest once, one bounded
 * run of parts per transition so memory and CPU stay flat for any artifact size.
 */
export async function runTenantBackupArtifactVerificationStep(
  context: TenantBackupStepContext,
  input: {
    database: Pick<DatabaseAdapter, 'queryOne'>;
    bucket: Bucket;
    attemptId: string;
    key: TenantBundleKeyEnvelope;
    expected: Parameters<typeof loadTenantBackupExportManifest>[0]['expected'];
    now: () => number;
    /** A smaller per-transition budget lets tests cross many slices with little data. */
    slice?: { stepBytes: number };
  }
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = context;
  if (
    operation.kind !== 'export' ||
    operation.state !== 'running' ||
    operation.phase !== 'verify_artifact' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    input.expected.source.tenantId !== lease.tenantId
  )
    throw new Error('backup_verify_step_context');
  const stepBudget = input.slice?.stepBytes ?? STEP_BYTES;
  if (!Number.isSafeInteger(stepBudget) || stepBudget < 1)
    throw new Error('backup_verify_step_context');
  const parsed = parseCursor(operation.cursor_json, input.attemptId);
  const attempt = await input.database.queryOne<{ part_count: number; byte_count: number }>(
    "SELECT part_count,byte_count FROM tenant_backup_artifact_attempts WHERE id=? AND tenant_id=? AND state='sealed'",
    [input.attemptId, lease.tenantId]
  );
  if (
    !attempt ||
    !Number.isSafeInteger(attempt.part_count) ||
    attempt.part_count < 1 ||
    !Number.isSafeInteger(attempt.byte_count) ||
    attempt.byte_count < 1 ||
    (parsed &&
      (parsed.state.nextPart >= attempt.part_count ||
        parsed.state.verifiedBytes >= attempt.byte_count))
  )
    cursorFail();
  const savedManifest = await loadTenantBackupExportManifest({
    database: input.database,
    lease,
    attemptId: input.attemptId,
    expected: input.expected,
    now: input.now,
  });
  const readPart = (ordinal: number) =>
    readTenantBackupArtifactPart(
      {
        database: input.database,
        bucket: input.bucket,
        lease,
        attemptId: input.attemptId,
        signal,
        now: input.now,
      },
      ordinal
    );
  // Part 0's header names the stream salt; it is checked byte for byte when part 0 is verified.
  let first: Uint8Array | undefined;
  if (!parsed) {
    first = await readPart(0);
    if (first.length < HEADER_BYTES) invalid();
  }
  const state: VerifyProgress = parsed?.state ?? {
    version: 3,
    attemptId: input.attemptId,
    salt: hex(first!.subarray(101, HEADER_BYTES)),
    nextPart: 0,
    verifiedBytes: 0,
    sequence: 0,
    offset: 0,
    dataset: 0,
    datasetRows: 0,
  };
  const salt = Uint8Array.from(state.salt.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  const cipher = await openTenantBackupContainerV2Cipher(input.key, salt);
  const seal = await openTenantBackupCheckpointSeal(input.key, salt);
  let secrets: VerifySecrets = {
    datasetLast: -1,
    datasetHash: ResumableSha256.create().save(),
    dataHash: ResumableSha256.create().save(),
  };
  if (parsed) {
    try {
      secrets = JSON.parse(
        await seal.open(parsed.sealed, checkpointContext(state))
      ) as VerifySecrets;
    } catch {
      cursorFail();
    }
    if (
      !secrets ||
      Object.keys(secrets).length !== 3 ||
      !Number.isSafeInteger(secrets.datasetLast) ||
      secrets.datasetLast < -1 ||
      secrets.datasetLast > 255 ||
      typeof secrets.datasetHash !== 'string' ||
      typeof secrets.dataHash !== 'string'
    )
      cursorFail();
  }
  const lastOrdinal = attempt.part_count - 1;
  const manifest = await readMetadata(
    await readPart(lastOrdinal),
    lastOrdinal === 0,
    cipher,
    input.key.envelope
  );
  if (
    new TextDecoder().decode(encodeTenantBundleManifest(manifest.backup, input.expected)) !==
    new TextDecoder().decode(encodeTenantBundleManifest(savedManifest, input.expected))
  )
    throw new Error('backup_export_manifest_changed');
  const datasets = manifest.datasets;
  const current = datasets[state.dataset];
  const dataHash = ResumableSha256.restore(secrets.dataHash);
  let datasetHash = ResumableSha256.restore(secrets.datasetHash);
  let datasetLast = secrets.datasetLast;
  if (
    dataHash.byteLength !== state.offset ||
    state.dataset > datasets.length ||
    state.offset > manifest.totalBytes ||
    (current
      ? state.offset < current.offset || datasetHash.byteLength !== state.offset - current.offset
      : datasetHash.byteLength !== 0)
  )
    cursorFail();
  const closeDatasets = (): void => {
    // Close every dataset that ends at the current offset, including empty ones.
    while (state.dataset < datasets.length) {
      const dataset = datasets[state.dataset];
      if (state.offset !== dataset.offset + dataset.bytes) return;
      const rows = dataset.bytes ? state.datasetRows + (datasetLast === 10 ? 0 : 1) : 0;
      if (rows !== dataset.rows || datasetHash.digestHex() !== dataset.sha256) invalid();
      state.dataset++;
      state.datasetRows = 0;
      datasetLast = -1;
      datasetHash = ResumableSha256.create();
    }
  };
  const verifyData = (plain: Uint8Array): void => {
    dataHash.update(plain);
    let position = 0;
    while (position < plain.length) {
      closeDatasets();
      const dataset = datasets[state.dataset];
      if (!dataset) invalid();
      const take = Math.min(dataset.offset + dataset.bytes - state.offset, plain.length - position);
      const segment = plain.subarray(position, position + take);
      datasetHash.update(segment);
      for (const byte of segment) if (byte === 10) state.datasetRows++;
      datasetLast = segment[segment.length - 1];
      state.offset += take;
      position += take;
    }
    closeDatasets();
  };

  let stepBytes = 0;
  closeDatasets();
  for (;;) {
    signal.throwIfAborted();
    const ordinal = state.nextPart;
    const bytes = ordinal === 0 && first ? first : await readPart(ordinal);
    let start = 0;
    if (ordinal === 0) {
      if (bytes.length < HEADER_BYTES || !cipher.header.every((byte, i) => byte === bytes[i]))
        invalid();
      start = HEADER_BYTES;
    }
    let metadataSeen = false;
    for (const frame of tenantBackupContainerV2Frames(bytes, start)) {
      if (frame.sequence !== state.sequence || metadataSeen) invalid();
      if (frame.type === 2) {
        if (ordinal !== lastOrdinal || frame.end !== bytes.length) invalid();
        metadataSeen = true;
        continue;
      }
      verifyData(await cipher.open(frame.sequence, 1, frame.encrypted));
      state.sequence++;
    }
    state.nextPart++;
    state.verifiedBytes += bytes.length;
    stepBytes += bytes.length;
    if (metadataSeen) {
      if (
        state.nextPart !== attempt.part_count ||
        state.verifiedBytes !== attempt.byte_count ||
        state.sequence === 0 ||
        state.dataset !== datasets.length ||
        state.offset !== manifest.totalBytes ||
        dataHash.digestHex() !== manifest.dataSha256
      )
        invalid();
      signal.throwIfAborted();
      return {
        phase: 'release_export_resources',
        disposition: 'continue',
        cursor: JSON.stringify({
          version: 2,
          attemptId: input.attemptId,
          nextPart: state.nextPart,
          verifiedBytes: state.verifiedBytes,
        }),
      };
    }
    if (state.nextPart >= attempt.part_count || state.verifiedBytes >= attempt.byte_count)
      invalid();
    if (stepBytes < stepBudget) continue;
    const sealed = await seal.seal(
      JSON.stringify({
        datasetLast,
        datasetHash: datasetHash.save(),
        dataHash: dataHash.save(),
      } satisfies VerifySecrets),
      checkpointContext(state)
    );
    return {
      phase: 'verify_artifact',
      cursor: JSON.stringify({ ...state, sealed }),
      disposition: 'continue',
    };
  }
}

/** The metadata frame closes the last part; its sequence is the data frame count. */
async function readMetadata(
  part: Uint8Array,
  first: boolean,
  cipher: TenantBackupContainerV2Cipher,
  envelope: Uint8Array
): Promise<TenantBackupContainerManifestV2> {
  let last: TenantBackupContainerV2Frame | undefined;
  for (const frame of tenantBackupContainerV2Frames(part, first ? HEADER_BYTES : 0)) last = frame;
  if (!last || last.type !== 2 || last.end !== part.length) invalid();
  const plain = await cipher.open(last.sequence, 2, last.encrypted);
  return (await parseTenantBackupContainerV2Metadata(plain, envelope, last.sequence)).manifest;
}
