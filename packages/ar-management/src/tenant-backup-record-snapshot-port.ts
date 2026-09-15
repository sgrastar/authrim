import type { Env } from '@authrim/ar-lib-core';
import {
  decryptObjectArtifact,
  encryptObjectArtifact,
  type EncryptedObjectArtifactEnvelope,
} from '@authrim/ar-lib-core/services/object-artifact-crypto';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import type { Phase5RecordSnapshotPort } from './tenant-backup-phase5-adapter';

const MAX_RECORDS = 4096;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

interface SnapshotIndex {
  version: 2;
  resourceId: string;
  snapshotId: string;
  tenantId: string;
  operationId: string;
  boundaryUnixMs: number;
  records: readonly {
    key: string;
    sha256: string;
    bytes: number;
    summary: TenantBackupRecordSnapshotSummary | null;
  }[];
}

export type TenantBackupRecordSnapshotSummary = Readonly<
  Record<string, string | number | boolean | null>
>;

export interface EncryptedTenantBackupRecordSnapshotPort extends Phase5RecordSnapshotPort {
  readSummaries(
    context: AdapterContext,
    snapshotId: string,
    boundaryUnixMs: number
  ): Promise<readonly TenantBackupRecordSnapshotSummary[]>;
}

interface Cursor {
  version: 1;
  ordinal: number;
}

function invalid(): never {
  throw new Error('backup_record_snapshot_invalid');
}

function keyVersion(env: Pick<Env, 'OBJECT_ENCRYPTION_KEY_VERSION'>): number {
  const raw = env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1';
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) invalid();
  return Number(raw);
}

function rootKey(env: Pick<Env, 'OBJECT_ENCRYPTION_ROOT_KEY'>): string {
  const value = env.OBJECT_ENCRYPTION_ROOT_KEY;
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) invalid();
  return value;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function validateRecord(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_RECORD_BYTES) invalid();
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) invalid();
  try {
    const value: unknown = JSON.parse(text.slice(0, -1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  } catch {
    invalid();
  }
}

function validateSummary(
  value: TenantBackupRecordSnapshotSummary | null
): TenantBackupRecordSnapshotSummary | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const entries = Object.entries(value);
  if (
    entries.length > 16 ||
    entries.some(([key, item]) => {
      if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(key)) return true;
      if (item === null || typeof item === 'boolean') return false;
      if (typeof item === 'string') return new TextEncoder().encode(item).length > 512;
      return typeof item !== 'number' || !Number.isSafeInteger(item);
    }) ||
    new TextEncoder().encode(JSON.stringify(value)).length > 4096
  )
    invalid();
  return value;
}

function prefix(context: AdapterContext, resourceId: string, snapshotId: string): string {
  const tenantId = context.context.lease.tenantId;
  const operationId = context.context.lease.operationId;
  for (const value of [tenantId, operationId, resourceId, snapshotId])
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(value)) invalid();
  return `tenant-backup-snapshots/${tenantId}/${operationId}/${resourceId}/${snapshotId}/`;
}

function envelopeContext(tenantId: string, objectKey: string) {
  return { tenantId, objectKey, objectClass: 'dr_bundle' as const };
}

async function readEncryptedJson(
  bucket: R2Bucket,
  objectKey: string,
  tenantId: string,
  encryptionRootKey: string
): Promise<string | null> {
  const object = await bucket.get(objectKey);
  if (!object) return null;
  let envelope: EncryptedObjectArtifactEnvelope;
  try {
    envelope = JSON.parse(await object.text()) as EncryptedObjectArtifactEnvelope;
  } catch {
    return invalid();
  }
  if (
    envelope.plane !== 'EXPORT_ARTIFACTS' ||
    envelope.objectClass !== 'dr_bundle' ||
    envelope.contentType !== 'application/json'
  )
    invalid();
  return decryptObjectArtifact(envelope, {
    rootKeyHex: encryptionRootKey,
    context: envelopeContext(tenantId, objectKey),
  });
}

async function writeEncryptedJson(
  bucket: R2Bucket,
  objectKey: string,
  tenantId: string,
  plaintext: string,
  encryptionRootKey: string,
  encryptionKeyVersion: number
): Promise<void> {
  const envelope = await encryptObjectArtifact(plaintext, {
    rootKeyHex: encryptionRootKey,
    plane: 'EXPORT_ARTIFACTS',
    keyVersion: encryptionKeyVersion,
    contentType: 'application/json',
    context: envelopeContext(tenantId, objectKey),
  });
  await bucket.put(objectKey, JSON.stringify(envelope), {
    httpMetadata: { contentType: 'application/json' },
  });
}

