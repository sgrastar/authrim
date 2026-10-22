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
/**
 * Deferred R2 plans are listed after the write hold, from the T0 SQL snapshot, in pages. A page
 * holds the plans of one deterministic slice of source rows, so a retried slice writes the same
 * page again. The bounds keep one page and the root index well inside one Worker's memory.
 */
export const DEFERRED_PLAN_PAGE_MAX_PLANS = 256;
const DEFERRED_PLAN_PAGE_MAX_BYTES = 4 * 1024 * 1024;
export const DEFERRED_PLAN_MAX_PAGES = 16_384;
export const DEFERRED_PLAN_MAX_PLANS = 200_000;
/** Pages of one folder including the attempts of failed slices, which are never deleted. */
const DEFERRED_PLAN_MAX_STAGED_KEYS = 2 * DEFERRED_PLAN_MAX_PAGES;
const RELEASE_PAGE_OBJECTS = 1000;
const SUMMARY_READ_CONCURRENCY = 8;

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
  /** Visit every plan summary; nothing is kept, so the caller's memory follows what it keeps. */
  readSummaries(
    context: AdapterContext,
    snapshotId: string,
    boundaryUnixMs: number,
    visit: (summary: TenantBackupRecordSnapshotSummary) => void
  ): Promise<void>;
}

interface Cursor {
  version: 1;
  ordinal: number;
}

interface DeferredPlan {
  plaintext: string;
  sha256: string;
  bytes: number;
  summary: TenantBackupRecordSnapshotSummary | null;
}

interface DeferredPlanPage {
  version: 1;
  ordinal: number;
  plans: readonly DeferredPlan[];
}

interface DeferredPageReference {
  key: string;
  sha256: string;
  plans: number;
  /** The page's plan summaries, stored apart so the reference closure reads only these. */
  summaryKey: string;
  summarySha256: string;
}

interface DeferredSummaryPage {
  version: 1;
  ordinal: number;
  summaries: readonly (TenantBackupRecordSnapshotSummary | null)[];
}

/** Version 3 kept every plan inline and was written inside the hold; it is no longer read. */
interface DeferredSnapshotIndex {
  version: 4;
  resourceId: string;
  snapshotId: string;
  tenantId: string;
  operationId: string;
  boundaryUnixMs: number;
  planCount: number;
  pages: readonly DeferredPageReference[];
}

interface DeferredMaterializedIndex {
  version: 1;
  planSha256: string;
  records: readonly {
    key: string;
    sha256: string;
    bytes: number;
  }[];
}

interface DeferredCursor {
  version: 2;
  planOrdinal: number;
  recordOrdinal: number;
}

function invalid(): never {
  throw new Error('backup_record_snapshot_invalid');
}

/**
 * Retrying cannot shrink the staged R2 plans of this export. The existing permanent failure code
 * makes the scheduler clean the export up instead of retrying it.
 */
