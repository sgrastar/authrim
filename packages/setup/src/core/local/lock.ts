/**
 * Exclusive lock per local environment.
 *
 * `up`, `init` and `reset` all change or depend on the same state (Miniflare files, generated
 * configs, a port), so only one of them may run for an environment at a time.
 *
 * The lock is a directory (`paths.lock`) with one entry file per process that holds or wants the
 * lock. Every entry has a unique name that carries everything needed to judge it (the owner's PID,
 * the operation, the start time and a random token), so:
 *
 * - an entry is complete from the moment it exists, and a half-written file can never be mistaken
 *   for a stale lock (the content is informational only);
 * - removing a stale entry removes exactly that file. It cannot touch a live owner's entry, so
 *   there is no take-over step to race on and no guard file that itself needs recovery;
 * - mutual exclusion comes from the order "create my entry, then list the directory": a process
 *   proceeds only if it sees no other live entry. Two simultaneous starters may both see each
 *   other and both back off, but they can never both proceed, because whichever lists last sees
 *   the other's entry. Backing off is followed by a short random wait and a retry.
 *
 * Only the owner removes its own entry, and entries of processes that no longer exist are removed
 * by whoever looks next. Whether an owner exists is decided by its PID alone. A PID reused by an
 * unrelated process after a crash keeps the entry alive, which only ever blocks (the safe
 * direction); the busy message then shows the recorded and the current start time of that PID so
 * the user can judge whether to delete the entry. Start times are never used to declare an entry
 * stale: a clock correction or a repeated DST hour changes them for a process that is alive, and
 * a wrong "stale" would let two sessions run at once.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalEnvironmentPaths } from './paths.js';

export type LocalOperation = 'init' | 'up' | 'reset';

export interface LocalLockOwner {
  pid: number;
  token: string;
  operation: LocalOperation;
  startedAt: string;
  /** Start time of the owning process in epoch seconds; 0 when it could not be determined. */
  processStart: number;
}

export interface LocalEnvironmentLock {
  owner: LocalLockOwner;
  release(): Promise<void>;
}

export class LocalEnvironmentBusyError extends Error {
  constructor(
    readonly env: string,
    readonly owner: LocalLockOwner,
    readonly entryPath?: string,
    /** Start time of the process that now has the entry's PID, epoch seconds (for the message). */
    readonly currentProcessStart?: number | null
  ) {
    super(
      `Local environment "${env}" is in use by \`local ${owner.operation}\` (pid ${owner.pid}, started ${owner.startedAt}). ` +
        'Stop it first, or wait for it to finish.' +
        (entryPath
          ? ` If that process is gone and this message stays (the PID may have been reused by another process), delete the stale entry: rm "${entryPath}"` +
            ` Process start time recorded in the entry: ${describeStart(owner.processStart)}; ` +
            `current process with that PID: ${describeStart(currentProcessStart ?? 0)}. ` +
            'Only compare them as a hint; clocks can change.'
          : '')
    );
    this.name = 'LocalEnvironmentBusyError';
  }
}

function describeStart(seconds: number): string {
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : 'unknown';
}

type LockPaths = Pick<LocalEnvironmentPaths, 'lock'>;
type LockEntry = LocalLockOwner & { file: string };

const ENTRY_NAME = /^(\d+)\.(\d+)\.(\d+)\.(init|up|reset)\.([0-9a-f-]{36})\.entry$/u;
/** How many times a starter backs off for another starter before reporting the environment busy. */
const ACQUIRE_ATTEMPTS = 6;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * When the process `pid` started, in epoch seconds, or null when that cannot be read (no `ps`,
 * the process is gone, an unexpected format). `ps -o lstart=` exists on macOS, Linux and WSL.
 */
export function getProcessStartSeconds(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, timeout: 3_000 },
      (error, stdout) => {
        if (error) return resolve(null);
        const parsed = Date.parse(stdout.trim());
        resolve(Number.isNaN(parsed) ? null : Math.floor(parsed / 1000));
      }
    );
  });
}