function parseIndex(
  value: string,
  expected: Omit<SnapshotIndex, 'records' | 'boundaryUnixMs'>,
  expectedBoundaryUnixMs?: number
): SnapshotIndex {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded) ||
    Object.keys(decoded).sort().join(',') !==
      'boundaryUnixMs,operationId,records,resourceId,snapshotId,tenantId,version' ||
    !('records' in decoded) ||
    !Array.isArray(decoded.records)
  )
    invalid();
  const index = decoded as SnapshotIndex;
  if (
    index.version !== 2 ||
    index.resourceId !== expected.resourceId ||
    index.snapshotId !== expected.snapshotId ||
    index.tenantId !== expected.tenantId ||
    index.operationId !== expected.operationId ||
    !Number.isSafeInteger(index.boundaryUnixMs) ||
    index.boundaryUnixMs < 0 ||
    (expectedBoundaryUnixMs !== undefined && index.boundaryUnixMs !== expectedBoundaryUnixMs) ||
    index.records.length > MAX_RECORDS ||
    index.records.some((record, ordinal) => {
      if (
        !record ||
        Object.keys(record).sort().join(',') !== 'bytes,key,sha256,summary' ||
        record.key !== `record-${String(ordinal).padStart(4, '0')}-${record.sha256}.json` ||
        !/^[a-f0-9]{64}$/.test(record.sha256) ||
        !Number.isSafeInteger(record.bytes) ||
        record.bytes < 1 ||
        record.bytes > MAX_RECORD_BYTES
      )
        return true;
      validateSummary(record.summary);
      return false;
    })
  )
    invalid();
  return index;
}

function parseCursor(value: string | null): number {
  if (value === null) return 0;
  let cursor: Cursor;
  try {
    cursor = JSON.parse(value) as Cursor;
  } catch {
    return invalid();
  }
  if (
    !cursor ||
    Object.keys(cursor).sort().join(',') !== 'ordinal,version' ||
    cursor.version !== 1 ||
    !Number.isSafeInteger(cursor.ordinal) ||
    cursor.ordinal < 1 ||
    cursor.ordinal > MAX_RECORDS
  )
    invalid();
  return cursor.ordinal;
}

/**
 * Persist one immutable, environment-encrypted non-SQL snapshot. The portable bundle remains the
 * only cross-environment artifact; these staging objects are deleted before publication.
 */
