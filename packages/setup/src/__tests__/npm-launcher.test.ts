import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findLauncherSource,
  launchFromSource,
  resolveLauncherPaths,
  type LauncherDependencies,
} from '../core/npm-launcher.js';

const directories: string[] = [];
function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'setup-launcher-'));
  directories.push(dir);
  return dir;
}
function source(dir: string) {
  for (const name of ['ar-auth', 'ar-token', 'ar-lib-core', 'setup']) {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
  }
  writeFileSync(join(dir, 'package.json'), '{}');
}
function dependencies(): LauncherDependencies {
  return {
    confirmDownload: vi.fn().mockResolvedValue(true),
    download: vi.fn(async (target: string) => source(target)),
    run: vi.fn().mockResolvedValue(0),
  };
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('standalone npm source handoff', () => {
  it('downloads the matching version before preparing and executing the source CLI', async () => {
    const cwd = temporaryDirectory();
    const deps = dependencies();
    expect(await launchFromSource(['--cli', '--config', 'settings.json'], '0.4.1', cwd, deps)).toBe(
      0
    );
    const target = join(cwd, 'authrim');
    expect(deps.download).toHaveBeenCalledWith(target, 'v0.4.1');
    expect(vi.mocked(deps.run).mock.calls).toEqual([
      [['install', '--frozen-lockfile'], target],
      [['--filter', '@authrim/setup^...', 'build'], target],
      [['run', 'setup', '--cli', '--config', join(cwd, 'settings.json')], target],
    ]);
  });
  it('reuses source found in a parent directory without downloading', async () => {
    const root = temporaryDirectory();
    source(root);
    const cwd = join(root, 'packages', 'setup');
    const deps = dependencies();
    expect(findLauncherSource(cwd)).toBe(root);
    await launchFromSource(['status'], '0.4.1', cwd, deps);
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.confirmDownload).not.toHaveBeenCalled();
    expect(deps.run).toHaveBeenLastCalledWith(['run', 'setup', 'status'], root);
  });
  it('honors an explicit source and preserves relative key paths', async () => {
    const cwd = temporaryDirectory();
    const target = join(cwd, 'checkout');
    source(target);
    const deps = dependencies();
    await launchFromSource(
      ['deploy', '--source=checkout', '--keys-dir', 'keys'],
      '0.4.1',
      cwd,
      deps
    );
    expect(deps.run).toHaveBeenLastCalledWith(
      ['run', 'setup', 'deploy', `--source=${target}`, '--keys-dir', join(cwd, 'keys')],
      target
    );
    expect(deps.download).not.toHaveBeenCalled();
  });
  it('uses --keep as the download destination', async () => {
    const cwd = temporaryDirectory();
    const deps = dependencies();
    await launchFromSource(['init', '--keep', 'kept'], '0.4.1', cwd, deps);
    expect(deps.download).toHaveBeenCalledWith(join(cwd, 'kept'), 'v0.4.1');
  });
  it('does nothing when the user cancels', async () => {
    const deps = dependencies();
    vi.mocked(deps.confirmDownload).mockResolvedValue(false);
    expect(await launchFromSource([], '0.4.1', temporaryDirectory(), deps)).toBe(0);
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });
  it('refuses to overwrite an existing non-source directory', async () => {
    const cwd = temporaryDirectory();
    mkdirSync(join(cwd, 'authrim'));
    const deps = dependencies();
    await expect(launchFromSource([], '0.4.1', cwd, deps)).rejects.toThrow('Not an Authrim source');
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });
  it('does not download source for a destructive command with no existing environment', async () => {
    const deps = dependencies();
    await expect(
      launchFromSource(['delete', '--all', '--yes'], '0.4.1', temporaryDirectory(), deps)
    ).rejects.toThrow('source repository');
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });
  it('rejects incomplete downloaded source before installing or running anything', async () => {
    const deps = dependencies();
    vi.mocked(deps.download).mockResolvedValue(undefined);
    await expect(launchFromSource([], '0.4.1', temporaryDirectory(), deps)).rejects.toThrow(
      'does not contain'
    );
    expect(deps.run).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2])('propagates failure at preparation/execution step %i', async (step) => {
    const cwd = temporaryDirectory();
    source(cwd);
    const deps = dependencies();
    for (let i = 0; i < step; i++) vi.mocked(deps.run).mockResolvedValueOnce(0);
    vi.mocked(deps.run).mockResolvedValueOnce(7);
    expect(await launchFromSource([], '0.4.1', cwd, deps)).toBe(7);
    expect(deps.run).toHaveBeenCalledTimes(step + 1);
  });
  it('preserves paths containing spaces and equals without shell interpolation', () => {
    expect(resolveLauncherPaths(['--config=a b=c.json', '--env', 'test'], '/tmp')).toEqual([
      '--config=/tmp/a b=c.json',
      '--env',
      'test',
    ]);
    expect(() => resolveLauncherPaths(['--config', '--cli'], '/tmp')).toThrow('Missing value');
    expect(() => resolveLauncherPaths(['--keep='], '/tmp')).toThrow('Missing value');
  });
});