function throwPlanLimit(): never {
  throw new Error('backup_export_too_large');
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
    async readSummaries(context, snapshotId, boundaryUnixMs, visit) {
      if (!Number.isSafeInteger(boundaryUnixMs) || boundaryUnixMs < 0) invalid();
      const index = (await loadIndex(context, snapshotId, boundaryUnixMs)) ?? invalid();
      for (const { summary } of index.records)
        if (summary !== null) visit(Object.freeze({ ...summary }));
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

function parseDeferredIndex(
  value: string,
  expected: Omit<DeferredSnapshotIndex, 'pages' | 'boundaryUnixMs' | 'planCount' | 'version'>,
  expectedBoundaryUnixMs?: number
): DeferredSnapshotIndex {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) invalid();
  // An index written inside the hold by an older version: the export must start again.
  if ((decoded as { version?: unknown }).version === 3)
    throw new Error('backup_record_snapshot_format_unsupported');
  if (
    Object.keys(decoded).sort().join(',') !==
      'boundaryUnixMs,operationId,pages,planCount,resourceId,snapshotId,tenantId,version' ||
    !('pages' in decoded) ||
    !Array.isArray(decoded.pages)
  )
    invalid();
  const index = decoded as DeferredSnapshotIndex;
  let total = 0;
  if (
    index.version !== 4 ||
    index.resourceId !== expected.resourceId ||
    index.snapshotId !== expected.snapshotId ||
    index.tenantId !== expected.tenantId ||
    index.operationId !== expected.operationId ||
    !Number.isSafeInteger(index.boundaryUnixMs) ||
    index.boundaryUnixMs < 0 ||
    (expectedBoundaryUnixMs !== undefined && index.boundaryUnixMs !== expectedBoundaryUnixMs) ||
    index.pages.length > DEFERRED_PLAN_MAX_PAGES ||
    index.pages.some((page, ordinal) => {
      if (
        !page ||
        Object.keys(page).sort().join(',') !== 'key,plans,sha256,summaryKey,summarySha256' ||
        !/^[a-f0-9]{64}$/.test(page.sha256) ||
        !/^[a-f0-9]{64}$/.test(page.summarySha256) ||
        !Number.isSafeInteger(page.plans) ||
        page.plans < 1 ||
        page.plans > DEFERRED_PLAN_PAGE_MAX_PLANS
      )
        return true;
      const key = parseDeferredPageKey(page.key);
      const summary = parseDeferredSummaryKey(page.summaryKey);
      if (
        key.ordinal !== ordinal ||
        key.plans !== page.plans ||
        key.sha256 !== page.sha256 ||
        summary.ordinal !== ordinal ||
        summary.fence !== key.fence ||
        summary.sha256 !== page.summarySha256
      )
        return true;
      total += page.plans;
      return false;
    }) ||
    !Number.isSafeInteger(index.planCount) ||
    index.planCount !== total ||
    index.planCount > DEFERRED_PLAN_MAX_PLANS
  )
    invalid();
  return index;
}

// Keys carry the writer's lease fencing token. A slice retried under a newer lease writes its
// page beside the attempts of older leases instead of replacing them, and publication takes the
// newest attempt of each ordinal: only the lease that saved the cursor can have written that one.
const FENCE_DIGITS = 12;

function deferredPageKey(ordinal: number, fence: number, plans: number, sha256: string): string {
  return `plan-pages/${String(ordinal).padStart(6, '0')}-${String(fence).padStart(FENCE_DIGITS, '0')}-${String(plans).padStart(4, '0')}-${sha256}.json`;
}

function parseDeferredPageKey(key: string): {
  ordinal: number;
  fence: number;
  plans: number;
  sha256: string;
} {
  const match = /^plan-pages\/([0-9]{6})-([0-9]{12})-([0-9]{4})-([a-f0-9]{64})\.json$/.exec(key);
  if (!match) return invalid();
  return {
    ordinal: Number(match[1]),
    fence: Number(match[2]),
    plans: Number(match[3]),
    sha256: match[4],
  };
}

function deferredSummaryKey(ordinal: number, fence: number, sha256: string): string {
  return `plan-summaries/${String(ordinal).padStart(6, '0')}-${String(fence).padStart(FENCE_DIGITS, '0')}-${sha256}.json`;
}

function parseDeferredSummaryKey(key: string): { ordinal: number; fence: number; sha256: string } {
  const match = /^plan-summaries\/([0-9]{6})-([0-9]{12})-([a-f0-9]{64})\.json$/.exec(key);
  if (!match) return invalid();
  return { ordinal: Number(match[1]), fence: Number(match[2]), sha256: match[3] };
}

function leaseFence(context: AdapterContext): number {
  const fence = context.context.lease.fencingToken;
  if (!Number.isSafeInteger(fence) || fence < 0 || fence >= 10 ** FENCE_DIGITS) invalid();
  return fence;
}

function parseDeferredSummaryPage(
  value: string,
  ordinal: number,
  plans: number
): DeferredSummaryPage {
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
    Object.keys(decoded).sort().join(',') !== 'ordinal,summaries,version' ||
    !('summaries' in decoded) ||
    !Array.isArray(decoded.summaries)
  )
    invalid();
  const page = decoded as DeferredSummaryPage;
  if (page.version !== 1 || page.ordinal !== ordinal || page.summaries.length !== plans) invalid();
  for (const summary of page.summaries) validateSummary(summary);
  return page;
}