export function createEncryptedTenantBackupRecordSnapshotPort(input: {
  env: Pick<
    Env,
    'EXPORT_ARTIFACTS' | 'OBJECT_ENCRYPTION_ROOT_KEY' | 'OBJECT_ENCRYPTION_KEY_VERSION'
  >;
  resourceId: string;
  assertSource(context: AdapterContext): Promise<void>;
  capture(context: AdapterContext): AsyncIterable<Uint8Array>;
  summarizeRecord?(
    bytes: Uint8Array
  ): TenantBackupRecordSnapshotSummary | null | Promise<TenantBackupRecordSnapshotSummary | null>;
}): EncryptedTenantBackupRecordSnapshotPort {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.resourceId)) invalid();
  const bucket = input.env.EXPORT_ARTIFACTS;
  if (!bucket) invalid();
  const encryptionRootKey = rootKey(input.env);
  const encryptionKeyVersion = keyVersion(input.env);

  const identity = (context: AdapterContext, snapshotId: string) => ({
    version: 2 as const,
    resourceId: input.resourceId,
    snapshotId,
    tenantId: context.context.lease.tenantId,
    operationId: context.context.lease.operationId,
  });
  const loadIndex = async (
    context: AdapterContext,
    snapshotId: string,
    boundaryUnixMs?: number
  ) => {
    const base = prefix(context, input.resourceId, snapshotId);
    const saved = await readEncryptedJson(
      bucket,
      `${base}index.json`,
      context.context.lease.tenantId,
      encryptionRootKey
    );
    return saved === null ? null : parseIndex(saved, identity(context, snapshotId), boundaryUnixMs);
  };

  return {
    resourceId: input.resourceId,
    assertSource: (context) => input.assertSource(context),
    async start(context, snapshotId, assertHeld, boundaryUnixMs) {
      if (!Number.isSafeInteger(boundaryUnixMs) || boundaryUnixMs < 0) invalid();
      const captureContext: AdapterContext = { ...context, boundaryUnixMs };
      await assertHeld();
      await input.assertSource(captureContext);
      const existing = await loadIndex(captureContext, snapshotId, boundaryUnixMs);
      if (existing) {
        await assertHeld();
        return;
      }
      const base = prefix(captureContext, input.resourceId, snapshotId);
      const records: SnapshotIndex['records'][number][] = [];
      for await (const captured of input.capture(captureContext)) {
        await assertHeld();
        captureContext.context.signal.throwIfAborted();
        const bytes = new Uint8Array(captured);
        validateRecord(bytes);
        if (records.length >= MAX_RECORDS) invalid();
        const digest = await sha256(bytes);
        const key = `record-${String(records.length).padStart(4, '0')}-${digest}.json`;
        const objectKey = `${base}${key}`;
        const plaintext = new TextDecoder().decode(bytes);
        const saved = await readEncryptedJson(
          bucket,
          objectKey,
          captureContext.context.lease.tenantId,
          encryptionRootKey
        );
        if (saved === null)
          await writeEncryptedJson(
            bucket,
            objectKey,
            captureContext.context.lease.tenantId,
            plaintext,
            encryptionRootKey,
            encryptionKeyVersion
          );
        else if (saved !== plaintext) invalid();
        records.push({
          key,
          sha256: digest,
          bytes: bytes.length,
          summary: validateSummary((await input.summarizeRecord?.(bytes)) ?? null),
        });
      }
      await input.assertSource(captureContext);
      await assertHeld();
      const index = {
        ...identity(captureContext, snapshotId),
        boundaryUnixMs,
        records,
      } satisfies SnapshotIndex;
      const indexJson = JSON.stringify(index);
      const raced = await loadIndex(captureContext, snapshotId, boundaryUnixMs);
      if (raced && JSON.stringify(raced) !== indexJson) invalid();
      if (!raced)
        await writeEncryptedJson(
          bucket,
          `${base}index.json`,
          captureContext.context.lease.tenantId,
          indexJson,
          encryptionRootKey,
          encryptionKeyVersion
        );
      const published = (await loadIndex(captureContext, snapshotId, boundaryUnixMs)) ?? invalid();
      if (JSON.stringify(published) !== indexJson) invalid();
      await assertHeld();
    },
    async readNext(context, snapshotId, cursor, signal) {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(context.boundaryUnixMs) || (context.boundaryUnixMs ?? -1) < 0)
        invalid();
      const index =
        (await loadIndex(context, snapshotId, context.boundaryUnixMs ?? -1)) ?? invalid();
      const ordinal = parseCursor(cursor);
      if (ordinal >= index.records.length) return null;
      const record = index.records[ordinal];
      const objectKey = `${prefix(context, input.resourceId, snapshotId)}${record.key}`;
      const plaintext =
        (await readEncryptedJson(
          bucket,
          objectKey,
          context.context.lease.tenantId,
          encryptionRootKey
        )) ?? invalid();
      const bytes = new TextEncoder().encode(plaintext);
      validateRecord(bytes);
      if (bytes.length !== record.bytes || (await sha256(bytes)) !== record.sha256) invalid();
      signal.throwIfAborted();
      return { bytes, nextCursor: JSON.stringify({ version: 1, ordinal: ordinal + 1 }) };
    },
    async readSummaries(context, snapshotId, boundaryUnixMs) {
      if (!Number.isSafeInteger(boundaryUnixMs) || boundaryUnixMs < 0) invalid();
      const index = (await loadIndex(context, snapshotId, boundaryUnixMs)) ?? invalid();
      return index.records.flatMap(({ summary }) =>
        summary === null ? [] : [Object.freeze({ ...summary })]
      );
    },
    async release(context, snapshotId) {
      const base = prefix(context, input.resourceId, snapshotId);
      while (true) {
        context.context.signal.throwIfAborted();
        const page = await bucket.list({
          prefix: base,
          limit: 1000,
        });
        if (page.objects.length) await bucket.delete(page.objects.map(({ key }) => key));
        if (!page.truncated) break;
        if (!page.objects.length) invalid();
      }
    },
    async assertReleased(context, snapshotId) {
      const page = await bucket.list({
        prefix: prefix(context, input.resourceId, snapshotId),
        limit: 1,
      });
      if (page.objects.length || page.truncated) invalid();
    },
  };
}
