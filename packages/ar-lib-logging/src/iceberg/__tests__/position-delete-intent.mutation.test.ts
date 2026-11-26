import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSnapshotDeleteIntent,
  decodeSnapshotDeleteState,
  encodeSnapshotDeleteState,
} from '../position-delete.js';
import { LOG_ARCHIVE_PENDING_PIN_TTL_MS } from '../writer.js';
import type { SnapshotRowDelete, SnapshotRowDeletePage } from '../reader.js';
import { OPERATION_ID, deleteFixture, planDigest, sha256 } from './position-delete-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

const TTL = LOG_ARCHIVE_PENDING_PIN_TTL_MS;

function page(
  deletes: number,
  overrides: Partial<SnapshotRowDeletePage> = {}
): SnapshotRowDeletePage {
  return {
    tableUuid: 'table-1',
    snapshotId: '123',
    sequenceNumber: 4,
    complete: false,
    physicalFingerprint: 'f'.repeat(64),
    deletes: Array.from({ length: deletes }, (_, i) => ({
      filePath: `s3://b/t/data/f${i}.parquet`,
      pos: String(i),
      partitionSpecId: 0,
      partition: {},
      eventId: `e${i}`,
      payloadHmac: 'a'.repeat(64),
      expiresAt: 0,
    })),
    ...overrides,
  };
}

describe('createSnapshotDeleteIntent', () => {
  it('names the operation, the digest of the plan, a derived snapshot id and a one-day lease', async () => {
    const plan = page(2);
    const intent = await createSnapshotDeleteIntent(plan, OPERATION_ID, 5_000);
    expect(intent).toStrictEqual({
      version: 1,
      operationId: OPERATION_ID,
      planDigest: await planDigest(plan),
      snapshotId: BigInt(`0x${(await sha256(OPERATION_ID)).slice(0, 13)}`).toString(),
      createdAt: 5_000,
      pinExpiresAt: 5_000 + TTL,
      plan,
    });
    const other = await createSnapshotDeleteIntent(plan, 'b'.repeat(64), 5_000);
    expect(other.snapshotId).not.toBe(intent.snapshotId);
    expect(other.planDigest).toBe(intent.planDigest);
  });

  it('reads the clock when no time is given', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(123_456));
    const intent = await createSnapshotDeleteIntent(page(1), OPERATION_ID);
    expect(intent.createdAt).toBe(123_456);
    expect(intent.pinExpiresAt).toBe(123_456 + TTL);
  });

  it('refuses an operation id that is not 64 lowercase hex characters', async () => {
    for (const bad of [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      `g${'a'.repeat(63)}`,
      ` ${'a'.repeat(63)}`,
    ]) {
      await expect(createSnapshotDeleteIntent(page(1), bad, 5_000)).rejects.toThrow(
        'Invalid snapshot delete intent'
      );
    }
    for (const ok of ['0'.repeat(64), 'f'.repeat(64), '0123456789abcdef'.repeat(4)]) {
      await expect(createSnapshotDeleteIntent(page(1), ok, 5_000)).resolves.toBeDefined();
    }
  });

  it('refuses a time that is negative, not an integer or too late for the lease', async () => {
    for (const now of [
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER - TTL + 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      await expect(createSnapshotDeleteIntent(page(1), OPERATION_ID, now)).rejects.toThrow(
        'Invalid snapshot delete intent'
      );
    }
    for (const now of [0, Number.MAX_SAFE_INTEGER - TTL]) {
      await expect(createSnapshotDeleteIntent(page(1), OPERATION_ID, now)).resolves.toBeDefined();
    }
  });

  it('refuses a plan with no deletes, more than 128, or no snapshot', async () => {
    await expect(createSnapshotDeleteIntent(page(0), OPERATION_ID, 5_000)).rejects.toThrow(
      'Invalid snapshot delete intent'
    );
    await expect(createSnapshotDeleteIntent(page(129), OPERATION_ID, 5_000)).rejects.toThrow(
      'Invalid snapshot delete intent'
    );
    await expect(createSnapshotDeleteIntent(page(128), OPERATION_ID, 5_000)).resolves.toBeDefined();
    await expect(createSnapshotDeleteIntent(page(1), OPERATION_ID, 5_000)).resolves.toBeDefined();
    await expect(
      createSnapshotDeleteIntent(page(1, { snapshotId: null }), OPERATION_ID, 5_000)
    ).rejects.toThrow('Invalid snapshot delete intent');
    await expect(
      createSnapshotDeleteIntent(page(1, { snapshotId: '' }), OPERATION_ID, 5_000)
    ).rejects.toThrow('Invalid snapshot delete intent');
  });

  it('makes the digest depend on every part of the plan', async () => {
    const base = await createSnapshotDeleteIntent(page(2), OPERATION_ID, 1);
    const changes: Array<Partial<SnapshotRowDeletePage>> = [
      { tableUuid: 'table-2' },
      { snapshotId: '124' },
      { sequenceNumber: 5 },
      { physicalFingerprint: 'e'.repeat(64) },
    ];
    for (const change of changes) {
      const other = await createSnapshotDeleteIntent(page(2, change), OPERATION_ID, 1);
      expect(other.planDigest).not.toBe(base.planDigest);
    }
    const fewer = await createSnapshotDeleteIntent(page(1), OPERATION_ID, 1);
    expect(fewer.planDigest).not.toBe(base.planDigest);
  });
});

