import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import {
  TENANT_BACKUP_CONTAINER_V2_LIMITS,
  TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES,
  TENANT_BACKUP_CONTAINER_V2_MAX_OBJECT_BYTES,
} from '@authrim/ar-lib-core/services/tenant-portability/backup-container-v2';
import { unlockTenantBundleKeyEnvelope } from '@authrim/ar-lib-core/services/tenant-portability/bundle-key-envelope';
import {
  decodeTenantBundleManifest,
  type TenantBundleManifest,
} from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import { TenantBackupContainerFrameReader } from '@authrim/ar-lib-core/services/tenant-portability/container-frame-reader';
import { parseTenantBackupContainerRowCursor } from '@authrim/ar-lib-core/services/tenant-portability/container-dataset-reader';
import {
  initialTenantBackupContainerVerificationProgress,
  verifyTenantBackupContainerV2Slice,
} from '@authrim/ar-lib-core/services/tenant-portability/input-container-verification';
import {
  assertTenantBackupInputFrameChain,
  type TenantBackupInputFrame,
} from '@authrim/ar-lib-core/services/tenant-portability/input-frame-index';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';
import { PinnedTenantBackupInputObject } from '@authrim/ar-lib-core/services/tenant-portability/pinned-input-object';
import type { TenantBackupSelection } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';

const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_PARTS = TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES + 1;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const HEX_BUNDLE_ID = /^[a-f0-9]{32}$/u;
const MAGIC = new TextEncoder().encode('AUTHRIM2');

import type { TrustedTenantBackupExportReceiptV2 } from '@authrim/ar-lib-core/services/tenant-portability/trusted-export-receipt';
export type { TrustedTenantBackupExportReceiptV2 } from '@authrim/ar-lib-core/services/tenant-portability/trusted-export-receipt';

export interface VerifiedTenantBackupDatasetV2 {
  readonly id: string;
  readonly rows: number;
  readonly bytes: number;
  /** SQL datasets contain one PortableSqliteRow JSON object per line. */
  readNextRow(cursor: string | null): Promise<{ rowJson: string; nextCursor: string } | null>;
}

export interface VerifiedTenantBackupV2 {
  readonly manifest: TenantBundleManifest;
  /** Unknown IDs reject; no dataset can be read before the complete artifact has been verified. */
  dataset(id: string): VerifiedTenantBackupDatasetV2;
  close(): Promise<void>;
}

export interface OpenVerifiedTenantBackupV2Input {
  /** One local file per receipt part, in the same order. Symbolic links are refused. */
  partPaths: readonly string[];
  receipt: TrustedTenantBackupExportReceiptV2;
  passphrase: string;
  /** Installed selection and complete installed dataset inventory, never from the artifact. */
  selection: TenantBackupSelection;
  datasets: readonly TenantPortableDataset[];
  maxSnapshotAgeMs: number;
  nowMs?: number;
  signal?: AbortSignal;
}

type FileStat = Awaited<ReturnType<FileHandle['stat']>> & {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

interface PinnedPart {
  path: string;
  offset: number;
  size: number;
  stat: FileStat;
}

function invalid(): never {
  // Never expose a file path, passphrase, ciphertext, row, or private key through this boundary.
  throw new Error('aws_backup_reader_invalid');
}

function sameFile(left: FileStat, right: FileStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  );
}

async function noSymlink(path: string): Promise<FileStat> {
  if (!isAbsolute(path)) invalid();
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const components = absolute.slice(current.length).split(sep).filter(Boolean);
  if (!components.length) invalid();
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]);
    const stat = (await lstat(current, { bigint: true })) as FileStat;
    if (stat.isSymbolicLink()) invalid();
    if (index < components.length - 1 && !stat.isDirectory()) invalid();
    if (index === components.length - 1) {
      if (!stat.isFile()) invalid();
      return stat;
    }
  }
  return invalid();
}

async function withPinnedFile<T>(
  part: PinnedPart,
  use: (file: FileHandle) => Promise<T>
): Promise<T> {
  const pathStat = await noSymlink(part.path);
  if (!sameFile(pathStat, part.stat)) invalid();
  const file = await open(part.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameFile((await file.stat({ bigint: true })) as FileStat, part.stat)) invalid();
    const result = await use(file);
    if (
      !sameFile((await file.stat({ bigint: true })) as FileStat, part.stat) ||
      !sameFile(await noSymlink(part.path), part.stat)
    ) {
      invalid();
    }
    return result;
  } finally {
    await file.close();
  }
}

