import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveReplicationObservation } from './cli';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'authrim-observation-'));
  folders.push(root);
  const value = {
    formatVersion: 1 as const,
    kind: 'operation' as const,
    planPath: join(root, 'plan.json'),
    planSha256: 'a'.repeat(64),
    observedAtMs: 1000,
    mode: 'sync' as const,
    journal: null,
  };
  return { root, path: join(root, 'state.json'), value };
}

describe('private replication observation ownership', () => {
  it('lets only one of two different plans claim a new resume path', async () => {
    const { path, value } = await fixture();
    const competing = { ...value, planSha256: 'b'.repeat(64) };
    const results = await Promise.allSettled([
      saveReplicationObservation(path, value),
      saveReplicationObservation(path, competing),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
    expect(saved).toEqual(results[0].status === 'fulfilled' ? value : competing);
    expect((await stat(path)).mode & 0o077).toBe(0);
  });

  it('updates only the same pinned plan and preserves it after an incompatible write', async () => {
    const { path, value } = await fixture();
    await saveReplicationObservation(path, value);
    const next = { ...value, observedAtMs: 2000 };
    await saveReplicationObservation(path, next);
    await expect(saveReplicationObservation(path, { ...value, mode: 'switch' })).rejects.toThrow();
    expect(JSON.parse(await readFile(path, 'utf8')) as unknown).toEqual(next);
  });

  it('rejects symbolic links without changing the linked record', async () => {
    const { path, root, value } = await fixture();
    const target = join(root, 'target.json');
    await writeFile(target, 'keep', { mode: 0o600 });
    await symlink(target, path);
    await expect(saveReplicationObservation(path, value)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('keep');
  });
});
