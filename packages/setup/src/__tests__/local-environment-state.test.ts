import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectLocalEnvironmentState } from '../core/local-environment-state.js';

describe('local environment state inspection', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('allows an environment with no local config or lock', async () => {
    directory = await mkdtemp(join(tmpdir(), 'authrim-env-state-'));

    expect(
      inspectLocalEnvironmentState({ baseDir: directory, environment: 'conformance' })
    ).toEqual({ exists: false, paths: [] });
  });

  it('blocks when a resource deletion intentionally preserved the current lock', async () => {
    directory = await mkdtemp(join(tmpdir(), 'authrim-env-state-'));
    const environmentDirectory = join(directory, '.authrim', 'conformance');
    await mkdir(environmentDirectory, { recursive: true });
    const lockPath = join(environmentDirectory, 'lock.json');
    await writeFile(lockPath, '{}');

    expect(
      inspectLocalEnvironmentState({ baseDir: directory, environment: 'conformance' })
    ).toEqual({ exists: true, paths: [lockPath] });
  });

  it('blocks a partially initialized environment that has config but no lock', async () => {
    directory = await mkdtemp(join(tmpdir(), 'authrim-env-state-'));
    const environmentDirectory = join(directory, '.authrim', 'test');
    await mkdir(environmentDirectory, { recursive: true });
    const configPath = join(environmentDirectory, 'config.json');
    await writeFile(configPath, '{}');

    expect(inspectLocalEnvironmentState({ baseDir: directory, environment: 'test' })).toEqual({
      exists: true,
      paths: [configPath],
    });
  });
});
