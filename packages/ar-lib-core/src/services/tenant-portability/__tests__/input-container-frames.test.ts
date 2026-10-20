import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import {
  decodeTenantBackupContainerV2,
  encodeTenantBackupContainerV2,
  TENANT_BACKUP_CONTAINER_V2_LIMITS,
  TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES,
} from '../backup-container-v2';
import { tenantBundleCipherParameters } from '../bundle-cipher-parameters';
import {
  createTenantBundleKeyEnvelope,
  deriveTenantBundleStreamKey,
  type TenantBundleKeyEnvelope,
} from '../bundle-key-envelope';
import type { TenantBundleManifest, TenantBundleManifestExpectation } from '../bundle-manifest';
import { readNextTenantBackupContainerRow } from '../container-dataset-reader';
import {
  openVerifiedTenantBackupInput,
  rememberTenantBackupInputReader,
  TenantBackupContainerFrameReader,
} from '../container-frame-reader';
import { runTenantBackupInputDecodeStep } from '../decode-input-step';
import {
  initialTenantBackupContainerVerificationProgress,
  parseTenantBackupContainerVerificationProgress,
  readTenantBackupContainerV2Manifest,
  verifyTenantBackupContainerV2Slice,
  type TenantBackupContainerVerificationBudget,
  type TenantBackupContainerVerificationProgress,
} from '../input-container-verification';
import { TenantBackupInputFrameStore, type TenantBackupInputFrame } from '../input-frame-index';
import type { TenantBackupStepContext } from '../operation-executor';
import { TenantBackupOperationStore, type TenantBackupLease } from '../operation-store';
import { PinnedTenantBackupInputObject } from '../pinned-input-object';
import { ResumableSha256 } from '../resumable-sha256';

const encoder = new TextEncoder();
const signal = new AbortController().signal;
let session: TenantBundleKeyEnvelope;
let bundleId: string;

function datasetDescriptor(id: string) {
  return {
    id,
    module: 'applications',
    kind: 'settings' as const,
    store: 'database' as const,
    schemaVersion: 1,
    disposition: 'include' as const,
  };
}

function manifestFor(ids: readonly string[]): TenantBundleManifest {
  return {
    formatVersion: 1,
    bundleId,
    source: { tenantId: 'tenant-a', issuer: 'https://issuer.example', productVersion: '0.4.2' },
    snapshotId: 'snapshot-a',
    boundaryUnixMs: 123,
    inventoryDigestSha256: 'ab'.repeat(32),
    selection: {
      settings: true,
      users: false,
      admin: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
      artifacts: false,
    },
    datasets: ids.map(datasetDescriptor),
  } as TenantBundleManifest;
}

