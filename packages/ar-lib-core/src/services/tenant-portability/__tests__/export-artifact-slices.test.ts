import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupOperationStore, type TenantBackupOperation } from '../operation-store';
import {
  TenantBackupArtifactWriter,
  writeTenantBackupContainerArtifactV2,
} from '../artifact-writer';
import {
  createTenantBundleKeyEnvelope,
  type TenantBundleKeyEnvelope,
} from '../bundle-key-envelope';
import { saveTenantBackupExportManifest } from '../export-manifest-store';
import { runTenantBackupArtifactStep } from '../export-artifact-step';
import { cleanupCancelledTenantBackupArtifactPage } from '../cancelled-artifact-cleanup';
import { runTenantBackupArtifactVerificationStep } from '../verify-artifact-step';
import { readTenantBackupArtifact } from '../artifact-reader';
import { openTenantBackupDownload } from '../published-artifact-reader';
import {
  initialTenantBackupContainerVerificationProgress,
  verifyTenantBackupContainerV2Slice,
} from '../input-container-verification';
import type { TenantBackupInputFrame } from '../input-frame-index';
import {
  decodeTenantBackupContainerV2,
  encodeTenantBackupContainerV2,
  TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES,
} from '../backup-container-v2';
import type { TenantBundleManifest } from '../bundle-manifest';

const encoder = new TextEncoder();
let db: DatabaseSync;
let adapter: Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
let bucket: R2Bucket;
let operation: TenantBackupOperation;
let lease: { tenantId: string; operationId: string; owner: string; fencingToken: number };
let session: TenantBundleKeyEnvelope;
const objects = new Map<
  string,
  { body: Uint8Array; size: number; checksums: { sha256: ArrayBuffer } }
>();
const signal = new AbortController().signal;
/** One-shot R2 fault: fail before storing, or store and then lose the response. */
let putFault: 'before' | 'after' | null = null;
const now = () => 102;

function rows(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      JSON.stringify({
        id: ['text', `${prefix}-${index.toString().padStart(5, '0')}`],
        payload: ['text', 'x'.repeat(40 + ((index * 37) % 400))],
      }) + '\n'
  );
}
const sources: Record<string, string[]> = {
  users: rows('user', 900),
  empty: [],
  audit: rows('audit', 350),
};

function datasetDescriptor(id: string, disposition: 'include' | 'rebuild' = 'include') {
  return {
    id,
    module: 'users' as const,
    kind: 'users' as const,
    store: 'database' as const,
    schemaVersion: 1,
    disposition,
  };
}

function expectation() {
  return {
    bundleId: Array.from(session.envelope.subarray(1, 17), (b) =>
      b.toString(16).padStart(2, '0')
    ).join(''),
    source: { tenantId: 'tenant-a', issuer: 'https://fixture.example', productVersion: '0.4.2' },
    selection: {
      settings: false,
      users: true,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    },
    datasets: [
      datasetDescriptor('users'),
      datasetDescriptor('empty'),
      datasetDescriptor('rebuilt', 'rebuild'),
      datasetDescriptor('audit'),
    ],
  };
}

function manifestFor(expected: ReturnType<typeof expectation>): TenantBundleManifest {
  return {
    formatVersion: 1,
    ...expected,
    snapshotId: 'snapshot',
    boundaryUnixMs: 100,
    inventoryDigestSha256: 'ab'.repeat(32),
  };
}

/** Batches of up to seven rows; the cursor is the next row index. */
async function readNext(datasetId: string, cursor: string | null) {
  const all = sources[datasetId];
  const start = cursor === null ? 0 : (JSON.parse(cursor) as { next: number }).next;
  if (!all || start >= all.length) return null;
  const end = Math.min(all.length, start + 7);
  return {
    bytes: encoder.encode(all.slice(start, end).join('')),
    nextCursor: JSON.stringify({ next: end }),
  };
}

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '008_tenant_backup_retry_state.sql',
    '009_tenant_backup_artifact_parts.sql',
    '012_tenant_backup_cipher_journal.sql',
    '036_tenant_backup_capacity_parts.sql',
    '021_tenant_backup_export_manifests.sql',
    '020_tenant_backup_publications.sql',
    '044_tenant_backup_export_dataset_progress.sql',
    '046_tenant_backup_operation_failure_reason.sql',
  ])
    db.exec(
      readFileSync(
        new URL('../../../../../../migrations/admin/d1/' + file, import.meta.url),
        'utf8'
      )
    );
  adapter = {
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
  };
  const operations = new TenantBackupOperationStore(adapter);
  await operations.create({
    id: 'operation',
    tenantId: 'tenant-a',
    kind: 'export',
    actorId: 'admin',
    idempotencyKey: 'request',
    requestDigest: 'ab'.repeat(32),
    now: 100,
  });
  operation = (await operations.claim('tenant-a', 'operation', 'writer', 101))!;
  lease = {
    tenantId: 'tenant-a',
    operationId: 'operation',
    owner: 'writer',
    fencingToken: operation.fencing_token,
  };
  objects.clear();
  bucket = {
    async put(key: string, value: Uint8Array) {
      const fault = putFault;
      putFault = null;
      if (fault === 'before') throw new Error('r2_unavailable');
      if (objects.has(key)) return null;
      const object = {
        body: new Uint8Array(value),
        size: value.length,
        checksums: { sha256: await crypto.subtle.digest('SHA-256', new Uint8Array(value)) },
      };
      objects.set(key, object);
      if (fault === 'after') throw new Error('r2_response_lost');
      return object;
    },
    async head(key: string) {
      return objects.get(key) ?? null;
    },
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        size: object.size,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(object.body));
            controller.close();
          },
        }),
      };
    },
  } as unknown as R2Bucket;
  session = await createTenantBundleKeyEnvelope('fixture sliced export password');
});
afterEach(() => db.close());

