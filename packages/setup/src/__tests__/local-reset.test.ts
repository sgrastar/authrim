import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetLocalEnvironment } from '../core/local/init.js';
import { acquireLocalEnvironmentLock, LocalEnvironmentBusyError } from '../core/local/lock.js';
import {
  getLocalEnvironmentPaths,
  getLocalWorkerConfigPath,
  getLocalWorkerDevVarsPath,
} from '../core/local/paths.js';

describe('reset', () => {
  const root = join(process.cwd(), `.test-local-reset-${Date.now()}`);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A fake environment: state directory, and the generated files it leaves in two packages. */
  const populate = (env: string): string[] => {
    const paths = getLocalEnvironmentPaths(root, env);
    mkdirSync(join(paths.state, 'v3'), { recursive: true });
    const files = [paths.config];
    for (const component of ['ar-router', 'ar-auth'] as const) {
      mkdirSync(join(root, 'packages', component), { recursive: true });
      files.push(
        getLocalWorkerConfigPath(root, component, env),
        getLocalWorkerDevVarsPath(root, component, env)
      );
    }
    for (const file of files) writeFileSync(file, 'x');
    return files;
  };

  beforeEach(() => rmSync(root, { recursive: true, force: true }));

  it('removes its own environment and leaves other environments untouched', async () => {
    const mine = populate('local');
    const other = populate('dev1');
    await resetLocalEnvironment({ rootDir: root, env: 'local' });
    for (const file of mine) expect(existsSync(file), file).toBe(false);
    expect(existsSync(getLocalEnvironmentPaths(root, 'local').root)).toBe(false);
    for (const file of other) expect(existsSync(file), file).toBe(true);
    expect(existsSync(getLocalEnvironmentPaths(root, 'dev1').root)).toBe(true);
  });

  it('refuses to reset an environment that `up` is running', async () => {
    const files = populate('local');
    const paths = getLocalEnvironmentPaths(root, 'local');
    const session = await acquireLocalEnvironmentLock(paths, 'local', 'up');
    try {
      await expect(resetLocalEnvironment({ rootDir: root, env: 'local' })).rejects.toBeInstanceOf(
        LocalEnvironmentBusyError
      );
      for (const file of files) expect(existsSync(file), file).toBe(true);
    } finally {
      await session.release();
    }
    await resetLocalEnvironment({ rootDir: root, env: 'local' });
    for (const file of files) expect(existsSync(file), file).toBe(false);
    // The reset left no lock entry behind.
    expect(existsSync(paths.lock) ? readdirSync(paths.lock) : []).toEqual([]);
  });
});
