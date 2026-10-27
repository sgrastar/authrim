import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { verifyEnvironmentGenerationDigest } from '@authrim/ar-lib-core/services/deployment-replication/environment-authority';
import { canonicalRestoreJson, readPinnedRestoreFile } from '../import/restore-evidence';
import { parseReplicationConfiguration, parseReplicationPlan, type ReplicationPlan } from './plan';
import {
  parseEnvironmentReplicationConfiguration,
  parseEnvironmentReplicationPlan,
  type EnvironmentReplicationPlan,
} from './environment-plan';
import type { EnvironmentOperationProgress } from './environment-coordinator';
import type { ReplicationOperationProgress } from './coordinator';
import type { ReplicationJournalRecord } from './journal';
import { readReplicationAuthoritySchema } from './initialize';

const HASH = /^[a-f0-9]{64}$/u;
const MAX_JSON = 8 * 1024 * 1024;
const POLL_MS = 5_000;

export interface ReplicationWatchOptions {
  configPath: string;
  configSha256: string;
  stateDirectory: string;
  intervalSeconds: number;
  /** Installed sibling bundles, supplied by the scheduler entry, never by backup metadata. */
  executorPath: string;
  schedulerPath: string;
}
interface Cycle {
  id: string;
  planSha256: string | null;
  completeAtMs: number | null;
}
interface WatchState {
  formatVersion: 1;
  kind: 'replication-watch';
  configPath: string;
  configSha256: string;
  executorPath: string;
  executorSha256: string;
  schedulerPath: string;
  schedulerSha256: string;
  authoritySchemaSha256: string;
  intervalSeconds: number;
  nextCycleAtMs: number;
  cycle: Cycle | null;
}
export interface ReplicationWatchDependencies {
  /** The real runner executes only the installed pinned CLI. No inline shell or remote script. */
  execute?: (bundle: string, args: readonly string[]) => Promise<number>;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
function fail(code = 'replication_watch_state_invalid'): never {
  throw new Error(code);
}
function exact(value: unknown, keys: string[]): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    fail();
}
function absolute(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) fail('replication_watch_arguments_invalid');
}
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail();
}
async function read(path: string, maximum = MAX_JSON, privateFile = true): Promise<Uint8Array> {
  if ((await realpath(path)) !== path) fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maximum ||
      (privateFile && ((before.mode & 0o077n) !== 0n || Number(before.uid) !== process.getuid?.()))
    )
      fail();
    const bytes = new Uint8Array(await file.readFile());
    const after = await file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      fail();
    return bytes;
  } finally {
    await file.close();
  }
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function writeNew(path: string, bytes: string | Uint8Array): Promise<void> {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}
async function save(path: string, state: WatchState): Promise<void> {
  if (await exists(path)) await read(path);
  const temporary = join(dirname(path), `.watch-${randomUUID()}.tmp`);
  try {
    await writeNew(temporary, canonicalRestoreJson(state));
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
async function execute(bundle: string, args: readonly string[]): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}
async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((done) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      done();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Explicit persistent-host service. Stops on any uncertain step; never promotes or clears stale locks. */
export async function watchReplication(
  options: ReplicationWatchOptions,
  signal: AbortSignal,
  dependencies: ReplicationWatchDependencies = {}
): Promise<void> {
  options = { ...options };
  for (const path of [
    options.configPath,
    options.stateDirectory,
    options.executorPath,
    options.schedulerPath,
  ])
    absolute(path);
  if (
    !HASH.test(options.configSha256) ||
    !Number.isSafeInteger(options.intervalSeconds) ||
    options.intervalSeconds < 60 ||
    options.intervalSeconds > 30 * 86400
  )
    fail('replication_watch_arguments_invalid');
  const now = dependencies.now ?? Date.now;
  const clock = () => {
    const time = now();
    timestamp(time);
    return time;
  };
  const pinnedConfig = await readPinnedRestoreFile(
    options.configPath,
    options.configSha256,
    MAX_JSON
  );
  const rawConfig = JSON.parse(decode(pinnedConfig)) as unknown;
  const config =
    (rawConfig as { formatVersion?: unknown })?.formatVersion === 2
      ? parseEnvironmentReplicationConfiguration(rawConfig)
      : parseReplicationConfiguration(rawConfig);
  if (config.failover !== undefined) fail('replication_watch_configuration_invalid');
  const schemaPins = new Map<string, { path: string; sha256: string }>();
  for (const child of config.formatVersion === 2 ? config.tenants : [config]) {
    for (const files of Object.values(child.destination.schemas))
      for (const pin of files) {
        const existing = schemaPins.get(pin.path);
        if (existing && existing.sha256 !== pin.sha256) fail('replication_watch_pins_changed');
        schemaPins.set(pin.path, pin);
      }
  }
  const authoritySchemaSha256 = (await readReplicationAuthoritySchema()).digest;
  const executorSha256 = digest(await read(options.executorPath, 256 * 1024 * 1024, false));
  const schedulerSha256 = digest(await read(options.schedulerPath, 256 * 1024 * 1024, false));
  if ((await realpath(dirname(options.stateDirectory))) !== dirname(options.stateDirectory)) fail();
  await mkdir(options.stateDirectory, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const directory = await lstat(options.stateDirectory, { bigint: true });
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077n) !== 0n ||
    Number(directory.uid) !== process.getuid?.() ||
    (await realpath(options.stateDirectory)) !== options.stateDirectory
  )
    fail();
  const lockPath = join(options.stateDirectory, 'watch.lock');
  const lock = await open(
    lockPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  ).catch(() => fail('replication_watch_locked'));
  const lockIdentity = await lock.stat({ bigint: true });
  try {
    await lock.writeFile(
      canonicalRestoreJson({ id: randomUUID(), pid: process.pid, createdAtMs: clock() })
    );
    await lock.sync();
    await syncDirectory(options.stateDirectory);
    const statePath = join(options.stateDirectory, 'watch.json');
    const configSnapshot = join(options.stateDirectory, 'configuration.json');
    const expected = {
      configPath: options.configPath,
      configSha256: options.configSha256,
      executorPath: options.executorPath,
      executorSha256,
      schedulerPath: options.schedulerPath,
      schedulerSha256,
      authoritySchemaSha256,
      intervalSeconds: options.intervalSeconds,
    };
    let state: WatchState;
    if (await exists(statePath)) {
      state = JSON.parse(decode(await read(statePath))) as WatchState;
      exact(state, ['formatVersion', 'kind', ...Object.keys(expected), 'nextCycleAtMs', 'cycle']);
      if (
        state.formatVersion !== 1 ||
        state.kind !== 'replication-watch' ||
        Object.entries(expected).some(([key, value]) => state[key as keyof WatchState] !== value)
      )
        fail('replication_watch_pins_changed');
      timestamp(state.nextCycleAtMs);
      if (state.cycle !== null) {
        exact(state.cycle, ['id', 'planSha256', 'completeAtMs']);
        if (
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(state.cycle.id) ||
          (state.cycle.planSha256 !== null && !HASH.test(state.cycle.planSha256))
        )
          fail();
        if (state.cycle.completeAtMs !== null) {
          timestamp(state.cycle.completeAtMs);
          if (
            state.cycle.planSha256 === null ||
            state.nextCycleAtMs !== state.cycle.completeAtMs + options.intervalSeconds * 1000
          )
            fail();
        }
      }
    } else {
      if ((await readdir(options.stateDirectory)).some((name) => name !== 'watch.lock')) fail();
      state = {
        formatVersion: 1,
        kind: 'replication-watch',
        ...expected,
        nextCycleAtMs: 0,
        cycle: null,
      };
      await save(statePath, state);
    }
    if (!(await exists(configSnapshot))) await writeNew(configSnapshot, pinnedConfig);
    if (digest(await read(configSnapshot)) !== options.configSha256)
      fail('replication_watch_pins_changed');
    const assertPins = async () => {
      const currentDirectory = await lstat(options.stateDirectory, { bigint: true });
      const currentLock = await lstat(lockPath, { bigint: true });
      if (
        currentDirectory.dev !== directory.dev ||
        currentDirectory.ino !== directory.ino ||
        currentLock.dev !== lockIdentity.dev ||
        currentLock.ino !== lockIdentity.ino
      )
        fail();
      await readPinnedRestoreFile(options.configPath, options.configSha256, MAX_JSON);
      for (const pin of schemaPins.values())
        await readPinnedRestoreFile(pin.path, pin.sha256, 16 * 1024 * 1024);
      if ((await readReplicationAuthoritySchema()).digest !== authoritySchemaSha256)
        fail('replication_watch_pins_changed');
      if (
        digest(await read(options.executorPath, 256 * 1024 * 1024, false)) !== executorSha256 ||
        digest(await read(options.schedulerPath, 256 * 1024 * 1024, false)) !== schedulerSha256 ||
        digest(await read(configSnapshot)) !== options.configSha256
      )
        fail('replication_watch_pins_changed');
    };
    const run = async (args: string[]) => {
      await assertPins();
      if (signal.aborted) return false;
      if ((await (dependencies.execute ?? execute)(options.executorPath, args)) !== 0)
        fail('replication_watch_step_failed');
      await assertPins();
      return true;
    };
    while (!signal.aborted) {
      await assertPins();
      if (state.cycle === null || state.cycle.completeAtMs !== null) {
        const remaining = state.nextCycleAtMs - clock();
        if (remaining > 0) {
          await (dependencies.wait ?? wait)(Math.min(remaining, 60_000), signal);
          continue;
        }
        state = { ...state, cycle: { id: randomUUID(), planSha256: null, completeAtMs: null } };
        await save(statePath, state);
      }
      const cycle = state.cycle;
      if (!cycle) fail();
      const planPath = join(options.stateDirectory, `cycle-${cycle.id}.plan.json`);
      const observationPath = join(options.stateDirectory, `cycle-${cycle.id}.state.json`);
      if (!(await exists(planPath))) {
        if (cycle.planSha256 !== null || (await exists(observationPath))) fail();
        if (!(await run(['plan', '--config', configSnapshot, '--out', planPath]))) break;
      }
      const planBytes = await read(planPath);
      const plan: ReplicationPlan | EnvironmentReplicationPlan =
        config.formatVersion === 2
          ? parseEnvironmentReplicationPlan(decode(planBytes), executorSha256)
          : parseReplicationPlan(decode(planBytes), executorSha256);
      if (
        plan.authoritySchemaSha256 !== authoritySchemaSha256 ||
        canonicalRestoreJson(plan.configuration) !== canonicalRestoreJson(config)
      )
        fail();
      const planSha256 = digest(planBytes);
      if (cycle.planSha256 !== null && cycle.planSha256 !== planSha256)
        fail('replication_watch_pins_changed');
      if (cycle.planSha256 === null) {
        state = { ...state, cycle: { ...cycle, planSha256 } };
        await save(statePath, state);
      }
      const readObservation = async () => {
        const observed = JSON.parse(decode(await read(observationPath))) as {
          formatVersion: number;
          kind: string;
          mode: string;
          planPath: string;
          planSha256: string;
          journal: ReplicationJournalRecord<
            ReplicationOperationProgress | EnvironmentOperationProgress
          >;
        };
        const progress = observed.journal?.value;
        const expectedOperation = {
          operationId: `${plan.planId}:sync`,
          pairId: config.pair.pairId,
          ...(config.formatVersion === 2
            ? { environmentId: config.pair.environmentId }
            : { tenantId: config.pair.tenantId }),
          sourceDeploymentId: config.sourceDeploymentId,
          destinationDeploymentId: config.destinationDeploymentId,
          expectedEpoch: config.expectedEpoch,
          mode: 'sync',
        };
        if (
          observed.formatVersion !== config.formatVersion ||
          observed.kind !== 'operation' ||
          observed.mode !== 'sync' ||
          observed.planPath !== planPath ||
          observed.planSha256 !== planSha256 ||
          observed.journal?.planSha256 !== planSha256 ||
          observed.journal.operationId !== expectedOperation.operationId ||
          !progress ||
          progress.formatVersion !== config.formatVersion ||
          progress.writerAuthorityChanged !== false ||
          canonicalRestoreJson(progress.plan) !== canonicalRestoreJson(expectedOperation) ||
          !(
            config.formatVersion === 2
              ? ['pending', 'exporting', 'verified', 'complete']
              : ['pending', 'exporting', 'downloaded', 'restoring', 'verified', 'complete']
          ).includes(progress.phase)
        )
          fail();
        if (config.formatVersion === 2 && progress.formatVersion === 2) {
          if (!Array.isArray(progress.children)) fail();
          if (progress.phase === 'pending') {
            if (progress.children.length || progress.inventory || progress.generation) fail();
          } else {
            const restores = new Set<string>();
            if (
              progress.children.length !== config.tenants.length ||
              progress.children.some((child, index) => {
                if (
                  !child ||
                  child.tenantId !== config.tenants[index].pair.tenantId ||
                  !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(child.restoreId) ||
                  restores.has(child.restoreId) ||
                  !Number.isSafeInteger(child.attempt) ||
                  child.attempt < 1 ||
                  !['pending', 'exporting', 'downloaded', 'restoring', 'verified'].includes(
                    child.phase
                  )
                )
                  return true;
                restores.add(child.restoreId);
                return false;
              })
            )
              fail();
          }
          if (['verified', 'complete'].includes(progress.phase)) {
            const generation = progress.generation;
            if (!generation || progress.children.some((child) => child.phase !== 'verified'))
              fail();
            await verifyEnvironmentGenerationDigest(generation);
            if (
              generation.pairId !== config.pair.pairId ||
              generation.environmentId !== config.pair.environmentId ||
              generation.generationId !== progress.generationId ||
              generation.deploymentId !== config.destinationDeploymentId ||
              generation.sourceDeploymentId !== config.sourceDeploymentId ||
              generation.sourceEpoch !== config.expectedEpoch ||
              generation.epoch !== config.expectedEpoch + 1 ||
              generation.sourceFenceRevision !== 0 ||
              generation.sourceOperationId !== expectedOperation.operationId ||
              generation.sourcePlanSha256 !== planSha256 ||
              generation.children.length !== config.tenants.length ||
              generation.children.some(
                (child, index) =>
                  child.restoreId !== progress.children[index].restoreId ||
                  child.tenantId !== config.tenants[index].pair.tenantId ||
                  generation.inventory.tenants[index].issuer !==
                    config.tenants[index].source.identity.issuer
              )
            )
              fail();
          } else if (progress.generation) fail();
        }
        return progress;
      };
      const mode = (await exists(observationPath)) ? 'resume' : 'sync';
      if (mode === 'resume') await readObservation();
      if (
        !(await run([
          mode,
          '--plan',
          planPath,
          '--plan-sha256',
          planSha256,
          '--state',
          observationPath,
        ]))
      )
        break;
      const progress = await readObservation();
      if (progress.phase === 'complete') {
        // The CLI has just re-read the durable journal and applied its complete-proof validation.
        const completeAtMs = clock();
        state = {
          ...state,
          cycle: { id: cycle.id, planSha256, completeAtMs },
          nextCycleAtMs: completeAtMs + options.intervalSeconds * 1000,
        };
        timestamp(state.nextCycleAtMs);
        await save(statePath, state);
      } else if (!signal.aborted) await (dependencies.wait ?? wait)(POLL_MS, signal);
    }
  } finally {
    await lock.close();
    // A crash leaves the lock. Never infer process death, expire it, or remove another owner's lock.
    const current = await lstat(lockPath, { bigint: true }).catch(() => null);
    if (current?.dev === lockIdentity.dev && current.ino === lockIdentity.ino) {
      await unlink(lockPath);
      await syncDirectory(options.stateDirectory);
    }
  }
}
