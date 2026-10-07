import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  acquireLocalEnvironmentLock,
  findLocalLockOwner,
  LocalEnvironmentBusyError,
  localLockEntryName,
  readLocalLockOwner,
  withLocalEnvironmentLock,
  getProcessStartSeconds,
  type LocalLockOwner,
} from '../core/local/lock.js';
import { getLocalEnvironmentPaths } from '../core/local/paths.js';

const DEAD_PID = 2147483646;

describe('environment lock', () => {
  const root = join(process.cwd(), `.test-local-env-lock-${Date.now()}`);
  const paths = getLocalEnvironmentPaths(root, 'local');
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => rmSync(paths.lock, { recursive: true, force: true }));

  const entries = (): string[] => (existsSync(paths.lock) ? readdirSync(paths.lock) : []);
  /** Plant an entry the way a process (possibly a dead one) would have left it. */
  const plantEntry = (
    pid: number,
    content = '',
    operation: LocalLockOwner['operation'] = 'up',
    processStart = 0
  ) => {
    mkdirSync(paths.lock, { recursive: true });
    const owner = {
      pid,
      token: randomUUID(),
      operation,
      startedAt: new Date().toISOString(),
      processStart,
    };
    const file = localLockEntryName(owner);
    writeFileSync(join(paths.lock, file), content);
    return file;
  };

  it('lets one operation hold the environment and names the holder to the next', async () => {
    const lock = await acquireLocalEnvironmentLock(paths, 'local', 'up');
    const second = acquireLocalEnvironmentLock(paths, 'local', 'reset');
    await expect(second).rejects.toBeInstanceOf(LocalEnvironmentBusyError);
    await expect(second).rejects.toThrow(/`local up` \(pid \d+/);
    // A refused attempt leaves nothing behind that could block the holder or the next starter.
    expect(entries()).toEqual([localLockEntryName(lock.owner)]);
    await lock.release();
    expect(entries()).toEqual([]);
    const third = await acquireLocalEnvironmentLock(paths, 'local', 'reset');
    await third.release();
  }, 20_000);

  it('removes the entry of a process that no longer exists and acquires', async () => {
    const stale = plantEntry(DEAD_PID);
    const lock = await acquireLocalEnvironmentLock(paths, 'local', 'init');
    expect(entries()).not.toContain(stale);
    expect(entries()).toEqual([localLockEntryName(lock.owner)]);
    await lock.release();
  });

  it('does not treat an entry that is still being written as stale', async () => {
    // An empty entry of a live process is a lock in the middle of being created: its content is
    // not what says whether it is alive, so it must neither be removed nor ignored.
    const inProgress = plantEntry(process.pid, '');
    await expect(acquireLocalEnvironmentLock(paths, 'local', 'up')).rejects.toBeInstanceOf(
      LocalEnvironmentBusyError
    );
    expect(entries()).toEqual([inProgress]);
    expect((await findLocalLockOwner(paths))?.pid).toBe(process.pid);
  }, 20_000);

  it('ignores files in the lock directory that are not entries', async () => {
    mkdirSync(paths.lock, { recursive: true });
    writeFileSync(join(paths.lock, 'garbage'), 'not json');
    writeFileSync(join(paths.lock, 'x.entry'), '');
    const lock = await acquireLocalEnvironmentLock(paths, 'local', 'up');
    expect(lock.owner.pid).toBe(process.pid);
    expect(entries()).toContain('garbage');
    await lock.release();
  });

  it('lets at most one of several simultaneous starters win, across many rounds', async () => {
    let wins = 0;
    for (let round = 0; round < 25; round += 1) {
      // Dead entries present at the same time exercise the stale clean-up under contention.
      plantEntry(DEAD_PID);
      plantEntry(DEAD_PID);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => acquireLocalEnvironmentLock(paths, 'local', 'up'))
      );
      const winners = results.filter((result) => result.status === 'fulfilled');
      expect(winners.length, `round ${round}`).toBeLessThanOrEqual(1);
      for (const loser of results.filter((result) => result.status === 'rejected')) {
        expect(loser.reason).toBeInstanceOf(LocalEnvironmentBusyError);
      }
      wins += winners.length;
      // Exactly the winner's entry remains (or nothing), never a stale one or a loser's.
      expect(entries()).toHaveLength(winners.length);
      for (const winner of winners) await winner.value.release();
      expect(entries()).toEqual([]);
    }
    // Backing off and retrying means a starter nearly always gets through.
    expect(wins).toBeGreaterThan(15);
  }, 120_000);

  it('releases only its own entry', async () => {
    const first = await acquireLocalEnvironmentLock(paths, 'local', 'up');
    const other = plantEntry(DEAD_PID, '', 'reset');
    await first.release();
    expect(entries()).toEqual([other]);
    expect((await readLocalLockOwner(paths))?.operation).toBe('reset');
    // Releasing twice is harmless.
    await first.release();
    expect(entries()).toEqual([other]);
  });

  it('runs the action under the lock and frees it even when the action throws', async () => {
    await expect(
      withLocalEnvironmentLock(paths, 'local', 'reset', async () => {
        expect((await findLocalLockOwner(paths))?.operation).toBe('reset');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(entries()).toEqual([]);
  });

  describe('a reused PID', () => {
    it('reads the start time of a running process', async () => {
      const start = await getProcessStartSeconds(process.pid);
      // Where `ps` is missing the lock falls back to the PID alone; elsewhere the answer is real.
      if (start === null) return;
      expect(Math.abs(Date.now() / 1000 - start)).toBeLessThan(60 * 60 * 24 * 365);
      expect(start).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
    });

    it('never declares an entry stale because of its start time', async () => {
      const start = await getProcessStartSeconds(process.pid);
      if (start === null) return;
      // The PID is alive but the recorded start time is an hour off, as after a clock correction
      // or a repeated DST hour. The owner may well be the same process, so the entry stays and
      // blocks: a wrong "stale" would let two sessions run at once.
      for (const recorded of [start - 3600, start + 3600, 1]) {
        const live = plantEntry(process.pid, '', 'up', recorded);
        expect((await findLocalLockOwner(paths))?.pid).toBe(process.pid);
        await expect(acquireLocalEnvironmentLock(paths, 'local', 'reset')).rejects.toBeInstanceOf(
          LocalEnvironmentBusyError
        );
        expect(entries()).toEqual([live]);
        rmSync(paths.lock, { recursive: true, force: true });
      }
    }, 60_000);

    it('keeps an entry whose recorded start time matches the process', async () => {
      const start = await getProcessStartSeconds(process.pid);
      if (start === null) return;
      const live = plantEntry(process.pid, '', 'up', start);
      await expect(acquireLocalEnvironmentLock(paths, 'local', 'reset')).rejects.toBeInstanceOf(
        LocalEnvironmentBusyError
      );
      expect(entries()).toEqual([live]);
    }, 20_000);

    it('keeps an entry with an unknown start time as alive, as a PID alone says', async () => {
      const live = plantEntry(process.pid, '', 'up', 0);
      expect((await findLocalLockOwner(paths))?.pid).toBe(process.pid);
      expect(entries()).toEqual([live]);
    });

    it('records the start time of the holder in its own entry', async () => {
      const lock = await acquireLocalEnvironmentLock(paths, 'local', 'up');
      const start = await getProcessStartSeconds(process.pid);
      expect(lock.owner.processStart).toBe(start ?? 0);
      await lock.release();
    });
  });

  it('tells the user which entry to delete when an environment stays busy', async () => {
    const live = plantEntry(process.pid, '', 'up', 0);
    const error = await acquireLocalEnvironmentLock(paths, 'local', 'init').catch((e) => e);
    expect(error).toBeInstanceOf(LocalEnvironmentBusyError);
    expect(error.message).toContain(join(paths.lock, live));
    expect(error.message).toMatch(/rm "/);
  }, 20_000);

  it('shows the recorded and the current start time as a hint for a manual delete', async () => {
    const start = await getProcessStartSeconds(process.pid);
    if (start === null) return;
    plantEntry(process.pid, '', 'up', start - 3600);
    const error = await acquireLocalEnvironmentLock(paths, 'local', 'init').catch((e) => e);
    expect(error).toBeInstanceOf(LocalEnvironmentBusyError);
    expect(error.message).toContain(new Date((start - 3600) * 1000).toISOString());
    expect(error.message).toContain(new Date(start * 1000).toISOString());
    expect(error.message).toMatch(/PID may have been reused/);
  }, 20_000);
});