async function prepare(): Promise<{ attemptId: string; expected: ReturnType<typeof expectation> }> {
  const writer = await TenantBackupArtifactWriter.create(adapter, bucket, lease, now);
  const expected = expectation();
  await saveTenantBackupExportManifest({
    database: adapter,
    lease,
    attemptId: writer.attemptId,
    manifest: manifestFor(expected),
    expected,
    now,
  });
  return { attemptId: writer.attemptId, expected };
}

function exportStep(
  attemptId: string,
  expected: ReturnType<typeof expectation>,
  phase: string,
  cursor: string | null,
  options: {
    slice?: {
      frameBytes: number;
      readCalls: number;
      maxObjectBytes?: number;
      maxDataFrames?: number;
    };
    read?: typeof readNext;
  } = {}
) {
  return runTenantBackupArtifactStep(
    { operation: { ...operation, phase, cursor_json: cursor }, lease, signal },
    {
      database: adapter,
      bucket,
      attemptId,
      key: session,
      now,
      expected,
      readNext: (datasetId, sourceCursor) => (options.read ?? readNext)(datasetId, sourceCursor),
      async assertBoundary() {},
      ...(options.slice ? { slice: options.slice } : {}),
    }
  );
}

function verifyStep(
  attemptId: string,
  expected: ReturnType<typeof expectation>,
  cursor: string | null,
  stepBytes?: number
) {
  return runTenantBackupArtifactVerificationStep(
    { operation: { ...operation, phase: 'verify_artifact', cursor_json: cursor }, lease, signal },
    {
      database: adapter,
      bucket,
      attemptId,
      key: session,
      expected,
      now,
      ...(stepBytes ? { slice: { stepBytes } } : {}),
    }
  );
}

async function decodeSaved(attemptId: string) {
  const parts: Uint8Array[] = [];
  for await (const part of readTenantBackupArtifact({
    database: adapter,
    bucket,
    lease,
    attemptId,
    signal,
    now,
  }))
    parts.push(part);
  return { parts, decoded: await decodeTenantBackupContainerV2({ parts, session }) };
}

function expectDatasets(decoded: Awaited<ReturnType<typeof decodeSaved>>['decoded']): void {
  const text = (id: string) => new TextDecoder().decode(decoded.datasets.get(id));
  expect(text('users')).toBe(sources.users.join(''));
  expect(text('audit')).toBe(sources.audit.join(''));
  expect(text('empty')).toBe('');
  expect(text('rebuilt')).toBe('');
  expect(decoded.manifest.datasets.map(({ id, rows }) => [id, rows])).toEqual([
    ['users', 900],
    ['empty', 0],
    ['rebuilt', 0],
    ['audit', 350],
  ]);
}

it('exports and verifies across many slices into a container the v2 reader accepts', async () => {
  const { attemptId, expected } = await prepare();
  const slice = { frameBytes: 8 * 1024, readCalls: 5 };
  let phase = 'export_artifact';
  let cursor: string | null = JSON.stringify({ version: 2, attemptId });
  let exportSlices = 0;
  while (phase === 'export_artifact') {
    const result = await exportStep(attemptId, expected, phase, cursor, { slice });
    expect(result.disposition).toBe('continue');
    phase = result.phase;
    cursor = result.cursor;
    exportSlices++;
  }
  expect(phase).toBe('verify_artifact');
  expect(exportSlices).toBeGreaterThan(5);
  // Datasets that finished in earlier slices waited in D1 for the metadata frame.
  expect(
    db.prepare('SELECT dataset_id FROM tenant_backup_export_datasets ORDER BY ordinal').all()
  ).toEqual([{ dataset_id: 'users' }]);

  let verifySlices = 0;
  while (phase === 'verify_artifact') {
    const result = await verifyStep(attemptId, expected, cursor, 1);
    phase = result.phase;
    cursor = result.cursor;
    verifySlices++;
  }
  expect(phase).toBe('release_export_resources');
  const { parts, decoded } = await decodeSaved(attemptId);
  expect(verifySlices).toBe(parts.length);
  expect(JSON.parse(cursor!)).toEqual({
    version: 2,
    attemptId,
    nextPart: parts.length,
    verifiedBytes: parts.reduce((sum, part) => sum + part.length, 0),
  });
  expect(decoded.footer.dataFrames).toBe(parts.length);
  expectDatasets(decoded);
});