function rows(prefix: string, count: number, width = 40): Uint8Array {
  return encoder.encode(
    Array.from(
      { length: count },
      (_, index) => `{"id":["text","${prefix}-${index}"],"pad":["text","${'x'.repeat(width)}"]}\n`
    ).join('')
  );
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function encode(data: Record<string, Uint8Array>) {
  const ids = Object.keys(data);
  const encoded = await encodeTenantBackupContainerV2({
    manifest: manifestFor(ids),
    datasets: (async function* () {
      for (const id of ids)
        yield {
          datasetId: id,
          chunks: (async function* () {
            if (data[id].length) yield data[id];
          })(),
        };
    })(),
    session,
  });
  return join(encoded.parts);
}

async function sha256(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
}

/**
 * Build a v2 container with arbitrary frame cut points, as older encoders produced (fixed 12 MiB
 * cuts inside rows) and to cover empty frames. `tamper` lets a test write an inconsistent manifest
 * that is still correctly encrypted.
 */
async function build(
  data: Record<string, Uint8Array>,
  cuts: readonly number[],
  tamper?: (manifest: Record<string, unknown>) => void
): Promise<Uint8Array> {
  const ids = Object.keys(data);
  const all = join(ids.map((id) => data[id]));
  let offset = 0;
  const datasets = [];
  for (const id of ids) {
    const bytes = data[id];
    let count = 0;
    for (const byte of bytes) if (byte === 10) count++;
    datasets.push({ id, rows: count, bytes: bytes.length, sha256: await sha256(bytes), offset });
    offset += bytes.length;
  }
  const manifest: Record<string, unknown> = {
    formatVersion: 2,
    backup: manifestFor(ids),
    datasets,
    totalRows: datasets.reduce((total, dataset) => total + dataset.rows, 0),
    totalBytes: all.length,
    dataSha256: await sha256(all),
  };
  tamper?.(manifest);
  const bounds = [0, ...cuts, all.length];
  const footer = {
    formatVersion: 2,
    datasets: datasets.length,
    dataFrames: bounds.length - 1,
    totalRows: manifest.totalRows,
    totalBytes: manifest.totalBytes,
    dataSha256: manifest.dataSha256,
    manifestSha256: await sha256(encoder.encode(JSON.stringify(manifest))),
  };
  const header = new Uint8Array(133);
  header.set(encoder.encode('AUTHRIM2'));
  header.set(session.envelope, 8);
  header.set(crypto.getRandomValues(new Uint8Array(32)), 101);
  const headerHash = new Uint8Array(await crypto.subtle.digest('SHA-256', header));
  const key = await deriveTenantBundleStreamKey(session.contentKey, header.subarray(101));
  const frames: Uint8Array[] = [header];
  const frame = async (sequence: number, type: 1 | 2, plain: Uint8Array) => {
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        tenantBundleCipherParameters(headerHash, sequence, type),
        key,
        Uint8Array.from(plain)
      )
    );
    const output = new Uint8Array(9 + encrypted.length);
    const view = new DataView(output.buffer);
    view.setUint32(0, output.length - 4);
    view.setUint32(4, sequence);
    output[8] = type;
    output.set(encrypted, 9);
    frames.push(output);
  };
  for (let index = 0; index + 1 < bounds.length; index++)
    await frame(index, 1, all.subarray(bounds[index], bounds[index + 1]));
  await frame(bounds.length - 1, 2, encoder.encode(JSON.stringify({ manifest, footer })));
  return join(frames);
}

function bucketFor(object: Uint8Array, requests: { offset: number; length: number }[] = []) {
  return {
    async get(
      _key: string,
      options: { range: { offset: number; length: number }; onlyIf: { etagMatches: string } }
    ) {
      requests.push(options.range);
      if (options.onlyIf.etagMatches !== 'etag-a') return null;
      return {
        version: 'version-a',
        etag: 'etag-a',
        size: object.length,
        body: new Blob([
          object.slice(options.range.offset, options.range.offset + options.range.length),
        ]).stream(),
      };
    },
  };
}

function pinned(object: Uint8Array, requests?: { offset: number; length: number }[]) {
  return new PinnedTenantBackupInputObject({
    bucket: bucketFor(object, requests),
    identity: { key: 'input-a', version: 'version-a', etag: 'etag-a', size: object.length },
    signal,
    assertAuthorized: async () => {},
  });
}

/** Drive the verifier to completion through JSON checkpoints, as the scheduler would. */
async function verifyAll(
  object: Uint8Array,
  budget: TenantBackupContainerVerificationBudget = { frames: 1, verifyBytes: 1 << 30 },
  key = session
) {
  const frames: TenantBackupInputFrame[] = [];
  const checkpoints: string[] = [];
  let progress: TenantBackupContainerVerificationProgress =
    initialTenantBackupContainerVerificationProgress();
  for (let slices = 1; ; slices++) {
    const slice = await verifyTenantBackupContainerV2Slice({
      object: pinned(object),
      session: key,
      progress,
      loadFrames: async (from: number, count: number) =>
        frames.slice(from, from + count).map((frame) => ({ ...frame })),
      saveFrames: async (saved) => {
        for (const frame of saved)
          if (!frames.some(({ sequence }) => sequence === frame.sequence)) frames.push(frame);
      },
      acceptManifest: () => {},
      budget,
      signal,
    });
    if (slice.done) return { ...slice, frames, slices, checkpoints };
    checkpoints.push(JSON.stringify(slice.progress));
    progress = parseTenantBackupContainerVerificationProgress(JSON.parse(checkpoints.at(-1)!));
  }
}

