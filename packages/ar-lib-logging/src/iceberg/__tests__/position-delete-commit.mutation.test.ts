import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commitSnapshotRowDelete,
  reconcileSnapshotRowDelete,
  type SnapshotDeleteIntent,
  type SnapshotDeleteMutation,
} from '../position-delete.js';
import { LOG_ARCHIVE_PENDING_PIN_TTL_MS } from '../writer.js';
import { IcebergBatchCollisionError, IcebergCommitUnknownError } from '../types.js';
import { OPERATION_ID, deleteFixture } from './position-delete-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

type Fixture = Awaited<ReturnType<typeof deleteFixture>>;

const message = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (error: Error) => error.message
  );

async function mutationOf(f: Fixture): Promise<SnapshotDeleteMutation> {
  return f.prepare(await f.intent());
}

const noFence = async (): Promise<void> => undefined;

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

describe('reconcileSnapshotRowDelete: the intent must be well formed', () => {
  async function intentOf(f: Fixture): Promise<SnapshotDeleteIntent> {
    return f.intent();
  }

  it('refuses an intent with a field out of shape', async () => {
    const f = await deleteFixture();
    const base = await intentOf(f);
    const invalid = 'Invalid persisted snapshot delete intent';
    const bad: Array<(i: SnapshotDeleteIntent) => unknown> = [
      (i) => ({ ...i, version: 2 }),
      (i) => ({ ...i, operationId: 5 }),
      (i) => ({ ...i, operationId: 'A'.repeat(64) }),
      (i) => ({ ...i, operationId: 'a'.repeat(63) }),
      (i) => ({ ...i, planDigest: 5 }),
      (i) => ({ ...i, planDigest: 'z'.repeat(64) }),
      (i) => ({ ...i, planDigest: 'a'.repeat(65) }),
      (i) => ({ ...i, snapshotId: 'x1' }),
      (i) => ({ ...i, snapshotId: '' }),
      (i) => ({ ...i, createdAt: 1.5, pinExpiresAt: 1.5 + LOG_ARCHIVE_PENDING_PIN_TTL_MS }),
      (i) => ({ ...i, createdAt: -1, pinExpiresAt: -1 + LOG_ARCHIVE_PENDING_PIN_TTL_MS }),
      (i) => ({ ...i, pinExpiresAt: i.pinExpiresAt + 1 }),
      (i) => ({ ...i, pinExpiresAt: Number.NaN }),
      (i) => ({ ...i, plan: undefined }),
      (i) => ({ ...i, plan: { ...i.plan, snapshotId: null } }),
      (i) => ({ ...i, plan: { ...i.plan, snapshotId: 'x' } }),
      (i) => ({ ...i, plan: { ...i.plan, sequenceNumber: -1 } }),
      (i) => ({ ...i, plan: { ...i.plan, sequenceNumber: 1.5 } }),
      (i) => ({ ...i, plan: { ...i.plan, deletes: 'x' } }),
      (i) => ({ ...i, plan: { ...i.plan, deletes: [] } }),
      (i) => ({
        ...i,
        plan: { ...i.plan, deletes: Array.from({ length: 129 }, () => i.plan.deletes[0]) },
      }),
      (i) => ({ ...i, plan: { ...i.plan, physicalFingerprint: 'g'.repeat(64) } }),
      (i) => ({ ...i, plan: { ...i.plan, physicalFingerprint: 'a'.repeat(63) } }),
      () => null,
    ];
    for (const change of bad) {
      expect(await message(reconcileSnapshotRowDelete(f.catalog, change(base) as never))).toBe(
        invalid
      );
    }
  });

  it('refuses an intent whose snapshot id or plan digest does not follow from its parts', async () => {
    const f = await deleteFixture();
    const base = await intentOf(f);
    const differs = 'Snapshot delete intent digest differs';
    expect(
      await message(reconcileSnapshotRowDelete(f.catalog, { ...base, snapshotId: '12345' }))
    ).toBe(differs);
    expect(
      await message(reconcileSnapshotRowDelete(f.catalog, { ...base, planDigest: 'c'.repeat(64) }))
    ).toBe(differs);
    const tampered = structuredClone(base);
    const first = tampered.plan.deletes[0];
    if (first) first.pos = '999';
    expect(await message(reconcileSnapshotRowDelete(f.catalog, tampered))).toBe(differs);
    await expect(
      reconcileSnapshotRowDelete(f.catalog, { ...base, snapshotId: '12345' })
    ).rejects.toBeInstanceOf(IcebergBatchCollisionError);
  });

  it('accepts an intent with a sequence number of zero and exactly 128 deletes', async () => {
    const f = await deleteFixture();
    const zero = await f.intent((page) => ({ ...page, sequenceNumber: 0 }));
    await expect(reconcileSnapshotRowDelete(f.catalog, zero)).resolves.toBeNull();
    const many = await f.intent((page) => {
      const first = page.deletes[0];
      if (!first) throw new Error('expected a delete');
      return {
        ...page,
        deletes: Array.from({ length: 128 }, (_, i) => ({ ...first, pos: String(i) })),
      };
    });
    await expect(reconcileSnapshotRowDelete(f.catalog, many)).resolves.toBeNull();
    const old = await f.intent(undefined, OPERATION_ID, 0);
    await expect(reconcileSnapshotRowDelete(f.catalog, old)).rejects.toThrow(
      'Snapshot delete receipt expired'
    );
  });
});