it('writes a small tenant as one part in one transition with the default budget', async () => {
  const { attemptId, expected } = await prepare();
  // Production batches hold up to 250 rows; a small tenant needs far fewer calls than the budget.
  const read: typeof readNext = async (datasetId, cursor) => {
    if (cursor !== null || !sources[datasetId]?.length) return null;
    return { bytes: encoder.encode(sources[datasetId].join('')), nextCursor: '"all"' };
  };
  const result = await exportStep(
    attemptId,
    expected,
    'export_artifact',
    JSON.stringify({ version: 2, attemptId }),
    { read }
  );
  expect(result.phase).toBe('verify_artifact');
  const { parts, decoded } = await decodeSaved(attemptId);
  expect(parts).toHaveLength(1);
  expectDatasets(decoded);
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_export_datasets').get()).toEqual({
    n: 0,
  });
  expect((await verifyStep(attemptId, expected, result.cursor)).phase).toBe(
    'release_export_resources'
  );
});

it('repeats a slice whose checkpoint was lost with identical parts and finishes once sealed', async () => {
  const { attemptId, expected } = await prepare();
  const slice = { frameBytes: 16 * 1024, readCalls: 4 };
  const cursors: Array<string | null> = [JSON.stringify({ version: 2, attemptId })];
  let phase = 'export_artifact';
  while (phase === 'export_artifact') {
    const previous = cursors[cursors.length - 1];
    const result = await exportStep(attemptId, expected, phase, previous, { slice });
    const objectCount = objects.size;
    // The executor lost this checkpoint: the same slice runs again from the previous cursor.
    // The position repeats exactly; the sealed part differs only by its random IV.
    if (result.phase === 'export_artifact') {
      const again = await exportStep(attemptId, expected, phase, previous, { slice });
      const position = (cursor: string | null) => {
        const { sealed, ...rest } = JSON.parse(cursor!) as Record<string, unknown>;
        expect(sealed).toMatch(/^[a-f0-9]+$/);
        return rest;
      };
      expect(again.phase).toBe(result.phase);
      expect(position(again.cursor)).toEqual(position(result.cursor));
    }
    expect(objects.size).toBe(objectCount);
    phase = result.phase;
    cursors.push(result.cursor);
  }
  // The final slice sealed the attempt; repeating it only moves on to verification.
  const lastExportCursor = cursors[cursors.length - 2];
  const objectCount = objects.size;
  expect(
    await exportStep(attemptId, expected, 'export_artifact', lastExportCursor, { slice })
  ).toEqual({
    phase: 'verify_artifact',
    cursor: JSON.stringify({ version: 2, attemptId }),
    disposition: 'continue',
  });
  expect(objects.size).toBe(objectCount);
  expectDatasets((await decodeSaved(attemptId)).decoded);
});

it('refuses different source bytes for a frame that was already written', async () => {
  const { attemptId, expected } = await prepare();
  const slice = { frameBytes: 16 * 1024, readCalls: 4 };
  const start = JSON.stringify({ version: 2, attemptId });
  await exportStep(attemptId, expected, 'export_artifact', start, { slice });
  const objectCount = objects.size;
  const changed: typeof readNext = async (datasetId, cursor) => {
    const next = await readNext(datasetId, cursor);
    if (!next) return null;
    return { ...next, bytes: next.bytes.map((byte) => (byte === 120 ? 121 : byte)) };
  };
  // Same nonce, different plaintext: the second ciphertext must never reach storage.
  await expect(
    exportStep(attemptId, expected, 'export_artifact', start, { slice, read: changed })
  ).rejects.toThrow('backup_artifact_write_failed');
  expect(objects.size).toBe(objectCount);
});

it('rejects tampered export and verification cursors', async () => {
  const { attemptId, expected } = await prepare();
  const slice = { frameBytes: 16 * 1024, readCalls: 4 };
  const first = await exportStep(
    attemptId,
    expected,
    'export_artifact',
    JSON.stringify({ version: 2, attemptId }),
    {
      slice,
    }
  );
  const progress = JSON.parse(first.cursor!) as Record<string, unknown>;
  for (const changed of [
    { ...progress, offset: (progress.offset as number) + 1 },
    { ...progress, sequence: (progress.sequence as number) + 1 },
    { ...progress, dataset: 4 },
    { ...progress, attemptId: 'other' },
    { ...progress, extra: true },
  ])
    await expect(
      exportStep(attemptId, expected, 'export_artifact', JSON.stringify(changed), { slice })
    ).rejects.toThrow('backup_export_step_cursor');
  await expect(
    verifyStep(attemptId, expected, JSON.stringify({ version: 2, attemptId }))
  ).rejects.toThrow('backup_verify_step_cursor');
});

