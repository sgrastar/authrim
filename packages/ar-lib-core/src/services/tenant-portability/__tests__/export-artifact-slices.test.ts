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
import { runTenantBackupArtifactVerificationStep } from '../verify-artifact-step';
import { readTenantBackupArtifact } from '../artifact-reader';
import {
  decodeTenantBackupContainerV2,
  encodeTenantBackupContainerV2,
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
    '036_tenant_backup_capacity_parts.sql',
    '021_tenant_backup_export_manifests.sql',
    '044_tenant_backup_export_dataset_progress.sql',
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
      if (objects.has(key)) return null;
      const object = {
        body: new Uint8Array(value),
        size: value.length,
        checksums: { sha256: await crypto.subtle.digest('SHA-256', new Uint8Array(value)) },
      };
      objects.set(key, object);
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
  options: { slice?: { frameTargetBytes: number; readCalls: number }; read?: typeof readNext } = {}
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
  const slice = { frameTargetBytes: 8 * 1024, readCalls: 5 };
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
  const result = await exportStep(
    attemptId,
    expected,
    'export_artifact',
    JSON.stringify({ version: 2, attemptId })
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
  const slice = { frameTargetBytes: 16 * 1024, readCalls: 4 };
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
  const slice = { frameTargetBytes: 16 * 1024, readCalls: 4 };
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
  const slice = { frameTargetBytes: 16 * 1024, readCalls: 4 };
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
    // Every real batch closes a frame, so the buffer is empty when a position-only step lands.
    slice: { frameTargetBytes: 1, readCalls: 3 },
    read,
  });
  expect(cursors.some((cursor) => JSON.parse(cursor).source?.startsWith('skipped:'))).toBe(true);
  await runVerify(attemptId, expected);
  expectDatasets((await decodeSaved(attemptId)).decoded);
});

it('cuts a frame inside an oversize batch at the frame cap', async () => {
  const { attemptId, expected } = await prepare();
  // The whole users dataset arrives as one ~250 KB batch, far above a 16 KiB frame cap.
  const read: typeof readNext = async (datasetId, cursor) => {
    if (datasetId !== 'users') return readNext(datasetId, cursor);
    if (cursor !== null) return null;
    return { bytes: encoder.encode(sources.users.join('')), nextCursor: '"all"' };
  };
  await runExport(attemptId, expected, {
    slice: { frameTargetBytes: 4 * 1024, frameMaxBytes: 16 * 1024, readCalls: 2 },
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
      slice: { frameTargetBytes: 1000, readCalls: 1 },
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