describe('reconcileSnapshotRowDelete: where the delete stands in the table', () => {
  it('is null until the delete is in the history, then the table', async () => {
    const f = await deleteFixture();
    const intent = await f.intent();
    expect(await reconcileSnapshotRowDelete(f.catalog, intent)).toBeNull();
    const mutation = await f.prepare(intent);
    await f.catalog.commit(mutation.update);
    const table = await reconcileSnapshotRowDelete(f.catalog, intent);
    expect(String(table?.metadata['current-snapshot-id'])).toBe(intent.snapshotId);
  });

  it('refuses a table of another identity, or a changed physical schema', async () => {
    const f = await deleteFixture();
    const intent = await f.intent();
    f.catalog.metadata['table-uuid'] = 'another-table';
    expect(await message(reconcileSnapshotRowDelete(f.catalog, intent))).toBe(
      'Snapshot delete table changed'
    );
    const other = await deleteFixture();
    const changed = await other.intent((page) => ({
      ...page,
      physicalFingerprint: 'c'.repeat(64),
    }));
    expect(await message(reconcileSnapshotRowDelete(other.catalog, changed))).toBe(
      'Snapshot delete physical schema changed'
    );
  });

  it('reports an expired receipt only when the delete is not in the history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await deleteFixture();
    const intent = await f.intent();
    expect(await reconcileSnapshotRowDelete(f.catalog, intent)).toBeNull();
    vi.setSystemTime(intent.pinExpiresAt - 1);
    expect(await reconcileSnapshotRowDelete(f.catalog, intent)).toBeNull();
    vi.setSystemTime(intent.pinExpiresAt);
    const failure = await reconcileSnapshotRowDelete(f.catalog, intent).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(IcebergCommitUnknownError);
    expect((failure as Error).message).toBe('Snapshot delete receipt expired');
  });

  it('refuses a history entry with the id of the delete but another operation or plan', async () => {
    const f = await deleteFixture();
    const intent = await f.intent();
    const mutation = await f.prepare(intent);
    await f.catalog.commit(mutation.update);
    const entry = f.catalog.metadata.snapshots?.find(
      (s) => String(s['snapshot-id']) === intent.snapshotId
    );
    if (!entry) throw new Error('expected the delete snapshot');
    const summary = entry.summary as Record<string, string>;
    const identity = 'Snapshot delete identity collision';
    summary['authrim.position-delete-id'] = 'f'.repeat(64);
    expect(await message(reconcileSnapshotRowDelete(f.catalog, intent))).toBe(identity);
    summary['authrim.position-delete-id'] = OPERATION_ID;
    summary['authrim.position-delete-plan-digest'] = 'f'.repeat(64);
    expect(await message(reconcileSnapshotRowDelete(f.catalog, intent))).toBe(identity);
    await expect(reconcileSnapshotRowDelete(f.catalog, intent)).rejects.toBeInstanceOf(
      IcebergBatchCollisionError
    );
    summary['authrim.position-delete-plan-digest'] = intent.planDigest;
    await expect(reconcileSnapshotRowDelete(f.catalog, intent)).resolves.not.toBeNull();
  });

  it('refuses a history that loops', async () => {
    const f = await deleteFixture();
    const intent = await f.intent();
    const [only] = f.catalog.metadata.snapshots ?? [];
    if (!only) throw new Error('expected a snapshot');
    only['parent-snapshot-id'] = only['snapshot-id'];
    expect(await message(reconcileSnapshotRowDelete(f.catalog, intent))).toBe(
      'Invalid snapshot delete ancestry'
    );
  });

  it('stops at a snapshot the table no longer lists', async () => {
    const f = await deleteFixture();
    const intent = await f.intent();
    f.catalog.metadata.snapshots = [];
    expect(await reconcileSnapshotRowDelete(f.catalog, intent)).toBeNull();
    f.catalog.metadata['current-snapshot-id'] = undefined;
    expect(await reconcileSnapshotRowDelete(f.catalog, intent)).toBeNull();
  });
});