/** Whether an entry's owner still exists. Decided by the PID alone; see the file comment. */
export function isEntryOwnerAlive(entry: Pick<LocalLockOwner, 'pid'>): boolean {
  return isProcessAlive(entry.pid);
}

/** File name of an owner's entry. It carries the PID, so liveness never depends on the content. */
export function localLockEntryName(owner: LocalLockOwner): string {
  return `${new Date(owner.startedAt).getTime()}.${owner.pid}.${owner.processStart}.${owner.operation}.${owner.token}.entry`;
}

function parseEntryName(name: string): LockEntry | null {
  const match = ENTRY_NAME.exec(name);
  if (!match) return null;
  return {
    file: name,
    pid: Number(match[2]),
    processStart: Number(match[3]),
    token: match[5]!,
    operation: match[4] as LocalOperation,
    startedAt: new Date(Number(match[1])).toISOString(),
  };
}

/** Every entry in the lock directory, oldest first. Files that are not entries are ignored. */
async function listEntries(paths: LockPaths): Promise<LockEntry[]> {
  let names: string[];
  try {
    names = await readdir(paths.lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .map(parseEntryName)
    .filter((entry): entry is LockEntry => entry !== null)
    .sort(
      (a, b) =>
        a.startedAt.localeCompare(b.startedAt) || a.pid - b.pid || a.token.localeCompare(b.token)
    );
}

/** Entries whose process is alive; entries left by dead processes are removed on the way. */
async function listLiveEntries(paths: LockPaths): Promise<LockEntry[]> {
  const live: LockEntry[] = [];
  for (const entry of await listEntries(paths)) {
    if (isEntryOwnerAlive(entry)) live.push(entry);
    else await rm(join(paths.lock, entry.file), { force: true });
  }
  return live;
}

/** The live holder (or the earliest live contender) of the lock, if any. */
export async function findLocalLockOwner(paths: LockPaths): Promise<LocalLockOwner | null> {
  for (const entry of await listEntries(paths)) {
    if (isEntryOwnerAlive(entry)) return entry;
  }
  return null;
}

/** The earliest entry whether or not its process still exists (for diagnostics and tests). */
export async function readLocalLockOwner(paths: LockPaths): Promise<LocalLockOwner | null> {
  return (await listEntries(paths))[0] ?? null;
}

export async function acquireLocalEnvironmentLock(
  paths: LockPaths,
  env: string,
  operation: LocalOperation
): Promise<LocalEnvironmentLock> {
  await mkdir(paths.lock, { recursive: true });
  const owner: LocalLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    operation,
    startedAt: new Date().toISOString(),
    processStart: (await getProcessStartSeconds(process.pid)) ?? 0,
  };
  const entryPath = join(paths.lock, localLockEntryName(owner));
  const release = async (): Promise<void> => {
    await rm(entryPath, { force: true });
  };

  let blocker: LockEntry | undefined;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    // Create first, then look: anyone who looks after this point sees the entry.
    const handle = await open(entryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
    } finally {
      await handle.close();
    }
    const others = (await listLiveEntries(paths)).filter((entry) => entry.token !== owner.token);
    if (others.length === 0) return { owner, release };
    blocker = others[0];
    await release();
    if (attempt === ACQUIRE_ATTEMPTS - 1) break;
    // Back off for a random moment so two simultaneous starters do not keep colliding.
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 80 * (attempt + 1)));
  }
  throw new LocalEnvironmentBusyError(
    env,
    blocker!,
    join(paths.lock, blocker!.file),
    await getProcessStartSeconds(blocker!.pid)
  );
}

export async function withLocalEnvironmentLock<T>(
  paths: LockPaths,
  env: string,
  operation: LocalOperation,
  action: () => Promise<T>
): Promise<T> {
  const lock = await acquireLocalEnvironmentLock(paths, env, operation);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}