it('verifies a container written by the one-shot v2 encoder', async () => {
  const { attemptId, expected } = await prepare();
  const writer = await TenantBackupArtifactWriter.resume(adapter, bucket, attemptId, lease, now);
  const container = await encodeTenantBackupContainerV2({
    manifest: manifestFor(expected),
    datasets: (async function* () {
      for (const descriptor of expected.datasets)
        yield {
          datasetId: descriptor.id,
          chunks: (async function* () {
            if (descriptor.disposition === 'include' && sources[descriptor.id].length)
              yield encoder.encode(sources[descriptor.id].join(''));
          })(),
        };
    })(),
    session,
    streamSalt: new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        encoder.encode(`authrim-backup-container-v2:${attemptId}`)
      )
    ),
  });
  await writeTenantBackupContainerArtifactV2(writer, container, signal);
  const result = await verifyStep(attemptId, expected, JSON.stringify({ version: 2, attemptId }));
  expect(result.phase).toBe('release_export_resources');
});

async function runExport(
  attemptId: string,
  expected: ReturnType<typeof expectation>,
  options: Parameters<typeof exportStep>[4]
): Promise<string[]> {
  const cursors: string[] = [];
  let phase = 'export_artifact';
  let cursor: string | null = JSON.stringify({ version: 2, attemptId });
  while (phase === 'export_artifact') {
    const result = await exportStep(attemptId, expected, phase, cursor, options);
    phase = result.phase;
    cursor = result.cursor;
    if (phase === 'export_artifact') cursors.push(cursor!);
  }
  return cursors;
}

async function runVerify(attemptId: string, expected: ReturnType<typeof expectation>) {
  const cursors: string[] = [];
  let phase = 'verify_artifact';
  let cursor: string | null = JSON.stringify({ version: 2, attemptId });
  while (phase === 'verify_artifact') {
    const result = await verifyStep(attemptId, expected, cursor, 1);
    phase = result.phase;
    cursor = result.cursor;
    if (phase === 'verify_artifact') cursors.push(cursor!);
  }
  expect(phase).toBe('release_export_resources');
  return cursors;
}

it('accepts positions without bytes and may stop on one', async () => {
  const { attemptId, expected } = await prepare();
  // Every real read is preceded by a position-only step, as when a source skips omitted rows.
  const read: typeof readNext = async (datasetId, cursor) => {
    if (cursor?.startsWith('skipped:')) return readNext(datasetId, cursor.slice(8) || null);
    const next = await readNext(datasetId, cursor);
    return next ? { bytes: new Uint8Array(0), nextCursor: `skipped:${cursor ?? ''}` } : null;
  };
  const cursors = await runExport(attemptId, expected, {
    // Three calls per transition: some transitions end right after a position-only step.
    slice: { frameBytes: 16 * 1024, readCalls: 3 },
    read,
  });
  expect(cursors.some((cursor) => JSON.parse(cursor).source?.startsWith('skipped:'))).toBe(true);
  await runVerify(attemptId, expected);
  expectDatasets((await decodeSaved(attemptId)).decoded);
});

it('cuts an oversize batch into fixed frames', async () => {
  const { attemptId, expected } = await prepare();
  // The whole users dataset arrives as one ~250 KB batch, far above a 16 KiB frame.
  const read: typeof readNext = async (datasetId, cursor) => {
    if (datasetId !== 'users') return readNext(datasetId, cursor);
    if (cursor !== null) return null;
    return { bytes: encoder.encode(sources.users.join('')), nextCursor: '"all"' };
  };
  await runExport(attemptId, expected, {
    slice: { frameBytes: 16 * 1024, readCalls: 2 },
    read,
  });
  await runVerify(attemptId, expected);
  const { parts, decoded } = await decodeSaved(attemptId);
  expect(parts.length).toBeGreaterThan(sources.users.join('').length / (16 * 1024));
  expect(Math.max(...parts.map((part) => part.length))).toBeLessThan(17 * 1024);
  expectDatasets(decoded);
});

it('keeps plaintext out of export and verification checkpoints', async () => {
  const marker = 'TOTP-SECRET-JBSWY3DPEHPK3PXP';
  const original = sources.audit;
  sources.audit = original.map((row) =>
    row.replace(/x+/, (run) => marker.repeat(1 + run.length / 30))
  );
  try {
    const { attemptId, expected } = await prepare();
    const exportCursors = await runExport(attemptId, expected, {
      slice: { frameBytes: 1000, readCalls: 1 },
    });
    const verifyCursors = await runVerify(attemptId, expected);
    expect(exportCursors.length).toBeGreaterThan(20);
    expect(verifyCursors.length).toBeGreaterThan(20);
    const stored = JSON.stringify([
      exportCursors,
      verifyCursors,
      db.prepare('SELECT * FROM tenant_backup_export_datasets').all(),
    ]);
    const hexOf = (text: string) =>
      Array.from(encoder.encode(text), (b) => b.toString(16).padStart(2, '0')).join('');
    for (const fragment of ['SECRET', 'JBSWY3', 'TOTP-'])
      for (const form of [fragment, hexOf(fragment)]) expect(stored).not.toContain(form);
    // A sealed checkpoint does not open at another position.
    const moved = { ...JSON.parse(exportCursors[3]), offset: JSON.parse(exportCursors[4]).offset };
    await expect(
      exportStep(attemptId, expected, 'export_artifact', JSON.stringify(moved))
    ).rejects.toThrow('backup_export_step_cursor');
  } finally {
    sources.audit = original;
  }
});