async function pinPart(
  path: string,
  expected: { size: number; sha256: string },
  offset: number
): Promise<PinnedPart> {
  const stat = await noSymlink(path);
  if (
    !Number.isSafeInteger(expected.size) ||
    expected.size < 1 ||
    BigInt(expected.size) !== stat.size ||
    !HEX_SHA256.test(expected.sha256)
  ) {
    invalid();
  }
  const part = { path: resolve(path), offset, size: expected.size, stat };
  const digest = await withPinnedFile(part, async (file) => {
    const hash = createHash('sha256');
    const buffer = new Uint8Array(HASH_CHUNK_BYTES);
    let position = 0;
    while (position < part.size) {
      const count = Math.min(buffer.length, part.size - position);
      const { bytesRead } = await file.read(buffer, 0, count, position);
      if (bytesRead < 1) invalid();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  });
  if (digest !== expected.sha256) invalid();
  return part;
}

function partAt(parts: readonly PinnedPart[], offset: number): PinnedPart {
  let low = 0;
  let high = parts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (parts[middle].offset <= offset) low = middle;
    else high = middle - 1;
  }
  const part = parts[low];
  if (!part || offset < part.offset || offset >= part.offset + part.size) invalid();
  return part;
}

async function readRange(
  parts: readonly PinnedPart[],
  offset: number,
  length: number,
  totalSize: number
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 1 ||
    offset + length > totalSize ||
    length > TENANT_BACKUP_CONTAINER_V2_LIMITS.maxFramePlainBytes + 1024 * 1024
  ) {
    invalid();
  }
  const output = new Uint8Array(length);
  let copied = 0;
  while (copied < length) {
    const part = partAt(parts, offset + copied);
    const localOffset = offset + copied - part.offset;
    const count = Math.min(length - copied, part.size - localOffset);
    await withPinnedFile(part, async (file) => {
      let written = 0;
      while (written < count) {
        const { bytesRead } = await file.read(
          output,
          copied + written,
          count - written,
          localOffset + written
        );
        if (bytesRead < 1) invalid();
        written += bytesRead;
      }
    });
    copied += count;
  }
  return output;
}

/** Keep the core frame reader's API while disabling its small-object ciphertext cache. */
class OfflinePinnedInputObject extends PinnedTenantBackupInputObject {
  constructor(
    input: ConstructorParameters<typeof PinnedTenantBackupInputObject>[0],
    private readonly readLocal: (offset: number, length: number) => Promise<Uint8Array<ArrayBuffer>>
  ) {
    super(input);
  }

  override async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    return this.readLocal(offset, length);
  }
}

function validateInput(input: OpenVerifiedTenantBackupV2Input): number {
  const receipt = input.receipt;
  const now = input.nowMs ?? Date.now();
  if (
    !receipt ||
    !receipt.source?.tenantId ||
    !receipt.source.issuer ||
    !receipt.source.productVersion ||
    !HEX_BUNDLE_ID.test(receipt.bundleId) ||
    !receipt.snapshotId ||
    !HEX_SHA256.test(receipt.inventoryDigestSha256) ||
    !Array.isArray(receipt.parts) ||
    receipt.parts.length < 1 ||
    receipt.parts.length > MAX_PARTS ||
    !Array.isArray(input.partPaths) ||
    input.partPaths.length !== receipt.parts.length ||
    !Array.isArray(input.datasets) ||
    input.datasets.length < 1 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(input.maxSnapshotAgeMs) ||
    input.maxSnapshotAgeMs < 1 ||
    typeof input.passphrase !== 'string'
  ) {
    invalid();
  }
  return now;
}

/**
 * Offline AUTHRIM2 reader. It does not establish Cloudflare authorship: the caller must pin the
 * receipt from a separate trusted export record. No row is exposed until every frame, footer,
 * dataset digest, manifest identity and local file has been checked.
 */
