import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { loadLockFile, type AuthrimLock } from '../core/lock.js';
import {
  commitTopologyConfigTransaction,
  readEffectiveTopologyConfig,
  recoverTopologyConfigTransaction,
  topologyPendingConfigPath,
  type TopologyConfigTransactionPoint,
} from '../core/topology-config-transaction.js';

const directories: string[] = [];

async function environment() {
  const directory = await mkdtemp(join(tmpdir(), 'authrim-topology-transaction-'));
  directories.push(directory);
  const configPath = join(directory, 'config.json');
  const lockPath = join(directory, 'lock.json');
  const defaultConfig = createDefaultConfig('prod');
  const config = {
    ...defaultConfig,
    features: { ...defaultConfig.features, r2: { enabled: false } },
  };
  const lock: AuthrimLock = {
    version: '1.0.0',
    productVersion: '0.4.0',
    env: 'prod',
    createdAt: '2026-07-22T00:00:00.000Z',
    d1: {},
    kv: {},
  };
  await mkdir(directory, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return { configPath, lockPath, config, lock };
}

function updatedConfig(config: ReturnType<typeof createDefaultConfig>) {
  return {
    ...config,
    features: { ...config.features, r2: { enabled: true } },
    updatedAt: '2026-07-22T01:00:00.000Z',
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('topology config transaction', () => {
  it('can restart a new transaction when interrupted before the journal is visible', async () => {
    const state = await environment();
    const target = updatedConfig(state.config);

    await expect(
      commitTopologyConfigTransaction({
        ...state,
        kind: 'r2',
        targetProductVersion: '0.4.0',
        config: target,
        onPoint: (point) => {
          if (point === 'after_staged_config') throw new Error(point);
        },
      })
    ).rejects.toThrow('after_staged_config');

    expect((await loadLockFile(state.lockPath))?.topologyUpdate).toBeUndefined();
    expect(JSON.parse(await readFile(state.configPath, 'utf-8')).features.r2.enabled).toBe(false);
    expect(await readFile(topologyPendingConfigPath(state.configPath), 'utf-8')).toContain(
      '"enabled": true'
    );

    const completed = await commitTopologyConfigTransaction({
      ...state,
      kind: 'r2',
      targetProductVersion: '0.4.0',
      config: target,
    });
    expect(completed.lock.topologyUpdate?.phase).toBe('pending_deploy');
  });

  it.each(['after_preparing_lock', 'after_config_commit'] as TopologyConfigTransactionPoint[])(
    'recovers deterministically after interruption at %s',
    async (interruptionPoint) => {
      const state = await environment();
      const target = updatedConfig(state.config);
      await expect(
        commitTopologyConfigTransaction({
          ...state,
          kind: 'r2',
          targetProductVersion: '0.4.0',
          config: target,
          onPoint: (point) => {
            if (point === interruptionPoint) throw new Error(point);
          },
        })
      ).rejects.toThrow(interruptionPoint);

      const interruptedLock = (await loadLockFile(state.lockPath))!;
      expect(interruptedLock.topologyUpdate?.phase).toBe('config_staged');
      expect(
        (await readEffectiveTopologyConfig(interruptedLock, state.configPath)).features.r2
      ).toEqual({ enabled: true });

      const recovered = await recoverTopologyConfigTransaction({
        lock: interruptedLock,
        lockPath: state.lockPath,
        configPath: state.configPath,
        kind: 'r2',
        targetProductVersion: '0.4.0',
      });
      expect(recovered.lock.topologyUpdate?.phase).toBe('pending_deploy');
      expect(JSON.parse(await readFile(state.configPath, 'utf-8')).features.r2.enabled).toBe(true);
    }
  );

  it('leaves a fully resumable pending journal if the caller dies after the final lock write', async () => {
    const state = await environment();
    const target = updatedConfig(state.config);
    await expect(
      commitTopologyConfigTransaction({
        ...state,
        kind: 'r2',
        targetProductVersion: '0.4.0',
        config: target,
        onPoint: (point) => {
          if (point === 'after_pending_lock') throw new Error(point);
        },
      })
    ).rejects.toThrow('after_pending_lock');

    const lock = await loadLockFile(state.lockPath);
    expect(lock?.topologyUpdate?.phase).toBe('pending_deploy');
    expect(JSON.parse(await readFile(state.configPath, 'utf-8')).features.r2.enabled).toBe(true);
  });
});