describe('commitSnapshotRowDelete: the staged update must be the one that was planned', () => {
  const update = 'Invalid snapshot delete update';

  async function tampered(change: (mutation: SnapshotDeleteMutation) => void) {
    const f = await deleteFixture();
    const mutation = structuredClone(await mutationOf(f));
    change(mutation);
    return message(commitSnapshotRowDelete(f.catalog, mutation, noFence));
  }

  const snapshotOf = (mutation: SnapshotDeleteMutation) => {
    const added = mutation.update.updates.find((u) => u.action === 'add-snapshot');
    if (added?.action !== 'add-snapshot') throw new Error('expected a snapshot update');
    return added.snapshot;
  };

  it('refuses an update with the wrong number of requirements or updates', async () => {
    expect(await tampered((m) => m.update.requirements.pop())).toBe(update);
    expect(
      await tampered((m) => m.update.requirements.push(m.update.requirements[0] as never))
    ).toBe(update);
    expect(await tampered((m) => m.update.updates.pop())).toBe(update);
    expect(await tampered((m) => m.update.updates.push(m.update.updates[0] as never))).toBe(update);
    expect(await tampered((m) => void delete (m as { update?: unknown }).update)).toBe(update);
  });

  it('refuses an update whose requirements do not guard the table, the base and the pin', async () => {
    const requirements = 'Snapshot delete requirements differ';
    const set = (match: (r: Record<string, unknown>) => boolean, patch: Record<string, unknown>) =>
      tampered((m) => {
        const found = m.update.requirements.find((r) => match(r as never));
        if (!found) throw new Error('expected a requirement');
        Object.assign(found, patch);
      });
    const uuid = (r: Record<string, unknown>) => r.type === 'assert-table-uuid';
    const main = (r: Record<string, unknown>) => r.ref === 'main';
    const pin = (r: Record<string, unknown>) => String(r.ref).startsWith('authrim-delete-');
    expect(await set(uuid, { uuid: 'other' })).toBe(requirements);
    expect(await set(uuid, { type: 'assert-create' })).toBe(requirements);
    expect(await set(main, { 'snapshot-id': 1 })).toBe(requirements);
    expect(await set(main, { ref: 'other' })).toBe(requirements);
    expect(await set(main, { type: 'assert-table-uuid', uuid: 'x' })).toBe(requirements);
    expect(await set(pin, { 'snapshot-id': 1 })).toBe(requirements);
    expect(await set(pin, { ref: 'authrim-delete-other' })).toBe(requirements);
  });

  it('refuses an update whose snapshot differs from the plan', async () => {
    const payload = 'Snapshot delete payload differs';
    const change = (patch: (snapshot: ReturnType<typeof snapshotOf>) => void) =>
      tampered((m) => patch(snapshotOf(m)));
    expect(await change((s) => void (s['snapshot-id'] = 1))).toBe(payload);
    expect(await change((s) => void (s['parent-snapshot-id'] = 1))).toBe(payload);
    expect(await change((s) => void (s['sequence-number'] += 1))).toBe(payload);
    expect(await change((s) => void (s['timestamp-ms'] += 1))).toBe(payload);
    const summary = (key: string, value: string) =>
      change((s) => void ((s.summary as Record<string, string>)[key] = value));
    expect(await summary('operation', 'append')).toBe(payload);
    expect(await summary('authrim.position-delete-id', 'x')).toBe(payload);
    expect(await summary('authrim.position-delete-plan-digest', 'x')).toBe(payload);
    expect(
      await tampered(
        (m) =>
          void (m.update.updates = m.update.updates
            .filter((u) => u.action !== 'add-snapshot')
            .concat(m.update.updates.filter((u) => u.action === 'set-snapshot-ref')[0] as never))
      )
    ).toBe('Snapshot delete payload missing');
  });

  it('refuses an update whose references are not the branch and the pin of this delete', async () => {
    const references = 'Snapshot delete references differ';
    const refs = (m: SnapshotDeleteMutation) =>
      m.update.updates.filter((u) => u.action === 'set-snapshot-ref') as Array<
        Record<string, unknown>
      >;
    const mainOf = (m: SnapshotDeleteMutation) => refs(m).find((u) => u['ref-name'] === 'main');
    const pinOf = (m: SnapshotDeleteMutation) =>
      refs(m).find((u) => String(u['ref-name']).startsWith('authrim-delete-'));
    expect(await tampered((m) => void (must(mainOf(m))['snapshot-id'] = '1'))).toBe(references);
    expect(await tampered((m) => void (must(pinOf(m))['snapshot-id'] = '1'))).toBe(references);
    expect(await tampered((m) => void (must(mainOf(m))['ref-name'] = 'other'))).toBe(references);
    expect(await tampered((m) => void (must(mainOf(m)).type = 'tag'))).toBe(references);
    expect(await tampered((m) => void (must(pinOf(m))['ref-name'] = 'authrim-delete-x'))).toBe(
      references
    );
    expect(await tampered((m) => void (must(pinOf(m)).type = 'branch'))).toBe(references);
    expect(await tampered((m) => void (must(pinOf(m))['max-ref-age-ms'] = 1))).toBe(references);
    expect(
      await tampered((m) => {
        m.update.updates = m.update.updates
          .filter((u) => u.action !== 'set-snapshot-ref')
          .concat([mainOf(m), mainOf(m)] as never);
      })
    ).toBe(references);
  });
});
