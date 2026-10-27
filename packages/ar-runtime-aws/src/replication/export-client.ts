import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { TenantBackupExportPublicationReceiptV1 } from '@authrim/ar-lib-core/services/tenant-portability/trusted-export-receipt';
import type { TenantPortableSourceIdentity } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import {
  TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES,
  TENANT_BACKUP_CONTAINER_V2_MAX_OBJECT_BYTES,
} from '@authrim/ar-lib-core/services/tenant-portability/backup-container-v2';
import { TENANT_BACKUP_ARTIFACT_PART_MAX_BYTES } from '@authrim/ar-lib-core/services/tenant-portability/artifact-writer';
import { canonicalRestoreJson } from '../import/restore-evidence';

const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function invalid(): never {
  throw new Error('replication_export_unavailable');
}

export interface DownloadReplicationExportInput {
  managementOrigin: string;
  operationId: string;
  /** Explicit delegated grant path. Omitted uses the existing fresh-human control session. */
  grantId?: string;
  /** Credential from the authorized control session, never an artifact-provided address/token. */
  authorization: string;
  expectedSource: TenantPortableSourceIdentity;
  outputDirectory: string;
  maxSnapshotAgeMs: number;
  minimumBoundaryUnixMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}

export interface DownloadedReplicationExport {
  publication: TenantBackupExportPublicationReceiptV1;
  partPaths: string[];
  publicationPath: string;
  publicationSha256: string;
}

function sourceOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) invalid();
  return value;
}

export function assertReplicationExportPublication(
  value: TenantBackupExportPublicationReceiptV1,
  input: Pick<
    DownloadReplicationExportInput,
    'operationId' | 'expectedSource' | 'maxSnapshotAgeMs' | 'minimumBoundaryUnixMs'
  >,
  now: number
): void {
  if (
    !value ||
    value.formatVersion !== 1 ||
    value.operationId !== input.operationId ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= now ||
    !Number.isSafeInteger(value.boundaryUnixMs) ||
    value.boundaryUnixMs < 1 ||
    value.boundaryUnixMs > now ||
    !Number.isSafeInteger(input.maxSnapshotAgeMs) ||
    input.maxSnapshotAgeMs < 1 ||
    now - value.boundaryUnixMs > input.maxSnapshotAgeMs ||
    (input.minimumBoundaryUnixMs !== undefined &&
      (!Number.isSafeInteger(input.minimumBoundaryUnixMs) ||
        input.minimumBoundaryUnixMs < 0 ||
        input.minimumBoundaryUnixMs > now)) ||
    value.boundaryUnixMs < (input.minimumBoundaryUnixMs ?? 0) ||
    !Number.isSafeInteger(value.byteCount) ||
    value.byteCount < 1 ||
    value.byteCount > TENANT_BACKUP_CONTAINER_V2_MAX_OBJECT_BYTES ||
    canonicalRestoreJson(value.receipt?.source) !== canonicalRestoreJson(input.expectedSource) ||
    !/^[a-f0-9]{32}$/u.test(value.receipt.bundleId) ||
    typeof value.receipt.snapshotId !== 'string' ||
    value.receipt.snapshotId.length < 1 ||
    value.receipt.snapshotId.length > 256 ||
    !HASH.test(value.receipt.inventoryDigestSha256) ||
    !isArray(value.receipt.parts) ||
    value.receipt.parts.length < 1 ||
    value.receipt.parts.length > TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES + 1 ||
    !value.selection ||
    !isArray(value.datasets) ||
    value.datasets.length < 1
  )
    invalid();
  let total = 0;
  for (const part of value.receipt.parts) {
    if (
      !part ||
      Object.keys(part).sort().join(',') !== 'sha256,size' ||
      !Number.isSafeInteger(part.size) ||
      part.size < 1 ||
      part.size > TENANT_BACKUP_ARTIFACT_PART_MAX_BYTES ||
      !HASH.test(part.sha256)
    )
      invalid();
    total += part.size;
  }
  if (total !== value.byteCount) invalid();
}

async function boundedReceipt(response: Response): Promise<TenantBackupExportPublicationReceiptV1> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    invalid();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RECEIPT_BYTES) invalid();
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  ) as TenantBackupExportPublicationReceiptV1;
}

/**
 * The receipt is obtained over an authenticated independent channel before opening ciphertext.
 * Ciphertext streams directly into exclusive files; a part is never buffered in memory. An
 * interrupted download owns only its newly-created directory and can safely start a new attempt.
 */