it('uses a salt of its own, so a one-shot attempt is never continued under the same key', async () => {
  const { attemptId, expected } = await prepare();
  await runExport(attemptId, expected, {});
  const [first] = (await decodeSaved(attemptId)).parts;
  const oneShot = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(`authrim-backup-container-v2:${attemptId}`)
    )
  );
  expect(Array.from(first.subarray(101, 133))).not.toEqual(Array.from(oneShot));
});

/** The same NDJSON as readNext, in batches of a different size. */
function batched(size: number, failAfter?: number): typeof readNext {
  let calls = 0;
  return async (datasetId, cursor) => {
    if (failAfter !== undefined && ++calls > failAfter) throw new Error('worker_lost');
    const all = sources[datasetId];
    const start = cursor === null ? 0 : (JSON.parse(cursor) as { next: number }).next;
    if (!all || start >= all.length) return null;
    const end = Math.min(all.length, start + size);
    return {
      bytes: encoder.encode(all.slice(start, end).join('')),
      nextCursor: JSON.stringify({ next: end }),
    };
  };
}

it('retries a slice with other read batches and cuts the frames it already wrote again', async () => {
  const { attemptId, expected } = await prepare();
  const slice = { frameBytes: 8 * 1024, readCalls: 12 };
  const start = JSON.stringify({ version: 2, attemptId });
  // The first slice writes parts, then the worker is lost before its checkpoint.
  await expect(
    exportStep(attemptId, expected, 'export_artifact', start, { slice, read: batched(7, 10) })
  ).rejects.toThrow();
  const written = objects.size;
  expect(written).toBeGreaterThanOrEqual(2);
  // A second slice ends on its budget with a shorter frame; its checkpoint is lost too.
  await exportStep(attemptId, expected, 'export_artifact', start, { slice, read: batched(11) });
  // The retries read in batches of 3 rows, so no batch ends where an earlier one did.
  let phase = 'export_artifact';
  let cursor: string | null = start;
  while (phase === 'export_artifact') {
    const result = await exportStep(attemptId, expected, phase, cursor, {
      slice,
      read: batched(3),
    });
    phase = result.phase;
    cursor = result.cursor;
  }
  expect(objects.size).toBeGreaterThan(written);
  await runVerify(attemptId, expected);
  expectDatasets((await decodeSaved(attemptId)).decoded);
});

it('stops on its read budget while bytes are buffered', async () => {
  const { attemptId, expected } = await prepare();
  // After each batch the source walks 30 omitted positions before the next rows.
  let calls = 0;
  const read: typeof readNext = async (datasetId, cursor) => {
    calls++;
    const match = cursor?.match(/^skip:(\d+):(.*)$/s);
    if (match && Number(match[1]) < 30)
      return { bytes: new Uint8Array(0), nextCursor: `skip:${Number(match[1]) + 1}:${match[2]}` };
    const next = await readNext(datasetId, match ? match[2] || null : cursor);
    return next ? { bytes: next.bytes, nextCursor: `skip:0:${next.nextCursor}` } : null;
  };
  // A 1 MiB frame never fills here, so every transition stops with bytes buffered.
  const perSlice: number[] = [];
  let phase = 'export_artifact';
  let cursor: string | null = JSON.stringify({ version: 2, attemptId });
  while (phase === 'export_artifact') {
    calls = 0;
    const result = await exportStep(attemptId, expected, phase, cursor, {
      slice: { frameBytes: 1024 * 1024, readCalls: 5 },
      read,
    });
    perSlice.push(calls);
    phase = result.phase;
    cursor = result.cursor;
  }
  expect(perSlice.length).toBeGreaterThan(20);
  expect(Math.max(...perSlice)).toBeLessThanOrEqual(5);
  await runVerify(attemptId, expected);
  const { parts, decoded } = await decodeSaved(attemptId);
  expect(parts.length).toBeGreaterThan(3);
  expectDatasets(decoded);
});

it('refuses to export or verify a container larger than import accepts', async () => {
  const { attemptId, expected } = await prepare();
  await expect(
    runExport(attemptId, expected, {
      slice: { frameBytes: 8 * 1024, readCalls: 20, maxObjectBytes: 50_000 },
    })
  ).rejects.toThrow('backup_export_too_large');

  const second = await prepare();
  await runExport(second.attemptId, second.expected, {});
  const total = (await decodeSaved(second.attemptId)).parts.reduce(
    (sum, part) => sum + part.length,
    0
  );
  await expect(
    runTenantBackupArtifactVerificationStep(
      {
        operation: {
          ...operation,
          phase: 'verify_artifact',
          cursor_json: JSON.stringify({ version: 2, attemptId: second.attemptId }),
        },
        lease,
        signal,
      },
      {
        database: adapter,
        bucket,
        attemptId: second.attemptId,
        key: session,
        expected: second.expected,
        now,
        slice: { stepBytes: 1, maxObjectBytes: total - 1 },
      }
    )
  ).rejects.toThrow('backup_artifact_too_large');
});