function validatePlan(plan: DeferredPlan): void {
  if (
    !plan ||
    Object.keys(plan).sort().join(',') !== 'bytes,plaintext,sha256,summary' ||
    typeof plan.plaintext !== 'string' ||
    new TextEncoder().encode(plan.plaintext).length !== plan.bytes ||
    !/^[a-f0-9]{64}$/.test(plan.sha256) ||
    !Number.isSafeInteger(plan.bytes) ||
    plan.bytes < 1 ||
    plan.bytes > MAX_RECORD_BYTES
  )
    invalid();
  validateSummary(plan.summary);
}

function parseDeferredPage(value: string, ordinal: number, plans: number): DeferredPlanPage {
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
    Object.keys(decoded).sort().join(',') !== 'ordinal,plans,version' ||
    !('plans' in decoded) ||
    !Array.isArray(decoded.plans)
  )
    invalid();
  const page = decoded as DeferredPlanPage;
  if (page.version !== 1 || page.ordinal !== ordinal || page.plans.length !== plans) invalid();
  for (const plan of page.plans) validatePlan(plan);
  return page;
}

function parseMaterializedIndex(value: string, planSha256: string): DeferredMaterializedIndex {
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
    Object.keys(decoded).sort().join(',') !== 'planSha256,records,version' ||
    !('records' in decoded) ||
    !Array.isArray(decoded.records)
  )
    invalid();
  const index = decoded as DeferredMaterializedIndex;
  if (
    index.version !== 1 ||
    index.planSha256 !== planSha256 ||
    index.records.length < 1 ||
    index.records.length > 64 ||
    index.records.some(
      (record, ordinal) =>
        !record ||
        Object.keys(record).sort().join(',') !== 'bytes,key,sha256' ||
        record.key !== `record-${String(ordinal).padStart(2, '0')}-${record.sha256}.json` ||
        !/^[a-f0-9]{64}$/.test(record.sha256) ||
        !Number.isSafeInteger(record.bytes) ||
        record.bytes < 1 ||
        record.bytes > MAX_RECORD_BYTES
    )
  )
    invalid();
  return index;
}

function parseDeferredCursor(value: string | null): DeferredCursor {
  if (value === null) return { version: 2, planOrdinal: 0, recordOrdinal: 0 };
  let cursor: DeferredCursor;
  try {
    cursor = JSON.parse(value) as DeferredCursor;
  } catch {
    return invalid();
  }
  if (
    !cursor ||
    Object.keys(cursor).sort().join(',') !== 'planOrdinal,recordOrdinal,version' ||
    cursor.version !== 2 ||
    !Number.isSafeInteger(cursor.planOrdinal) ||
    cursor.planOrdinal < 0 ||
    cursor.planOrdinal > DEFERRED_PLAN_MAX_PLANS ||
    !Number.isSafeInteger(cursor.recordOrdinal) ||
    cursor.recordOrdinal < 0 ||
    cursor.recordOrdinal > 64
  )
    invalid();
  return cursor;
}

export interface DeferredEncryptedTenantBackupRecordSnapshotPort extends EncryptedTenantBackupRecordSnapshotPort {
  /**
   * Store the plans of one source slice. Ordinals start at 0 and leave no gaps. Before the index
   * is published a retried slice may write its page again; after publication only the identical
   * page is accepted.
   */
  writePlanPage(
    context: AdapterContext,
    snapshotId: string,
    ordinal: number,
    plans: readonly Uint8Array[]
  ): Promise<void>;
  /** Publish the index over exactly `pages` written pages. Idempotent. */
  publishPlans(
    context: AdapterContext,
    snapshotId: string,
    boundaryUnixMs: number,
    pages: number
  ): Promise<void>;
  /** Delete one listing page of staged objects; true once nothing is left. */
  releasePage(context: AdapterContext, snapshotId: string): Promise<boolean>;
}