describe('snapshot delete state', () => {
  it('round-trips an intent and keeps it under 256 KiB', async () => {
    const intent = await createSnapshotDeleteIntent(page(3), OPERATION_ID, 7);
    const text = encodeSnapshotDeleteState(intent);
    expect(decodeSnapshotDeleteState(text)).toStrictEqual(intent);
  });

  it('refuses state over 256 KiB, in both directions, and accepts exactly that much', async () => {
    const intent = await createSnapshotDeleteIntent(page(1), OPERATION_ID, 7);
    const big = { ...intent, padding: 'x'.repeat(256 * 1024) };
    expect(() => encodeSnapshotDeleteState(big as never)).toThrow(
      'Snapshot delete state budget exceeded'
    );
    expect(() => decodeSnapshotDeleteState(' '.repeat(256 * 1024 + 1))).toThrow(
      'Snapshot delete state budget exceeded'
    );
    const text = encodeSnapshotDeleteState(intent);
    const padded = text.slice(0, -1) + ' '.repeat(256 * 1024 - text.length) + '}';
    expect(padded.length).toBe(256 * 1024);
    expect(() => decodeSnapshotDeleteState(padded)).not.toThrow();
    const exact = { ...intent, padding: '' };
    const room = 256 * 1024 - encodeSnapshotDeleteState(exact).length;
    exact.padding = 'x'.repeat(room);
    expect(encodeSnapshotDeleteState(exact as never)).toHaveLength(256 * 1024);
  });

  it('refuses state that is not a delete intent', async () => {
    const intent = await createSnapshotDeleteIntent(page(2), OPERATION_ID, 7);
    const bad: unknown[] = [
      null,
      0,
      'text',
      {},
      { ...intent, version: 2 },
      { ...intent, version: undefined },
      { ...intent, operationId: 5 },
      { ...intent, operationId: undefined },
      { ...intent, operationId: 'A'.repeat(64) },
      { ...intent, operationId: 'a'.repeat(63) },
      { ...intent, plan: undefined },
      { ...intent, plan: null },
      { ...intent, plan: 'x' },
      { ...intent, plan: {} },
      { ...intent, plan: { deletes: 'x' } },
      { ...intent, plan: { deletes: [] } },
      { ...intent, plan: { deletes: Array.from({ length: 129 }, () => ({})) } },
    ];
    for (const value of bad) {
      expect(() => decodeSnapshotDeleteState(JSON.stringify(value))).toThrow(
        'Invalid persisted snapshot delete state'
      );
    }
    const edge = {
      ...intent,
      plan: { ...intent.plan, deletes: Array.from({ length: 128 }, () => ({})) },
    };
    expect(() => decodeSnapshotDeleteState(JSON.stringify(edge))).not.toThrow();
    const one = { ...intent, plan: { ...intent.plan, deletes: [{}] } };
    expect(() => decodeSnapshotDeleteState(JSON.stringify(one))).not.toThrow();
  });

  it('keeps bigint positions through a round trip of a real plan', async () => {
    const f = await deleteFixture();
    const intent = await f.intent();
    const mutation = await f.prepare(intent);
    const back = decodeSnapshotDeleteState(encodeSnapshotDeleteState(mutation));
    expect(back).toMatchObject({ operationId: OPERATION_ID, snapshotId: intent.snapshotId });
    expect(back.plan.deletes.map((d: SnapshotRowDelete) => d.pos).sort()).toEqual(['0', '2']);
  });
});