export async function downloadReplicationExport(
  input: DownloadReplicationExportInput
): Promise<DownloadedReplicationExport> {
  let owned = false;
  let directoryIdentity: { dev: bigint; ino: bigint } | undefined;
  try {
    sourceOrigin(input.managementOrigin);
    if (
      !/^[A-Za-z0-9_.:-]{1,256}$/u.test(input.operationId) ||
      !/^Bearer [A-Za-z0-9._~+/-]+=*$/u.test(input.authorization) ||
      (input.grantId !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.grantId)) ||
      !isAbsolute(input.outputDirectory) ||
      resolve(input.outputDirectory) !== input.outputDirectory
    )
      invalid();
    const transport = input.fetch ?? fetch;
    const signal = input.signal ?? AbortSignal.timeout(120_000);
    const base = input.grantId
      ? `${input.managementOrigin}/api/replication-backups/${encodeURIComponent(input.grantId)}/exports/${encodeURIComponent(input.operationId)}`
      : `${input.managementOrigin}/api/admin/tenant-backups/${encodeURIComponent(input.operationId)}`;
    const get = (path: string) =>
      transport(`${base}${path}`, {
        headers: {
          Authorization: input.authorization,
          Accept: 'application/json',
          'X-Tenant-Id': input.expectedSource.tenantId,
        },
        redirect: 'error',
        signal,
        cache: 'no-store',
      });
    const readReceipt = async () => {
      const value = await boundedReceipt(await get('/export-receipt'));
      assertReplicationExportPublication(value, input, (input.now ?? Date.now)());
      return value;
    };
    const publication = await readReceipt();
    const serialized = canonicalRestoreJson(publication);
    // mkdir without recursive: an existing/symlinked generation is never overwritten.
    await mkdir(input.outputDirectory, { mode: 0o700 });
    owned = true;
    const stat = await lstat(input.outputDirectory, { bigint: true });
    directoryIdentity = { dev: stat.dev, ino: stat.ino };
    if ((await realpath(input.outputDirectory)) !== input.outputDirectory) invalid();
    const downloaded = await get('/download');
    if (
      !downloaded.ok ||
      !downloaded.body ||
      downloaded.headers.get('content-length') !== String(publication.byteCount)
    ) {
      await downloaded.body?.cancel().catch(() => undefined);
      invalid();
    }
    const reader = downloaded.body.getReader();
    let carry = new Uint8Array(0) as Uint8Array;
    let ended = false;
    const paths: string[] = [];
    try {
      for (let index = 0; index < publication.receipt.parts.length; index++) {
        const part = publication.receipt.parts[index];
        const path = join(input.outputDirectory, `part-${String(index).padStart(6, '0')}.authrim2`);
        const file = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600
        );
        const hash = createHash('sha256');
        let written = 0;
        try {
          while (written < part.size) {
            signal.throwIfAborted();
            if (!carry.byteLength) {
              const next = await reader.read();
              if (next.done) invalid();
              carry = next.value;
            }
            const size = Math.min(carry.byteLength, part.size - written);
            const chunk = carry.subarray(0, size);
            // FileHandle.write can write fewer bytes; never silently skip the remainder.
            let position = 0;
            while (position < chunk.byteLength) {
              const result = await file.write(chunk.subarray(position));
              if (result.bytesWritten < 1) invalid();
              position += result.bytesWritten;
            }
            hash.update(chunk);
            written += size;
            carry = carry.subarray(size);
          }
          if (hash.digest('hex') !== part.sha256) invalid();
          await file.sync();
        } finally {
          await file.close();
        }
        paths.push(path);
      }
      if (carry.byteLength || !(await reader.read()).done) invalid();
      ended = true;
    } finally {
      if (!ended) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (canonicalRestoreJson(await readReceipt()) !== serialized) invalid();
    const publicationPath = join(input.outputDirectory, 'publication.json');
    const file = await open(publicationPath, 'wx', 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      await file.close();
    }
    return {
      publication,
      partPaths: paths,
      publicationPath,
      publicationSha256: createHash('sha256').update(serialized).digest('hex'),
    };
  } catch {
    if (owned && directoryIdentity) {
      const current = await lstat(input.outputDirectory, { bigint: true }).catch(() => null);
      if (current?.dev === directoryIdentity.dev && current.ino === directoryIdentity.ino)
        await rm(input.outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    return invalid();
  }
}
