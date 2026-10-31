import { describe, expect, it } from 'vitest';
import { encryptObjectArtifact } from '@authrim/ar-lib-core/services/object-artifact-crypto';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';
import { createDeferredEncryptedTenantBackupRecordSnapshotPort } from '../tenant-backup-record-snapshot-port';

const ROOT_KEY = '34'.repeat(32);

function bucket() {
  const values = new Map<string, string>();
  return {
    values,
    async put(key: string, value: string) {
      values.set(key, value);
      return {};
    },
    async get(key: string) {
      const value = values.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async list(input: { prefix: string; limit: number; cursor?: string }) {
      const keys = [...values.keys()].filter((key) => key.startsWith(input.prefix)).sort();
      const offset = input.cursor ? Number(input.cursor) : 0;
      const selected = keys.slice(offset, offset + input.limit);
      const next = offset + selected.length;
      return {
        objects: selected.map((key) => ({ key })),
        truncated: next < keys.length,
        cursor: next < keys.length ? String(next) : undefined,
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
  };
}

function context(fencingToken = 1): AdapterContext {
  return {
    boundaryUnixMs: 100,
    context: {
      lease: { tenantId: 'tenant-a', operationId: 'operation-a', fencingToken },
      signal: new AbortController().signal,
    },
  } as unknown as AdapterContext;
}

const plan = (index: number) => new TextEncoder().encode(`${JSON.stringify({ index })}\n`);

function port(staging: ReturnType<typeof bucket>) {
  return createDeferredEncryptedTenantBackupRecordSnapshotPort({
    env: {
      EXPORT_ARTIFACTS: staging as unknown as R2Bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
    },
    resourceId: 'r2-bodies:test',
    assertSource: async () => {},
    async *materializePlan(_context, bytes) {
      const { index } = JSON.parse(new TextDecoder().decode(bytes)) as { index: number };
      yield new TextEncoder().encode(`${JSON.stringify({ body: index })}\n`);
    },
    summarizePlan: (bytes) => ({
      kind: 'log',
      index: (JSON.parse(new TextDecoder().decode(bytes)) as { index: number }).index,
    }),
  });
}

async function stage(target: ReturnType<typeof port>, counts: number[]) {
  const input = context();
  let next = 0;
  for (const [ordinal, count] of counts.entries())
    await target.writePlanPage(
      input,
      'snapshot-a',
      ordinal,
      Array.from({ length: count }, () => plan(next++))
    );
  await target.publishPlans(input, 'snapshot-a', 100, counts.length);
  return next;
}

async function summaries(target: ReturnType<typeof port>): Promise<number[]> {
  const indexes: number[] = [];
  await target.readSummaries(context(), 'snapshot-a', 100, ({ index }) =>
    indexes.push(index as number)
  );
  // Pages are visited as they arrive.
  return indexes.sort((a, b) => a - b);
}

async function readAll(target: ReturnType<typeof port>): Promise<number[]> {
  const input = context();
  const bodies: number[] = [];
  let cursor: string | null = null;
  while (true) {
    const record = await target.readNext(input, 'snapshot-a', cursor, input.context.signal);
    if (!record) return bodies;
    bodies.push((JSON.parse(new TextDecoder().decode(record.bytes)) as { body: number }).body);
    cursor = record.nextCursor;
  }
}

describe('deferred R2 plan index in pages', () => {
  it('reads every plan of every page in order and collects their summaries', async () => {
    const staging = bucket();
    const target = port(staging);
    await target.start(context(), 'snapshot-a', async () => {}, 100);
    // start() lists nothing: plans are staged after the hold.
    expect(staging.values.size).toBe(0);
    const total = await stage(target, [256, 3, 256, 1]);
    expect(await readAll(target)).toEqual(Array.from({ length: total }, (_, index) => index));
    expect(await summaries(target)).toEqual(Array.from({ length: total }, (_, index) => index));
  });

  it('accepts more plans than the former 4,096 limit', async () => {
    const staging = bucket();
    const target = port(staging);
    const total = await stage(target, Array(20).fill(256));
    expect(total).toBe(5120);
    expect(await summaries(target)).toHaveLength(5120);
    const input = context();
    const last = await target.readNext(
      input,
      'snapshot-a',
      JSON.stringify({ version: 2, planOrdinal: 5119, recordOrdinal: 0 }),
      input.context.signal
    );
    expect(JSON.parse(new TextDecoder().decode(last?.bytes))).toEqual({ body: 5119 });
  });

  it('publishes the newest lease attempt of each ordinal and ignores attempts beyond the count', async () => {
    const staging = bucket();
    const target = port(staging);
    // Lease 1 wrote two pages and lost its cursor; lease 2 retried and ended its slice later.
    await target.writePlanPage(context(1), 'snapshot-a', 0, [plan(0)]);
    await target.writePlanPage(context(1), 'snapshot-a', 1, [plan(1)]);
    await target.writePlanPage(context(2), 'snapshot-a', 0, [plan(0), plan(1)]);
    await target.publishPlans(context(2), 'snapshot-a', 100, 1);
    expect(await readAll(target)).toEqual([0, 1]);
    expect(await summaries(target)).toEqual([0, 1]);
    // Publishing again with the saved count is idempotent.
    await target.publishPlans(context(3), 'snapshot-a', 100, 1);
    await expect(target.publishPlans(context(3), 'snapshot-a', 100, 2)).rejects.toThrow(
      'backup_record_snapshot_invalid'
    );
  });

  it('never lets an older lease remove or override a newer attempt', async () => {
    const staging = bucket();
    const target = port(staging);
    await target.writePlanPage(context(2), 'snapshot-a', 0, [plan(0), plan(1)]);
    // A stale worker of lease 1 resumes after lease 2 wrote its page.
    await target.writePlanPage(context(1), 'snapshot-a', 0, [plan(7)]);
    await target.publishPlans(context(2), 'snapshot-a', 100, 1);
    const staged = staging.values.size;
    // After publication nothing is written or removed.
    await target.writePlanPage(context(1), 'snapshot-a', 0, [plan(8)]);
    await target.writePlanPage(context(3), 'snapshot-a', 1, [plan(9)]);
    expect(staging.values.size).toBe(staged);
    expect(await readAll(port(staging))).toEqual([0, 1]);
  });

  it('stops as too large beyond the page limit', async () => {
    const target = port(bucket());
    await expect(target.writePlanPage(context(), 'snapshot-a', 16_384, [plan(0)])).rejects.toThrow(
      'backup_export_too_large'
    );
  });

  it('refuses to publish a missing page or two pages of one lease for one ordinal', async () => {
    const missing = port(bucket());
    await missing.writePlanPage(context(), 'snapshot-a', 1, [plan(1)]);
    await expect(missing.publishPlans(context(), 'snapshot-a', 100, 2)).rejects.toThrow(
      'backup_record_snapshot_invalid'
    );
    const conflicting = port(bucket());
    await conflicting.writePlanPage(context(), 'snapshot-a', 0, [plan(0)]);
    await conflicting.writePlanPage(context(), 'snapshot-a', 0, [plan(5)]);
    await expect(conflicting.publishPlans(context(), 'snapshot-a', 100, 1)).rejects.toThrow(
      'backup_record_snapshot_invalid'
    );
    // A page whose summary was never written cannot be published.
    const staging = bucket();
    const unsummarized = port(staging);
    await unsummarized.writePlanPage(context(), 'snapshot-a', 0, [plan(0)]);
    for (const key of [...staging.values.keys()])
      if (key.includes('/plan-summaries/')) staging.values.delete(key);
    await expect(unsummarized.publishPlans(context(), 'snapshot-a', 100, 1)).rejects.toThrow(
      'backup_record_snapshot_invalid'
    );
  });

  it('publishes an empty index when nothing was planned', async () => {
    const target = port(bucket());
    await target.publishPlans(context(), 'snapshot-a', 100, 0);
    expect(await readAll(target)).toEqual([]);
    expect(await summaries(target)).toEqual([]);
  });

  it('releases staged objects one page per call, including unpublished pages', async () => {
    const staging = bucket();
    const target = port(staging);
    const input = context();
    // 6 pages of plans and summaries, published, then partly materialized.
    await stage(target, Array(6).fill(200));
    await readAll(target);
    const staged = staging.values.size;
    expect(staged).toBeGreaterThan(1000);
    let calls = 0;
    while (!(await target.releasePage(input, 'snapshot-a'))) calls++;
    expect(calls).toBe(Math.ceil(staged / 1000) - 1);
    await target.assertReleased(input, 'snapshot-a');
    // Pages of an export cancelled before publication are found by prefix too.
    await target.writePlanPage(input, 'snapshot-a', 0, [plan(0)]);
    expect(await target.releasePage(input, 'snapshot-a')).toBe(true);
    await target.assertReleased(input, 'snapshot-a');
  });

  it('stops an export whose index was written in the hold by an older version', async () => {
    const staging = bucket();
    const target = port(staging);
    const objectKey =
      'tenant-backup-snapshots/tenant-a/operation-a/r2-bodies:test/snapshot-a/index.json';
    const envelope = await encryptObjectArtifact(
      JSON.stringify({
        version: 3,
        resourceId: 'r2-bodies:test',
        snapshotId: 'snapshot-a',
        tenantId: 'tenant-a',
        operationId: 'operation-a',
        boundaryUnixMs: 100,
        plans: [],
      }),
      {
        rootKeyHex: ROOT_KEY,
        plane: 'EXPORT_ARTIFACTS',
        keyVersion: 1,
        contentType: 'application/json',
        context: { tenantId: 'tenant-a', objectKey, objectClass: 'dr_bundle' },
      }
    );
    await staging.put(objectKey, JSON.stringify(envelope));
    const input = context();
    await expect(target.readNext(input, 'snapshot-a', null, input.context.signal)).rejects.toThrow(
      'backup_record_snapshot_format_unsupported'
    );
  });
});