export async function openVerifiedTenantBackupV2(
  input: OpenVerifiedTenantBackupV2Input
): Promise<VerifiedTenantBackupV2> {
  try {
    const now = validateInput(input);
    // Pin caller-controlled policy before the first asynchronous file operation.
    const receipt = structuredClone(input.receipt);
    const partPaths = [...input.partPaths];
    const selection = structuredClone(input.selection);
    const datasets = input.datasets.map((dataset) => ({ ...dataset }));
    const maxSnapshotAgeMs = input.maxSnapshotAgeMs;
    const passphrase = input.passphrase;
    const signal = input.signal ?? new AbortController().signal;
    const parts: PinnedPart[] = [];
    let totalSize = 0;
    for (let index = 0; index < partPaths.length; index++) {
      signal.throwIfAborted();
      const receiptPart = receipt.parts[index];
      const part = await pinPart(partPaths[index], receiptPart, totalSize);
      parts.push(part);
      totalSize += part.size;
      if (
        !Number.isSafeInteger(totalSize) ||
        totalSize > TENANT_BACKUP_CONTAINER_V2_MAX_OBJECT_BYTES
      )
        invalid();
    }
    if (totalSize < TENANT_BACKUP_CONTAINER_V2_LIMITS.headerBytes + 25) invalid();
    const header = await readRange(
      parts,
      0,
      TENANT_BACKUP_CONTAINER_V2_LIMITS.headerBytes,
      totalSize
    );
    if (!MAGIC.every((byte, index) => header[index] === byte)) invalid();
    const session = await unlockTenantBundleKeyEnvelope(header.subarray(8, 101), passphrase);
    const expected = {
      bundleId: receipt.bundleId,
      source: receipt.source,
      selection,
      datasets,
    };
    let closed = false;
    const assertOpen = () => {
      if (closed) invalid();
    };
    const identity = {
      key: 'offline-authrim2',
      version: 'pinned-file-v1',
      etag: 'pinned-file-v1',
      size: totalSize,
    };
    const object = new OfflinePinnedInputObject(
      {
        bucket: { get: async () => null },
        identity,
        signal,
        assertAuthorized: async () => {
          assertOpen();
          signal.throwIfAborted();
        },
      },
      async (offset, length) => {
        assertOpen();
        signal.throwIfAborted();
        return readRange(parts, offset, length, totalSize);
      }
    );
    const frames: TenantBackupInputFrame[] = [];
    let verifiedManifest: TenantBundleManifest | undefined;
    let progress = initialTenantBackupContainerVerificationProgress();
    let complete: Awaited<ReturnType<typeof verifyTenantBackupContainerV2Slice>> | undefined;
    for (let transition = 0; transition < MAX_PARTS * 2 + 4; transition++) {
      signal.throwIfAborted();
      complete = await verifyTenantBackupContainerV2Slice({
        object,
        session,
        progress,
        loadFrames: async (from, count) => frames.slice(from, from + count),
        saveFrames: async (page) => {
          if (page.length && page[0].sequence !== frames.length) invalid();
          frames.push(...page);
          assertTenantBackupInputFrameChain(frames);
        },
        acceptManifest: (containerManifest) => {
          const backup = decodeTenantBundleManifest(
            new TextEncoder().encode(JSON.stringify(containerManifest.backup)),
            expected
          );
          if (
            backup.snapshotId !== receipt.snapshotId ||
            backup.inventoryDigestSha256 !== receipt.inventoryDigestSha256 ||
            backup.boundaryUnixMs > now + MAX_FUTURE_SKEW_MS ||
            now - backup.boundaryUnixMs > maxSnapshotAgeMs ||
            containerManifest.datasets.length !== backup.datasets.length ||
            containerManifest.datasets.some(
              (dataset, index) => dataset.id !== backup.datasets[index].id
            )
          )
            invalid();
          verifiedManifest = backup;
        },
        signal,
      });
      if (complete.done) break;
      progress = complete.progress;
    }
    if (!complete?.done || !verifiedManifest) invalid();
    for (const part of parts) if (!sameFile(await noSymlink(part.path), part.stat)) invalid();
    const reader = await TenantBackupContainerFrameReader.open({
      object,
      session,
      frames,
      datasets: complete.manifest.datasets,
      totalBytes: complete.manifest.totalBytes,
    });
    const allowed = new Set(verifiedManifest.datasets.map((dataset) => dataset.id));
    const publicManifest = structuredClone(verifiedManifest);
    Object.freeze(publicManifest.source);
    Object.freeze(publicManifest.selection.logs);
    Object.freeze(publicManifest.selection);
    for (const dataset of publicManifest.datasets) Object.freeze(dataset);
    Object.freeze(publicManifest.datasets);
    Object.freeze(publicManifest);
    function frameAt(position: number): number {
      let low = 0;
      let high = frames.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >>> 1;
        if (frames[middle].plainOffset <= position) low = middle;
        else high = middle - 1;
      }
      const frame = frames[low];
      if (
        !frame ||
        position < frame.plainOffset ||
        position >= frame.plainOffset + frame.plainBytes
      )
        invalid();
      return low;
    }
    async function assertRowPartsPinned(
      datasetOffset: number,
      datasetBytes: number,
      cursor: string | null
    ) {
      const offset = parseTenantBackupContainerRowCursor(cursor, datasetBytes);
      if (datasetBytes === 0) return;
      const first = frameAt(datasetOffset + Math.min(offset, datasetBytes - 1));
      const touched = new Set<PinnedPart>();
      // The shared row reader itself refuses rows spanning more than twelve frames.
      for (let index = first; index < Math.min(first + 12, frames.length); index++) {
        const frame = frames[index];
        const end = frame.objectOffset + frame.frameBytes;
        for (let position = frame.objectOffset; position < end; ) {
          const part = partAt(parts, position);
          touched.add(part);
          position = Math.min(end, part.offset + part.size);
        }
      }
      for (const part of touched) if (!sameFile(await noSymlink(part.path), part.stat)) invalid();
    }
    return {
      manifest: publicManifest,
      dataset(id) {
        assertOpen();
        if (!allowed.has(id)) invalid();
        const source = reader.dataset(id);
        const descriptor =
          complete.manifest.datasets.find((dataset) => dataset.id === id) ?? invalid();
        return {
          id: source.id,
          rows: source.rows,
          bytes: source.bytes,
          async readNextRow(cursor) {
            try {
              assertOpen();
              await assertRowPartsPinned(descriptor.offset, descriptor.bytes, cursor);
              const row = await source.readNextRow(cursor);
              await assertRowPartsPinned(descriptor.offset, descriptor.bytes, cursor);
              return row;
            } catch {
              return invalid();
            }
          },
        };
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          for (const part of parts) if (!sameFile(await noSymlink(part.path), part.stat)) invalid();
        } catch {
          return invalid();
        }
      },
    };
  } catch {
    return invalid();
  }
}