/**
 * Plans of R2 bodies, one per object, staged as encrypted pages by the export preparation after
 * the write hold. Source bodies are materialized into encrypted staging on the first read. A
 * materialized sub-index makes every subsequent cursor retry independent of the mutable source.
 */
export function createDeferredEncryptedTenantBackupRecordSnapshotPort(input: {
  env: Pick<
    Env,
    'EXPORT_ARTIFACTS' | 'OBJECT_ENCRYPTION_ROOT_KEY' | 'OBJECT_ENCRYPTION_KEY_VERSION'
  >;
  resourceId: string;
  assertSource(context: AdapterContext): Promise<void>;
  materializePlan(context: AdapterContext, plan: Uint8Array): AsyncIterable<Uint8Array>;
  summarizePlan?(
    bytes: Uint8Array
  ): TenantBackupRecordSnapshotSummary | null | Promise<TenantBackupRecordSnapshotSummary | null>;
}): DeferredEncryptedTenantBackupRecordSnapshotPort {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.resourceId)) invalid();
  const bucket = input.env.EXPORT_ARTIFACTS;
  if (!bucket) invalid();
  const encryptionRootKey = rootKey(input.env);
  const encryptionKeyVersion = keyVersion(input.env);
  const identity = (context: AdapterContext, snapshotId: string) => ({
    resourceId: input.resourceId,
    snapshotId,
    tenantId: context.context.lease.tenantId,
    operationId: context.context.lease.operationId,
  });
  // A published index never changes, so one decoded copy per port instance serves every read.
  let cachedIndex: { base: string; index: DeferredSnapshotIndex } | null = null;
  const loadIndex = async (
    context: AdapterContext,
    snapshotId: string,
    boundaryUnixMs?: number
  ) => {
    const base = prefix(context, input.resourceId, snapshotId);
    if (cachedIndex?.base === base) {
      if (boundaryUnixMs !== undefined && cachedIndex.index.boundaryUnixMs !== boundaryUnixMs)
        invalid();
      return cachedIndex.index;
    }
    const saved = await readEncryptedJson(
      bucket,
      `${base}index.json`,
      context.context.lease.tenantId,
      encryptionRootKey
    );
    if (saved === null) return null;
    const index = parseDeferredIndex(saved, identity(context, snapshotId), boundaryUnixMs);
    cachedIndex = { base, index };
    return index;
  };
  // One decoded page per port instance: a read session walks plans in order.
  let cachedPage: { objectKey: string; page: DeferredPlanPage } | null = null;
  const loadPage = async (
    context: AdapterContext,
    snapshotId: string,
    reference: DeferredPageReference,
    ordinal: number
  ): Promise<DeferredPlanPage> => {
    const objectKey = `${prefix(context, input.resourceId, snapshotId)}${reference.key}`;
    if (cachedPage?.objectKey === objectKey) return cachedPage.page;
    const saved =
      (await readEncryptedJson(
        bucket,
        objectKey,
        context.context.lease.tenantId,
        encryptionRootKey
      )) ?? invalid();
    if ((await sha256(new TextEncoder().encode(saved))) !== reference.sha256) invalid();
    const page = parseDeferredPage(saved, ordinal, reference.plans);
    cachedPage = { objectKey, page };
    return page;
  };
  const planAt = async (
    context: AdapterContext,
    snapshotId: string,
    index: DeferredSnapshotIndex,
    planOrdinal: number
  ): Promise<DeferredPlan> => {
    let first = 0;
    for (const [ordinal, reference] of index.pages.entries()) {
      if (planOrdinal < first + reference.plans)
        return (await loadPage(context, snapshotId, reference, ordinal)).plans[planOrdinal - first];
      first += reference.plans;
    }
    return invalid();
  };
  const loadMaterializedIndex = async (
    context: AdapterContext,
    base: string,
    planOrdinal: number,
    planSha256: string
  ) => {
    const saved = await readEncryptedJson(
      bucket,
      `${base}materialized-${String(planOrdinal).padStart(4, '0')}/index.json`,
      context.context.lease.tenantId,
      encryptionRootKey
    );
    return saved === null ? null : parseMaterializedIndex(saved, planSha256);
  };
  const listKeys = async (base: string, folder: string): Promise<string[]> => {
    const keys: string[] = [];
    let cursor: string | undefined;
    while (true) {
      const listed = await bucket.list({ prefix: `${base}${folder}`, cursor, limit: 1000 });
      keys.push(...listed.objects.map(({ key }) => key.slice(base.length)));
      if (keys.length > DEFERRED_PLAN_MAX_STAGED_KEYS) throwPlanLimit();
      if (!listed.truncated) return keys;
      cursor = listed.cursor;
    }
  };

  return {
    resourceId: input.resourceId,
    assertSource: (context) => input.assertSource(context),
    async start(context, _snapshotId, assertHeld, boundaryUnixMs) {
      // Plans are listed from the T0 SQL snapshot after the hold; nothing is enumerated here.
      if (!Number.isSafeInteger(boundaryUnixMs) || boundaryUnixMs < 0) invalid();
      await assertHeld();
      await input.assertSource({ ...context, boundaryUnixMs });
      await assertHeld();
    },
    async writePlanPage(context, snapshotId, ordinal, values) {
      context.context.signal.throwIfAborted();
      if (
        !Number.isSafeInteger(ordinal) ||
        ordinal < 0 ||
        !values.length ||
        values.length > DEFERRED_PLAN_PAGE_MAX_PLANS
      )
        invalid();
      // Sparse selections can stage one plan per source slice; that many pages is too large.
      if (ordinal >= DEFERRED_PLAN_MAX_PAGES) throwPlanLimit();
      const plans: DeferredPlan[] = [];
      let pageBytes = 0;
      for (const value of values) {
        const bytes = new Uint8Array(value);
        validateRecord(bytes);
        pageBytes += bytes.length;
        if (pageBytes > DEFERRED_PLAN_PAGE_MAX_BYTES) throwPlanLimit();
        plans.push({
          plaintext: new TextDecoder().decode(bytes),
          sha256: await sha256(bytes),
          bytes: bytes.length,
          summary: validateSummary((await input.summarizePlan?.(bytes)) ?? null),
        });
      }
      const pageJson = JSON.stringify({ version: 1, ordinal, plans } satisfies DeferredPlanPage);
      const pageSha256 = await sha256(new TextEncoder().encode(pageJson));
      const fence = leaseFence(context);
      const key = deferredPageKey(ordinal, fence, plans.length, pageSha256);
      const summaryJson = JSON.stringify({
        version: 1,
        ordinal,
        summaries: plans.map(({ summary }) => summary),
      } satisfies DeferredSummaryPage);
      const summaryKey = deferredSummaryKey(
        ordinal,
        fence,
        await sha256(new TextEncoder().encode(summaryJson))
      );
      const base = prefix(context, input.resourceId, snapshotId);
      // Only a lease that lost its cursor writes after publication; the index no longer changes.
      if (await loadIndex(context, snapshotId)) return;
      // The summary goes first, so the page publication picks always has one.
      for (const [objectKey, plaintext] of [
        [summaryKey, summaryJson],
        [key, pageJson],
      ])
        await writeEncryptedJson(
          bucket,
          `${base}${objectKey}`,
          context.context.lease.tenantId,
          plaintext,
          encryptionRootKey,
          encryptionKeyVersion
        );
    },
    async publishPlans(context, snapshotId, boundaryUnixMs, pages) {
      context.context.signal.throwIfAborted();
      if (
        !Number.isSafeInteger(boundaryUnixMs) ||
        boundaryUnixMs < 0 ||
        !Number.isSafeInteger(pages) ||
        pages < 0 ||
        pages > DEFERRED_PLAN_MAX_PAGES
      )
        invalid();
      const base = prefix(context, input.resourceId, snapshotId);
      const existing = await loadIndex(context, snapshotId, boundaryUnixMs);
      if (existing) {
        if (existing.pages.length !== pages) invalid();
        return;
      }
      // The saved cursor counts `pages`; each ordinal's newest attempt is the one it confirmed.
      // Attempts beyond `pages` come from slices retried with other boundaries and are ignored.
      const newest = new Map<
        number,
        { key: string; fence: number; sha256: string; plans: number }
      >();
      for (const key of await listKeys(base, 'plan-pages/')) {
        const parsed = parseDeferredPageKey(key);
        if (parsed.ordinal >= pages) continue;
        const current = newest.get(parsed.ordinal);
        // One lease writes one page per ordinal.
        if (current?.fence === parsed.fence) invalid();
        if (!current || parsed.fence > current.fence)
          newest.set(parsed.ordinal, { key, ...parsed });
      }
      const summaries = new Map<string, { key: string; sha256: string }>();
      for (const key of await listKeys(base, 'plan-summaries/')) {
        const parsed = parseDeferredSummaryKey(key);
        if (parsed.ordinal >= pages) continue;
        const id = `${parsed.ordinal}:${parsed.fence}`;
        if (summaries.has(id)) invalid();
        summaries.set(id, { key, sha256: parsed.sha256 });
      }
      const references: DeferredPageReference[] = [];
      for (let ordinal = 0; ordinal < pages; ordinal++) {
        const page = newest.get(ordinal) ?? invalid();
        const summary = summaries.get(`${ordinal}:${page.fence}`) ?? invalid();
        references.push({
          key: page.key,
          sha256: page.sha256,
          plans: page.plans,
          summaryKey: summary.key,
          summarySha256: summary.sha256,
        });
      }
      const planCount = references.reduce((total, page) => total + page.plans, 0);
      if (planCount > DEFERRED_PLAN_MAX_PLANS) throwPlanLimit();
      const index = {
        version: 4,
        ...identity(context, snapshotId),
        boundaryUnixMs,
        planCount,
        pages: references,
      } satisfies DeferredSnapshotIndex;
      const indexJson = JSON.stringify(index);
      await writeEncryptedJson(
        bucket,
        `${base}index.json`,
        context.context.lease.tenantId,
        indexJson,
        encryptionRootKey,
        encryptionKeyVersion
      );
      const published = (await loadIndex(context, snapshotId, boundaryUnixMs)) ?? invalid();
      if (JSON.stringify(published) !== indexJson) invalid();
    },
    async readNext(context, snapshotId, cursorValue, signal) {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(context.boundaryUnixMs) || (context.boundaryUnixMs ?? -1) < 0)
        invalid();
      const index =
        (await loadIndex(context, snapshotId, context.boundaryUnixMs ?? -1)) ?? invalid();
      const cursor = parseDeferredCursor(cursorValue);
      if (cursor.planOrdinal === index.planCount && cursor.recordOrdinal === 0) return null;
      if (cursor.planOrdinal >= index.planCount) invalid();
      const plan = await planAt(context, snapshotId, index, cursor.planOrdinal);
      const base = prefix(context, input.resourceId, snapshotId);
      let materialized = await loadMaterializedIndex(
        context,
        base,
        cursor.planOrdinal,
        plan.sha256
      );
      if (!materialized) {
        const planBytes = new TextEncoder().encode(plan.plaintext);
        validateRecord(planBytes);
        if (planBytes.length !== plan.bytes || (await sha256(planBytes)) !== plan.sha256) invalid();
        const materializedBase = `${base}materialized-${String(cursor.planOrdinal).padStart(4, '0')}/`;
        const records: DeferredMaterializedIndex['records'][number][] = [];
        await input.assertSource(context);
        for await (const value of input.materializePlan(context, planBytes)) {
          signal.throwIfAborted();
          const bytes = new Uint8Array(value);
          validateRecord(bytes);
          if (records.length >= 64) invalid();
          const recordSha256 = await sha256(bytes);
          const key = `record-${String(records.length).padStart(2, '0')}-${recordSha256}.json`;
          const objectKey = `${materializedBase}${key}`;
          const plaintext = new TextDecoder().decode(bytes);
          const saved = await readEncryptedJson(
            bucket,
            objectKey,
            context.context.lease.tenantId,
            encryptionRootKey
          );
          if (saved === null)
            await writeEncryptedJson(
              bucket,
              objectKey,
              context.context.lease.tenantId,
              plaintext,
              encryptionRootKey,
              encryptionKeyVersion
            );
          else if (saved !== plaintext) invalid();
          records.push({ key, sha256: recordSha256, bytes: bytes.length });
        }
        await input.assertSource(context);
        if (!records.length) invalid();
        const nextIndex = {
          version: 1,
          planSha256: plan.sha256,
          records,
        } satisfies DeferredMaterializedIndex;
        const nextJson = JSON.stringify(nextIndex);
        const raced = await loadMaterializedIndex(context, base, cursor.planOrdinal, plan.sha256);
        if (raced && JSON.stringify(raced) !== nextJson) invalid();
        if (!raced)
          await writeEncryptedJson(
            bucket,
            `${materializedBase}index.json`,
            context.context.lease.tenantId,
            nextJson,
            encryptionRootKey,
            encryptionKeyVersion
          );
        materialized =
          (await loadMaterializedIndex(context, base, cursor.planOrdinal, plan.sha256)) ??
          invalid();
        if (JSON.stringify(materialized) !== nextJson) invalid();
      }
      if (cursor.recordOrdinal >= materialized.records.length) invalid();
      const record = materialized.records[cursor.recordOrdinal];
      const objectKey = `${base}materialized-${String(cursor.planOrdinal).padStart(4, '0')}/${record.key}`;
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
      const lastRecord = cursor.recordOrdinal + 1 === materialized.records.length;
      return {
        bytes,
        nextCursor: JSON.stringify({
          version: 2,
          planOrdinal: lastRecord ? cursor.planOrdinal + 1 : cursor.planOrdinal,
          recordOrdinal: lastRecord ? 0 : cursor.recordOrdinal + 1,
        } satisfies DeferredCursor),
      };
    },
    async readSummaries(context, snapshotId, boundaryUnixMs, visit) {
      if (!Number.isSafeInteger(boundaryUnixMs) || boundaryUnixMs < 0) invalid();
      const index = (await loadIndex(context, snapshotId, boundaryUnixMs)) ?? invalid();
      const base = prefix(context, input.resourceId, snapshotId);
      // Pages are visited as they arrive; the closure does not depend on their order.
      let next = 0;
      const worker = async () => {
        while (next < index.pages.length) {
          const ordinal = next++;
          context.context.signal.throwIfAborted();
          const reference = index.pages[ordinal];
          const saved =
            (await readEncryptedJson(
              bucket,
              `${base}${reference.summaryKey}`,
              context.context.lease.tenantId,
              encryptionRootKey
            )) ?? invalid();
          if ((await sha256(new TextEncoder().encode(saved))) !== reference.summarySha256)
            invalid();
          for (const summary of parseDeferredSummaryPage(saved, ordinal, reference.plans).summaries)
            if (summary !== null) visit(Object.freeze({ ...summary }));
        }
      };
      await Promise.all(Array.from({ length: SUMMARY_READ_CONCURRENCY }, worker));
    },
    async releasePage(context, snapshotId) {
      context.context.signal.throwIfAborted();
      cachedPage = null;
      cachedIndex = null;
      const base = prefix(context, input.resourceId, snapshotId);
      const page = await bucket.list({ prefix: base, limit: RELEASE_PAGE_OBJECTS });
      if (page.objects.length) await bucket.delete(page.objects.map(({ key }) => key));
      if (page.truncated && !page.objects.length) invalid();
      return !page.truncated;
    },
    async release(context, snapshotId) {
      while (!(await this.releasePage(context, snapshotId)))
        context.context.signal.throwIfAborted();
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