async function readerFor(object: Uint8Array, requests?: { offset: number; length: number }[]) {
  const verified = await verifyAll(object, TENANT_BACKUP_VERIFY_ALL);
  return TenantBackupContainerFrameReader.open({
    object: pinned(object, requests),
    session,
    frames: verified.frames,
    datasets: verified.manifest.datasets,
    totalBytes: verified.manifest.totalBytes,
  });
}

const TENANT_BACKUP_VERIFY_ALL = { frames: 100_000, verifyBytes: 1 << 30 };

async function expectSameRows(object: Uint8Array) {
  const decoded = await decodeTenantBackupContainerV2({ parts: [object], session });
  const reader = await readerFor(object);
  for (const [id, bytes] of decoded.datasets) {
    const source = reader.dataset(id);
    // Byte-wise toEqual on multi-MiB arrays is very slow under coverage; compare natively.
    expect(Buffer.from(await source.readAll()).equals(Buffer.from(bytes))).toBe(true);
    let expected: string | null = null;
    let actual: string | null = null;
    for (;;) {
      const want = readNextTenantBackupContainerRow(bytes, expected);
      const got = await source.readNextRow(actual);
      expect(got).toEqual(want);
      if (!want || !got) break;
      expected = want.nextCursor;
      actual = got.nextCursor;
    }
  }
}