it('refuses to export or verify more data frames than import accepts', async () => {
  const { attemptId, expected } = await prepare();
  await expect(
    runExport(attemptId, expected, {
      slice: { frameBytes: 1000, readCalls: 1, maxDataFrames: 5 },
    })
  ).rejects.toThrow('backup_export_too_large');

  const second = await prepare();
  await runExport(second.attemptId, second.expected, {
    slice: { frameBytes: 1000, readCalls: 1 },
  });
  const { parts } = await decodeSaved(second.attemptId);
  expect(parts.length).toBeGreaterThan(5);
  await expect(
    runTenantBackupArtifactVerificationStep(
      {
        operation: {
          ...operation,
          phase: 'verify_artifact',
          cursor_json: JSON.stringify({ version: 2, attemptId: second.attemptId }),
        },
        lease,
        signal,
      },
      {
        database: adapter,
        bucket,
        attemptId: second.attemptId,
        key: session,
        expected: second.expected,
        now,
        slice: { stepBytes: 1, maxDataFrames: 5 },
      }
    )
  ).rejects.toThrow('backup_artifact_too_large');
});

it('fails an export over the frame cap for good and cleans up its attempt, parts and spills', async () => {
  const { attemptId, expected } = await prepare();
  // A slice is lost after reserving its third part; its retries then stop mid-frame and spill.
  let puts = 0;
  const original = bucket.put.bind(bucket);
  bucket.put = (async (...args: Parameters<R2Bucket['put']>) => {
    if (++puts === 3) putFault = 'before';
    return original(...args);
  }) as R2Bucket['put'];
  let cursor: string | null = JSON.stringify({ version: 2, attemptId });
  await expect(
    exportStep(attemptId, expected, 'export_artifact', cursor, {
      slice: { frameBytes: 8 * 1024, readCalls: 60 },
      read: batched(7),
    })
  ).rejects.toThrow('r2_unavailable');
  bucket.put = original;
  const slice = { frameBytes: 8 * 1024, readCalls: 3 };
  const spilledAfterAFrame = (value: string) => {
    const parsed = JSON.parse(value) as { spill: unknown; sequence?: number };
    return parsed.spill !== null && parsed.sequence! > 0;
  };
  while (!spilledAfterAFrame(cursor!))
    cursor = (
      await exportStep(attemptId, expected, 'export_artifact', cursor, { slice, read: batched(1) })
    ).cursor;
  // The next frame is one more than import accepts.
  await expect(
    exportStep(attemptId, expected, 'export_artifact', cursor, {
      slice: { ...slice, readCalls: 60, maxDataFrames: JSON.parse(cursor!).sequence },
      read: batched(1),
    })
  ).rejects.toThrow('backup_export_too_large');
  const count = (table: string, column = 'attempt_id') =>
    db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(attemptId)?.n;
  const stagedObjects = () =>
    [...objects.keys()].filter((key) => key.startsWith(`tenant-backup-staging/${attemptId}/`));
  expect(count('tenant_backup_artifact_attempts', 'id')).toBe(1);
  expect(count('tenant_backup_artifact_parts')).toBeGreaterThan(0);
  expect(count('tenant_backup_export_spills')).toBeGreaterThan(0);
  expect(stagedObjects().length).toBeGreaterThan(0);

  // What the scheduler does with a permanent failure code: no retry, straight to cleanup.
  const store = new TenantBackupOperationStore(adapter);
  const running = (await store.get('tenant-a', 'operation'))!;
  expect(
    await store.failPermanently(lease, running.revision, 'backup_export_too_large', 103)
  ).toMatchObject({
    state: 'cancelling',
    phase: 'cleanup',
    cursor_json: null,
    failure_reason: 'backup_export_too_large',
    failure_count: 0,
    last_error_code: null,
    lease_owner: null,
  });
  const cleaning = (await store.claimCancellation('tenant-a', 'operation', 'cleaner', 104))!;
  const context = {
    operation: cleaning,
    lease: {
      tenantId: 'tenant-a',
      operationId: 'operation',
      owner: 'cleaner',
      fencingToken: cleaning.fencing_token,
    },
    signal,
  };
  const cleanupBucket = {
    async head(key: string) {
      return objects.has(key) ? {} : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  let done = false;
  for (let page = 0; page < 10 && !done; page++)
    ({ done } = await cleanupCancelledTenantBackupArtifactPage({
      database: adapter,
      bucket: cleanupBucket,
      context,
      now: () => 105,
    }));
  expect(done).toBe(true);
  expect(count('tenant_backup_artifact_attempts', 'id')).toBe(0);
  expect(count('tenant_backup_artifact_parts')).toBe(0);
  expect(count('tenant_backup_export_spills')).toBe(0);
  expect(count('tenant_backup_export_datasets')).toBe(0);
  expect(count('tenant_backup_cipher_frames')).toBe(0);
  expect(stagedObjects()).toEqual([]);
  expect(await store.finishCancellation(context.lease, cleaning.revision, 106)).toMatchObject({
    state: 'failed',
    failure_reason: 'backup_export_too_large',
  });
});

it('imports an export cut into many short frames', async () => {
  const { attemptId, expected } = await prepare();
  // One read per transition: every transition stops with a short frame.
  await runExport(attemptId, expected, { slice: { frameBytes: 1000, readCalls: 1 } });
  const { parts, decoded } = await decodeSaved(attemptId);
  expect(decoded.footer.dataFrames).toBeGreaterThan(50);
  expect(decoded.footer.dataFrames).toBeLessThanOrEqual(TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES);
  const object = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    object.set(part, offset);
    offset += part.length;
  }
  const source = {
    size: object.length,
    read: async (from: number, length: number) => object.slice(from, from + length),
  } as never;
  const frames: TenantBackupInputFrame[] = [];
  let progress = initialTenantBackupContainerVerificationProgress();
  for (;;) {
    const slice = await verifyTenantBackupContainerV2Slice({
      object: source,
      session,
      progress,
      loadFrames: async (from, count) => frames.slice(from, from + count),
      saveFrames: async (saved) => {
        frames.push(...saved);
      },
      acceptManifest: () => {},
      signal,
    });
    if (slice.done) {
      expect(slice.manifest).toEqual(decoded.manifest);
      break;
    }
    progress = slice.progress;
  }
  expect(frames).toHaveLength(decoded.footer.dataFrames);
});

it('serves parts above 4 MiB through the public download', async () => {
  const { attemptId, expected } = await prepare();
  // 5 MiB of users rows: the first part holds the header and a full 4 MiB frame.
  const big = Array.from({ length: 12 }, () => sources.users.join('')).join('');
  const read: typeof readNext = async (datasetId, cursor) => {
    if (cursor !== null) return null;
    if (datasetId === 'users') return { bytes: encoder.encode(big + big), nextCursor: '"all"' };
    return readNext(datasetId, cursor);
  };
  await runExport(attemptId, expected, { read });
  await runVerify(attemptId, expected);
  const { parts } = await decodeSaved(attemptId);
  expect(parts[0].length).toBeGreaterThan(4 * 1024 * 1024);
  db.prepare(
    "UPDATE tenant_backup_operations SET state='ready',phase='export_complete',lease_owner=NULL,lease_expires_at=NULL WHERE id='operation'"
  ).run();
  db.prepare(
    'INSERT INTO tenant_backup_publications (operation_id,tenant_id,attempt_id,inventory_digest,published_at,expires_at) VALUES (?,?,?,?,?,?)'
  ).run('operation', 'tenant-a', attemptId, 'ab'.repeat(32), 150, 150 + 604800000);
  const download = await openTenantBackupDownload({
    database: adapter,
    bucket,
    tenantId: 'tenant-a',
    operationId: 'operation',
    now: () => 200,
    signal,
  });
  const received: Uint8Array[] = [];
  for await (const chunk of download.chunks) received.push(chunk);
  expect(received.map((part) => part.length)).toEqual(parts.map((part) => part.length));
  expect(download.byteCount).toBe(parts.reduce((sum, part) => sum + part.length, 0));
});

it.each([
  ['after its part was reserved', 'before' as const],
  ['after its part reached R2', 'after' as const],
  ['after its receipt', null],
])(
  'retries a slice lost %s within the read budget, even in one-row batches',
  async (_case, fault) => {
    const { attemptId, expected } = await prepare();
    const start = JSON.stringify({ version: 2, attemptId });
    // The lost slice wrote whole 8 KiB frames from 7-row batches; the last one fails as given.
    let frames = 0;
    const lost: typeof readNext = async (datasetId, cursor) => {
      if (objects.size >= 3 && fault === null) throw new Error('worker_lost');
      return batched(7)(datasetId, cursor);
    };
    putFault = null;
    const original = bucket.put.bind(bucket);
    bucket.put = (async (...args: Parameters<R2Bucket['put']>) => {
      if (++frames === 3 && fault) putFault = fault;
      return original(...args);
    }) as R2Bucket['put'];
    await expect(
      exportStep(attemptId, expected, 'export_artifact', start, {
        slice: { frameBytes: 8 * 1024, readCalls: 60 },
        read: lost,
      })
    ).rejects.toThrow();
    bucket.put = original;
    const reserved = db.prepare('SELECT count(*) AS n FROM tenant_backup_artifact_parts').get() as {
      n: number;
    };
    expect(reserved.n).toBeGreaterThanOrEqual(3);
    // Retries read one row per call with a budget of 3 calls: no transition may read more.
    let calls = 0;
    const counted: typeof readNext = async (datasetId, cursor) => {
      calls++;
      return batched(1)(datasetId, cursor);
    };
    const perSlice: number[] = [];
    let spilled = false;
    let phase = 'export_artifact';
    let cursor: string | null = start;
    while (phase === 'export_artifact') {
      calls = 0;
      const result = await exportStep(attemptId, expected, phase, cursor, {
        slice: { frameBytes: 8 * 1024, readCalls: 3 },
        read: counted,
      });
      perSlice.push(calls);
      if (result.phase === 'export_artifact' && JSON.parse(result.cursor!).spill) spilled = true;
      phase = result.phase;
      cursor = result.cursor;
    }
    expect(Math.max(...perSlice)).toBeLessThanOrEqual(3);
    expect(spilled).toBe(true);
    await runVerify(attemptId, expected);
    expectDatasets((await decodeSaved(attemptId)).decoded);
    // Spills are gone once their frames are written; none hold plaintext in the clear.
    expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_export_spills').get()).toEqual({
      n: 0,
    });
  }
);

