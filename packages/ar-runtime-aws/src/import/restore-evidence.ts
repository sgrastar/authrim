import { hash as nodeHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import type { VerifiedAwsSamlSupplement } from './runtime-assembly-input';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SUPPLEMENT_BYTES = 256 * 1024 * 1024;

function invalid(): never {
  throw new Error('aws_restore_evidence_invalid');
}

/** Stable evidence encoding. Arrays retain their semantic order. */
export function canonicalRestoreJson(value: unknown): string {
  function normalize(input: unknown): unknown {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, normalize(item)])
      );
    }
    return invalid();
  }
  return JSON.stringify(normalize(value));
}

export function restoreEvidenceDigest(value: unknown): string {
  return nodeHash('sha256', canonicalRestoreJson(value), 'hex');
}

/** Reads a bounded local file once, refusing aliases or replacement during the read. */
export async function readPinnedRestoreFile(
  path: string,
  expectedSha256: string,
  maxBytes = MAX_SUPPLEMENT_BYTES
): Promise<Uint8Array> {
  try {
    if (!isAbsolute(path) || !SHA256.test(expectedSha256)) invalid();
    const absolute = resolve(path);
    if ((await realpath(absolute)) !== absolute) invalid();
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size < 1 || before.size > maxBytes) invalid();
      const bytes = await file.readFile();
      const after = await file.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        bytes.length !== Number(before.size) ||
        nodeHash('sha256', bytes, 'hex') !== expectedSha256
      )
        invalid();
      return bytes;
    } finally {
      await file.close();
    }
  } catch {
    return invalid();
  }
}

/**
 * The file hash comes from a separately trusted operator record. A hash placed beside an
 * untrusted upload does not establish source authenticity. Payload shape is checked by
 * assembly and the state importer before any activation can be published.
 */
export async function readVerifiedAwsSamlSupplement(input: {
  path: string;
  expectedSha256: string;
  manifest: TenantBundleManifest;
}): Promise<VerifiedAwsSamlSupplement> {
  try {
    const bytes = await readPinnedRestoreFile(input.path, input.expectedSha256);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(raw) as {
      formatVersion: number;
      receipt: VerifiedAwsSamlSupplement['receipt'];
      payload: Omit<VerifiedAwsSamlSupplement, 'receipt'>;
    };
    if (
      raw !== canonicalRestoreJson(value) ||
      value.formatVersion !== 1 ||
      Object.keys(value).sort().join(',') !== 'formatVersion,payload,receipt' ||
      !value.payload ||
      typeof value.payload !== 'object' ||
      Array.isArray(value.payload) ||
      Object.hasOwn(value.payload, 'receipt') ||
      value.receipt?.tenantId !== input.manifest.source.tenantId ||
      value.receipt.issuer !== input.manifest.source.issuer ||
      value.receipt.productVersion !== input.manifest.source.productVersion ||
      value.receipt.bundleId !== input.manifest.bundleId ||
      value.receipt.snapshotId !== input.manifest.snapshotId ||
      value.receipt.inventoryDigestSha256 !== input.manifest.inventoryDigestSha256 ||
      value.receipt.supplementSha256 !== restoreEvidenceDigest(value.payload)
    )
      invalid();
    return { ...value.payload, receipt: value.receipt };
  } catch {
    return invalid();
  }
}