beforeAll(async () => {
  session = await createTenantBundleKeyEnvelope('fixture passphrase for frame index');
  bundleId = Array.from(session.envelope.subarray(1, 17), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
});

describe('frame-by-frame verification', () => {
  it('accepts what the whole-container decoder accepts, across one-frame slices', async () => {
    const data = {
      'core.empty-first': new Uint8Array(),
      'core.a': rows('a', 50),
      'core.empty-middle': new Uint8Array(),
      'core.b': rows('b', 7, 3000),
      'core.empty-last': new Uint8Array(),
    };
    const all = join(Object.values(data));
    // Cuts inside rows, between datasets, and two empty frames.
    const object = await build(data, [17, 17, 900, all.length - 5000, all.length - 1, all.length]);
    const decoded = await decodeTenantBackupContainerV2({ parts: [object], session });
    const verified = await verifyAll(object);
    expect(verified.manifest).toEqual(decoded.manifest);
    expect(verified.footer).toEqual(decoded.footer);
    expect(verified.frames).toHaveLength(7);
    expect(verified.slices).toBeGreaterThan(7);
    const once = await verifyAll(object, TENANT_BACKUP_VERIFY_ALL);
    expect(once.slices).toBe(1);
    expect(once.frames).toEqual(verified.frames);
  });

  it('stores only sealed hash midstates in its checkpoints', async () => {
    const marker = encoder.encode('{"id":["text","SECRET-ROW-0123456789"]}\n');
    const data = { 'core.a': join([marker, rows('a', 30), marker]) };
    const object = await build(data, [20, 900, 1300]);
    const verified = await verifyAll(object);
    const markerHex = Array.from(marker.subarray(0, 24), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    const verifies = verified.checkpoints.filter((value) => value.includes('"verify"'));
    expect(verifies.length).toBeGreaterThan(1);
    for (const checkpoint of verified.checkpoints) {
      expect(checkpoint).not.toContain('SECRET-ROW');
      expect(checkpoint).not.toContain(markerHex.slice(0, 16));
    }
    for (const checkpoint of verifies) {
      const { data: whole, datasetSha256 } = JSON.parse(checkpoint);
      expect(() => ResumableSha256.restore(whole)).toThrow();
      expect(() => ResumableSha256.restore(datasetSha256)).toThrow();
    }
    // A sealed midstate is bound to its position: swapping the two fails closed.
    const moved = JSON.parse(verifies[1]);
    [moved.data, moved.datasetSha256] = [moved.datasetSha256, moved.data];
    await expect(
      verifyTenantBackupContainerV2Slice({
        object: pinned(object),
        session,
        progress: parseTenantBackupContainerVerificationProgress(moved),
        loadFrames: async (from: number, count: number) =>
          verified.frames.slice(from, from + count),
        saveFrames: async () => {},
        acceptManifest: () => {},
        signal,
      })
    ).rejects.toThrow('backup_checkpoint_seal_invalid');
  });

  it('shares one frame budget between indexing and verifying', async () => {
    const object = await build({ 'core.a': rows('a', 30) }, [300, 600]);
    const frames: TenantBackupInputFrame[] = [];
    const slice = async (progress: TenantBackupContainerVerificationProgress) =>
      verifyTenantBackupContainerV2Slice({
        object: pinned(object),
        session,
        progress,
        loadFrames: async (from: number, count: number) => frames.slice(from, from + count),
        saveFrames: async (saved) => {
          frames.push(...saved);
        },
        acceptManifest: () => {},
        budget: { frames: 2, verifyBytes: 1 << 30 },
        signal,
      });
    const first = await slice(initialTenantBackupContainerVerificationProgress());
    expect(first).toMatchObject({ done: false, progress: { stage: 'walk', sequence: 2 } });
    // One data prefix and the metadata prefix use both reads; no frame is decrypted yet.
    const second = await slice(
      (first as { progress: TenantBackupContainerVerificationProgress }).progress
    );
    expect(second).toMatchObject({ done: false, progress: { stage: 'verify', sequence: 0 } });
    const third = await slice(
      (second as { progress: TenantBackupContainerVerificationProgress }).progress
    );
    // The metadata frame and one data frame.
    expect(third).toMatchObject({ done: false, progress: { stage: 'verify', sequence: 1 } });
  });

  it(
    'accepts exactly the data-frame cap in the probe and in decode',
    { timeout: 180_000 },
    async () => {
      const data = { 'core.a': rows('a', 2) };
      const atCap = await build(
        data,
        Array.from({ length: TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES - 1 }, () => 0)
      );
      const verified = await verifyAll(atCap, TENANT_BACKUP_VERIFY_ALL);
      expect(verified.frames).toHaveLength(TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES);
      await expect(
        readTenantBackupContainerV2Manifest({
          object: pinned(atCap),
          session,
          frames: 100_000,
          maxFrames: 1_000_000,
          signal,
        })
      ).resolves.toMatchObject({ done: true });
      const overCap = await build(
        data,
        Array.from({ length: TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES }, () => 0)
      );
      await expect(
        decodeTenantBackupContainerV2({ parts: [overCap], session })
      ).resolves.toBeTruthy();
      await expect(verifyAll(overCap, TENANT_BACKUP_VERIFY_ALL)).rejects.toThrow(
        'invalid_tenant_backup_container_v2'
      );
      await expect(
        readTenantBackupContainerV2Manifest({
          object: pinned(overCap),
          session,
          frames: 100_000,
          maxFrames: 1_000_000,
          signal,
        })
      ).rejects.toThrow('invalid_tenant_backup_container_v2');
    }
  );

  it('rejects tampering, foreign keys, truncation and inconsistent manifests', async () => {
    const data = { 'core.a': rows('a', 20), 'core.b': rows('b', 20) };
    const object = await build(data, [500]);
    const failures: Uint8Array[] = [];
    for (const position of [5, 120, 140, 400, 700, object.length - 3]) {
      const changed = object.slice();
      changed[position] ^= 1;
      failures.push(changed);
    }
    failures.push(object.slice(0, object.length - 1));
    failures.push(join([object, new Uint8Array([0])]));
    failures.push(
      await build(data, [500], (manifest) => {
        (manifest.datasets as { rows: number }[])[0].rows += 1;
        (manifest.datasets as { rows: number }[])[1].rows -= 1;
      })
    );
    failures.push(
      await build(data, [500], (manifest) => {
        (manifest.datasets as { sha256: string }[])[1].sha256 = 'ab'.repeat(32);
      })
    );
    for (const value of failures) {
      await expect(decodeTenantBackupContainerV2({ parts: [value], session })).rejects.toThrow();
      await expect(verifyAll(value)).rejects.toThrow();
    }
    const other = await createTenantBundleKeyEnvelope('another fixture passphrase');
    await expect(verifyAll(object, undefined, other)).rejects.toThrow();
  });

  it('counts empty frames against the per-transition frame budget', async () => {
    const data = { 'core.a': rows('a', 3) };
    const object = await build(
      data,
      Array.from({ length: 40 }, () => 10)
    );
    const frames: TenantBackupInputFrame[] = [];
    let progress: TenantBackupContainerVerificationProgress =
      initialTenantBackupContainerVerificationProgress();
    const advances: number[] = [];
    for (;;) {
      const before = progress.stage === 'verify' ? progress.sequence : null;
      const slice = await verifyTenantBackupContainerV2Slice({
        object: pinned(object),
        session,
        progress,
        loadFrames: async (from: number, count: number) => frames.slice(from, from + count),
        saveFrames: async (saved) => {
          frames.push(...saved);
        },
        acceptManifest: () => {},
        budget: { frames: 8, verifyBytes: 1 << 30 },
        signal,
      });
      if (slice.done) break;
      if (before !== null && slice.progress.stage === 'verify')
        advances.push(slice.progress.sequence - before);
      progress = slice.progress;
    }
    expect(frames).toHaveLength(41);
    expect(advances.length).toBeGreaterThan(0);
    expect(Math.max(...advances)).toBeLessThanOrEqual(8);
  });

  it('rejects progress it would not have produced', () => {
    for (const value of [
      null,
      { stage: 'walk', sequence: 0, objectOffset: 10, plainOffset: 0 },
      { stage: 'walk', sequence: 0, objectOffset: 133, plainOffset: 0, extra: 1 },
      { stage: 'verify' },
    ])
      expect(() => parseTenantBackupContainerVerificationProgress(value)).toThrow();
  });
});

describe('frame reader', () => {
  it('keeps only the two most recently used readers per cache', () => {
    const cache = new Map<string, number>();
    rememberTenantBackupInputReader(cache, 'a', 1);
    rememberTenantBackupInputReader(cache, 'b', 2);
    rememberTenantBackupInputReader(cache, 'a', 1);
    rememberTenantBackupInputReader(cache, 'c', 3);
    expect([...cache.keys()]).toEqual(['a', 'c']);
  });

  it('returns the same rows and cursors as the in-memory reader for one-shot encoder frames', async () => {
    await expectSameRows(
      await encode({ 'core.a': rows('a', 20_000, 200), 'core.b': rows('b', 3) })
    );
  }, 180_000);

  it('assembles rows that legacy fixed cuts split across frames', async () => {
    const data = {
      'core.a': rows('a', 30),
      'core.empty': new Uint8Array(),
      'core.b': rows('b', 5),
    };
    const all = join(Object.values(data));
    await expectSameRows(await build(data, [10, 12, 300, 301, all.length - 2]));
  });

  it('refuses rows spread over more frames than any encoder produces', async () => {
    const row = encoder.encode(`{"id":["text","${'x'.repeat(200)}"]}\n`);
    const data = { 'core.a': row, 'core.b': rows('b', 2) };
    // Twelve frames hold the first row: readable. Thirteen: refused instead of read frame by frame.
    const four = await readerFor(
      await build(
        data,
        Array.from({ length: 11 }, (_, index) => (index + 1) * 18)
      )
    );
    expect((await four.dataset('core.a').readNextRow(null))?.rowJson).toBe(
      new TextDecoder().decode(row.subarray(0, -1))
    );
    const five = await readerFor(
      await build(
        data,
        Array.from({ length: 12 }, (_, index) => (index + 1) * 16)
      )
    );
    await expect(five.dataset('core.a').readNextRow(null)).rejects.toThrow(
      'backup_container_frame_reader_invalid'
    );
    // A whole-dataset read is bounded too.
    const scattered = await readerFor(
      await build(
        data,
        Array.from({ length: 70 }, (_, index) => index + 1)
      )
    );
    expect(scattered.dataset('core.a').canReadAll).toBe(false);
    expect(four.dataset('core.a').canReadAll).toBe(true);
    await expect(scattered.dataset('core.a').readAll()).rejects.toThrow(
      'backup_container_frame_reader_invalid'
    );
  });

  it('reads a row that sliced-export fixed cuts and a stopped transition split into five frames', async () => {
    // Scaled down 1:1024 (4 KiB cuts, a 15 KiB row) so it stays fast under CI coverage; the
    // frame layout is what a 15 MiB row gets from 4 MiB sliced-export frames.
    const big = encoder.encode(`{"id":["text","${'y'.repeat(15 * 1024)}"]}\n`);
    const data = { 'core.a': join([rows('a', 3), big, rows('a', 2)]), 'core.b': rows('b', 1) };
    const all = join(Object.values(data));
    const kibi = 1024;
    // Fixed 4 KiB cuts inside the big row, with one short frame where a transition stopped.
    const cuts = [4 * kibi, 6 * kibi, 10 * kibi, 14 * kibi, 18 * kibi].filter(
      (cut) => cut < all.length
    );
    const object = await build(data, cuts);
    const verified = await verifyAll(object, TENANT_BACKUP_VERIFY_ALL);
    const rowStart = data['core.a'].indexOf(big[0], rows('a', 3).length);
    const spanned = verified.frames.filter(
      (frame) =>
        frame.plainOffset < rowStart + big.length && frame.plainOffset + frame.plainBytes > rowStart
    );
    expect(spanned).toHaveLength(5);
    await expectSameRows(object);
  });

  it('fails like the in-memory reader on cursors that are not row starts', async () => {
    const data = { 'core.a': rows('a', 4) };
    const reader = await readerFor(await build(data, [30]));
    const source = reader.dataset('core.a');
    for (const offset of [1, 31, data['core.a'].length + 1]) {
      const cursor = JSON.stringify({ version: 2, offset });
      expect(() => readNextTenantBackupContainerRow(data['core.a'], cursor)).toThrow();
      await expect(source.readNextRow(cursor)).rejects.toThrow();
    }
    await expect(source.readNextRow('{"version":1,"offset":0}')).rejects.toThrow();
    expect(() => reader.dataset('core.missing')).toThrow();
  });

  it(
    'range-reads only the header and the frame a row needs on large inputs',
    { timeout: 180_000 },
    async () => {
      const object = await encode({ 'core.a': rows('a', 130_000, 100) });
      expect(object.length).toBeGreaterThan(16 * 1024 * 1024);
      const requests: { offset: number; length: number }[] = [];
      const reader = await readerFor(object, requests);
      const source = reader.dataset('core.a');
      const decoded = await decodeTenantBackupContainerV2({ parts: [object], session });
      const bytes = decoded.datasets.get('core.a')!;
      const middle = bytes.indexOf(10, Math.floor(bytes.length / 2)) + 1;
      const cursor = JSON.stringify({ version: 2, offset: middle });
      expect(await source.readNextRow(cursor)).toEqual(
        readNextTenantBackupContainerRow(bytes, cursor)
      );
      // The header, the frames holding the row (two when a 12 MiB cut splits it) and at most
      // the previous frame for the row-start check: never the whole object.
      expect(requests[0].length).toBe(133);
      expect(requests.length).toBeLessThanOrEqual(4);
      for (const request of requests.slice(1))
        expect(request.length).toBeLessThanOrEqual(
          TENANT_BACKUP_CONTAINER_V2_LIMITS.capacityPartBytes + 25
        );
    }
  );
});

describe('decode_input with a durable frame index', () => {
  let sql: DatabaseSync;
  let database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute' | 'batch'>;
  let now: number;

  beforeEach(() => {
    sql = new DatabaseSync(':memory:');
    sql.exec('PRAGMA foreign_keys=ON');
    for (const name of [
      '003_tenant_backup_operations',
      '004_tenant_backup_validation_index',
      '008_tenant_backup_retry_state',
      '037_tenant_backup_container_inputs',
      '045_tenant_backup_input_frames',
    ])
      sql.exec(
        readFileSync(
          new URL(`../../../../../../migrations/admin/d1/${name}.sql`, import.meta.url),
          'utf8'
        )
      );
    const run = (statement: string, params: unknown[]) => ({
      success: true,
      rowsAffected: Number(sql.prepare(statement).run(...(params as SQLInputValue[])).changes),
    });
    database = {
      async query<T>(statement: string, params: unknown[] = []) {
        return sql.prepare(statement).all(...(params as SQLInputValue[])) as T[];
      },
      async queryOne<T>(statement: string, params: unknown[] = []) {
        return (sql.prepare(statement).get(...(params as SQLInputValue[])) as T) ?? null;
      },
      async execute(statement: string, params: unknown[] = []) {
        return run(statement, params);
      },
      async batch(statements: { sql: string; params?: unknown[] }[]) {
        sql.exec('BEGIN');
        try {
          const results = statements.map((statement) => run(statement.sql, statement.params ?? []));
          sql.exec('COMMIT');
          return results;
        } catch (cause) {
          sql.exec('ROLLBACK');
          throw cause;
        }
      },
    };
    now = 100;
  });

  async function claim(): Promise<{ lease: TenantBackupLease; context: TenantBackupStepContext }> {
    const store = new TenantBackupOperationStore(database);
    await store.create({
      id: 'import-a',
      tenantId: 'tenant-a',
      kind: 'import',
      idempotencyKey: 'import-request',
      requestDigest: 'ab'.repeat(32),
      actorId: 'admin-a',
      now,
    });
    const claimed = (await store.claim('tenant-a', 'import-a', 'worker-a', ++now))!;
    const lease = {
      tenantId: 'tenant-a',
      operationId: 'import-a',
      owner: 'worker-a',
      fencingToken: claimed.fencing_token,
    };
    return {
      lease,
      context: {
        operation: { ...claimed, phase: 'decode_input', cursor_json: null },
        lease,
        signal,
      } as TenantBackupStepContext,
    };
  }

  it('verifies across checkpoints, then serves rows from the recorded index', async () => {
    const data = { 'core.a': rows('a', 60), 'core.b': rows('b', 9, 2000) };
    const object = await build(data, [700, 701, 5000]);
    const { lease, context } = await claim();
    const ids = Object.keys(data);
    const expected: TenantBundleManifestExpectation = {
      bundleId,
      source: manifestFor(ids).source,
      selection: manifestFor(ids).selection,
      datasets: ids.map(datasetDescriptor),
    };
    const identity = { key: 'input-a', version: 'version-a', etag: 'etag-a', size: object.length };
    let cursor: string | null = JSON.stringify({ version: 2, bundleId });
    let transitions = 0;
    for (;;) {
      transitions++;
      const result = await runTenantBackupInputDecodeStep(
        { ...context, operation: { ...context.operation, cursor_json: cursor } },
        {
          database,
          bucket: bucketFor(object),
          identity,
          session,
          expected,
          now: () => now,
          assertPinnedInput: async () => {},
          budget: { frames: 2, verifyBytes: 1 },
        }
      );
      cursor = result.cursor ?? null;
      if (result.phase === 'validate_input_modules') break;
      expect(result.phase).toBe('decode_input');
      // A retried slice rewrites the same frame rows without conflict.
      if (transitions === 1)
        await runTenantBackupInputDecodeStep(
          {
            ...context,
            operation: {
              ...context.operation,
              cursor_json: JSON.stringify({ version: 2, bundleId }),
            },
          },
          {
            database,
            bucket: bucketFor(object),
            identity,
            session,
            expected,
            now: () => now,
            assertPinnedInput: async () => {},
            budget: { frames: 2, verifyBytes: 1 },
          }
        );
    }
    expect(transitions).toBeGreaterThan(4);
    expect(sql.prepare('SELECT count(*) AS n FROM tenant_backup_input_frames').get()?.n).toBe(4);
    const reader = await openVerifiedTenantBackupInput({
      database,
      lease,
      now: () => now,
      bundleId,
      bucket: bucketFor(object),
      identity,
      session,
      signal,
      assertAuthorized: async () => {},
    });
    const source = reader.dataset('core.b');
    expect(source.rows).toBe(9);
    expect(await source.readAll()).toEqual(data['core.b']);
    // A receipt saved before the index existed: the reader rebuilds the index once.
    sql.prepare('DELETE FROM tenant_backup_input_frames').run();
    const rebuilt = await openVerifiedTenantBackupInput({
      database,
      lease,
      now: () => now,
      bundleId,
      bucket: bucketFor(object),
      identity,
      session,
      signal,
      assertAuthorized: async () => {},
    });
    expect(await rebuilt.dataset('core.a').readAll()).toEqual(data['core.a']);
    expect(sql.prepare('SELECT count(*) AS n FROM tenant_backup_input_frames').get()?.n).toBe(4);
    // A rebuild that stopped between write batches is completed on the next open.
    sql.prepare('DELETE FROM tenant_backup_input_frames WHERE sequence>=2').run();
    const completed = await openVerifiedTenantBackupInput({
      database,
      lease,
      now: () => now,
      bundleId,
      bucket: bucketFor(object),
      identity,
      session,
      signal,
      assertAuthorized: async () => {},
    });
    expect(await completed.dataset('core.b').readAll()).toEqual(data['core.b']);
    expect(sql.prepare('SELECT count(*) AS n FROM tenant_backup_input_frames').get()?.n).toBe(4);
    await expect(
      openVerifiedTenantBackupInput({
        database,
        lease,
        now: () => now,
        bundleId,
        bucket: bucketFor(object),
        identity: { ...identity, etag: 'etag-b' },
        session,
        signal,
        assertAuthorized: async () => {},
      })
    ).rejects.toThrow();
  });

  it('refuses frame rows that do not chain or that a stale lease writes', async () => {
    const { lease } = await claim();
    const store = new TenantBackupInputFrameStore(database, lease, () => now);
    await expect(
      store.save(bundleId, [
        { sequence: 0, objectOffset: 133, frameBytes: 125, plainOffset: 0, plainBytes: 100 },
        { sequence: 2, objectOffset: 258, frameBytes: 125, plainOffset: 100, plainBytes: 100 },
      ])
    ).rejects.toThrow('backup_input_frame_index_invalid');
    const first = {
      sequence: 0,
      objectOffset: 133,
      frameBytes: 125,
      plainOffset: 0,
      plainBytes: 100,
    };
    await store.save(bundleId, [first]);
    await expect(
      store.save(bundleId, [{ ...first, frameBytes: 126, plainBytes: 101 }])
    ).rejects.toThrow('backup_input_frame_index_invalid');
    const stale = new TenantBackupInputFrameStore(
      database,
      { ...lease, fencingToken: lease.fencingToken + 1 },
      () => now
    );
    await expect(
      stale.save(bundleId, [{ ...first, sequence: 1, objectOffset: 258, plainOffset: 100 }])
    ).rejects.toThrow('backup_input_frame_index_invalid');
    expect(await store.load(bundleId)).toEqual([first]);
  });
});