it('keeps a spill until a saved checkpoint moves past it and reuses it when nothing new was read', async () => {
  const { attemptId, expected } = await prepare();
  const start = JSON.stringify({ version: 2, attemptId });
  const spills = () =>
    (
      db.prepare('SELECT count(DISTINCT spill_id) AS n FROM tenant_backup_export_spills').get() as {
        n: number;
      }
    ).n;
  // A slice is lost right after reserving its third part, before the upload.
  let puts = 0;
  const original = bucket.put.bind(bucket);
  bucket.put = (async (...args: Parameters<R2Bucket['put']>) => {
    if (++puts === 3) putFault = 'before';
    return original(...args);
  }) as R2Bucket['put'];
  await expect(
    exportStep(attemptId, expected, 'export_artifact', start, {
      slice: { frameBytes: 8 * 1024, readCalls: 60 },
      read: batched(7),
    })
  ).rejects.toThrow('r2_unavailable');
  bucket.put = original;

  // Positions after "idle:" cursors carry no rows for a while, like a run of omitted rows.
  let idle = 0;
  const read: typeof readNext = async (datasetId, cursor) => {
    if (cursor?.startsWith('idle:')) {
      if (idle > 0) {
        idle--;
        return {
          bytes: new Uint8Array(0),
          nextCursor: `idle:${idle}:${cursor.split(':').slice(2).join(':')}`,
        };
      }
      return batched(1)(datasetId, cursor.split(':').slice(2).join(':') || null);
    }
    const next = await batched(1)(datasetId, cursor);
    return next && { ...next, nextCursor: `idle:0:${next.nextCursor}` };
  };
  const slice = { frameBytes: 8 * 1024, readCalls: 3 };
  let cursor: string | null = start;
  while (!JSON.parse(cursor!).spill) {
    const result = await exportStep(attemptId, expected, 'export_artifact', cursor, {
      slice,
      read,
    });
    expect(result.phase).toBe('export_artifact');
    cursor = result.cursor;
  }
  const spilled = cursor!;
  const spill = JSON.parse(spilled).spill as { id: string };
  expect(spills()).toBe(1);

  // Ten slices that read only positions keep the same spill instead of storing it again.
  idle = 30;
  for (let i = 0; i < 10; i++) {
    const result = await exportStep(attemptId, expected, 'export_artifact', cursor, {
      slice,
      read,
    });
    cursor = result.cursor;
    expect(JSON.parse(cursor!).spill).toEqual(JSON.parse(spilled).spill);
  }
  expect(spills()).toBe(1);

  // A slice that finishes the spilled frame and then dies before its checkpoint is saved leaves
  // the saved checkpoint's spill in place, so the retry still resumes from it.
  const parts = objects.size;
  let calls = 0;
  await expect(
    exportStep(attemptId, expected, 'export_artifact', spilled, {
      slice: { frameBytes: 8 * 1024, readCalls: 200 },
      read: async (datasetId, value) => {
        if (++calls > 120) throw new Error('worker_lost');
        return read(datasetId, value);
      },
    })
  ).rejects.toThrow('worker_lost');
  expect(objects.size).toBeGreaterThan(parts);
  expect(
    db
      .prepare('SELECT count(*) AS n FROM tenant_backup_export_spills WHERE spill_id=?')
      .get(spill.id)
  ).not.toEqual({ n: 0 });

  let phase = 'export_artifact';
  cursor = spilled;
  while (phase === 'export_artifact') {
    const result = await exportStep(attemptId, expected, phase, cursor, { slice, read });
    phase = result.phase;
    cursor = result.cursor;
  }
  // Sealing collects every spill, including any left behind the last part.
  expect(spills()).toBe(0);
  await runVerify(attemptId, expected);
  expectDatasets((await decodeSaved(attemptId)).decoded);
});
