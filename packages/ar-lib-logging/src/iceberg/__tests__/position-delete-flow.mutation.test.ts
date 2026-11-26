import { describe, expect, it, vi } from 'vitest';
import { commitSnapshotRowDelete } from '../position-delete.js';
import { IcebergCatalogConflictError, IcebergCommitUnknownError } from '../types.js';
import { record } from './fixtures.js';
import { deleteFixture } from './position-delete-harness.js';

async function ready() {
  const f = await deleteFixture();
  const mutation = await f.prepare(await f.intent());
  return { f, mutation };
}

describe('commitSnapshotRowDelete', () => {
  it('commits the update, checking the fence before and after', async () => {
    const { f, mutation } = await ready();
    const fence = vi.fn(async () => undefined);
    const table = await commitSnapshotRowDelete(f.catalog, mutation, fence);
    expect(String(table.metadata['current-snapshot-id'])).toBe(mutation.snapshotId);
    expect(f.catalog.commitCount).toBe(2);
    expect(fence).toHaveBeenCalledTimes(2);
  });

  it('returns a delete that is already in the table without committing it again', async () => {
    const { f, mutation } = await ready();
    await commitSnapshotRowDelete(f.catalog, mutation, async () => undefined);
    const commits = f.catalog.commitCount;
    const fence = vi.fn(async () => undefined);
    const table = await commitSnapshotRowDelete(f.catalog, mutation, fence);
    expect(String(table.metadata['current-snapshot-id'])).toBe(mutation.snapshotId);
    expect(f.catalog.commitCount).toBe(commits);
    expect(fence).toHaveBeenCalledTimes(1);
  });

  it('does not commit when the fence refuses', async () => {
    const { f, mutation } = await ready();
    const commits = f.catalog.commitCount;
    await expect(
      commitSnapshotRowDelete(f.catalog, mutation, async () => {
        throw new Error('stale fence');
      })
    ).rejects.toThrow('stale fence');
    expect(f.catalog.commitCount).toBe(commits);
    const lateFence = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fence lost'));
    await expect(commitSnapshotRowDelete(f.catalog, mutation, lateFence)).rejects.toThrow(
      'fence lost'
    );
  });

  it('refuses to commit over a table whose current snapshot is not the planned base', async () => {
    const { f, mutation } = await ready();
    await f.append('later', [record({ event_id: 'later' })]);
    const commits = f.catalog.commitCount;
    await expect(
      commitSnapshotRowDelete(f.catalog, mutation, async () => undefined)
    ).rejects.toThrow('Snapshot delete base changed');
    await expect(
      commitSnapshotRowDelete(f.catalog, mutation, async () => undefined)
    ).rejects.toBeInstanceOf(IcebergCatalogConflictError);
    expect(f.catalog.commitCount).toBe(commits);
  });

  it('confirms a commit whose outcome was unknown, and reports one that did not happen', async () => {
    const lost = await ready();
    lost.f.catalog.afterCommit = async () => {
      throw new IcebergCommitUnknownError('response lost');
    };
    const table = await commitSnapshotRowDelete(
      lost.f.catalog,
      lost.mutation,
      async () => undefined
    );
    expect(String(table.metadata['current-snapshot-id'])).toBe(lost.mutation.snapshotId);

    const never = await ready();
    never.f.catalog.beforeCommit = async () => {
      throw new IcebergCommitUnknownError('disconnected');
    };
    await expect(
      commitSnapshotRowDelete(never.f.catalog, never.mutation, async () => undefined)
    ).rejects.toThrow('disconnected');
  });

  it('passes on any other commit error', async () => {
    const { f, mutation } = await ready();
    f.catalog.beforeCommit = async () => {
      throw new Error('storage exploded');
    };
    await expect(
      commitSnapshotRowDelete(f.catalog, mutation, async () => undefined)
    ).rejects.toThrow('storage exploded');
  });

  it('refuses to report a delete the table does not show afterwards', async () => {
    const { f, mutation } = await ready();
    const base = f.catalog.metadata['current-snapshot-id'];
    f.catalog.afterCommit = async () => {
      f.catalog.metadata['current-snapshot-id'] = base;
    };
    const failure = await commitSnapshotRowDelete(f.catalog, mutation, async () => undefined).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(IcebergCommitUnknownError);
    expect((failure as Error).message).toBe('Snapshot delete outcome unavailable');
  });
});
