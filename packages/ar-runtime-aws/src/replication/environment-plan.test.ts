import { createHash } from 'node:crypto';
import { mkdtemp, realpath, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { environmentTestConfiguration } from './environment-test-fixture';
import {
  parseEnvironmentReplicationConfiguration,
  createEnvironmentReplicationPlan,
  parseEnvironmentReplicationPlan,
} from './environment-plan';
import { canonicalRestoreJson } from '../import/restore-evidence';
import { runReplicationCli } from './cli';
const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'authrim-environment-plan-'));
  folders.push(root);
  const path = join(root, 'schema.sql'),
    sql = 'CREATE TABLE synthetic (id TEXT PRIMARY KEY);';
  await writeFile(path, sql, { mode: 0o600 });
  return {
    root,
    path,
    configuration: environmentTestConfiguration(
      path,
      createHash('sha256').update(sql).digest('hex')
    ),
  };
}
describe('complete environment plan', () => {
  it('pins both tenant schemas and leaves UI optional without provider calls', async () => {
    const { configuration } = await fixture();
    const network = vi.fn(() => {
      throw new Error('network forbidden');
    });
    vi.stubGlobal('fetch', network);
    const plan = await createEnvironmentReplicationPlan(configuration, 'a'.repeat(64));
    expect(parseEnvironmentReplicationPlan(canonicalRestoreJson(plan), 'a'.repeat(64))).toEqual(
      plan
    );
    expect(plan.configuration.tenants.map((t) => t.pair.tenantId)).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
    expect(
      plan.configuration.tenants.every((t) => t.destination.ui.components?.loginUi === false)
    ).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });
  it.each([
    'duplicate',
    'unordered',
    'wrong-environment-pair',
    'wrong-epoch',
    'wrong-controller',
    'different-storage',
    'different-writer',
    'unknown-key',
    'too-many',
  ])('rejects %s membership or deployment ambiguity', async (kind) => {
    const { configuration: c } = await fixture();
    if (kind === 'duplicate') c.tenants[1] = structuredClone(c.tenants[0]);
    if (kind === 'unordered') c.tenants.reverse();
    if (kind === 'wrong-environment-pair') c.tenants[1].pair.pairId = 'another-pair';
    if (kind === 'wrong-epoch') c.tenants[1].expectedEpoch = 2;
    if (kind === 'wrong-controller') c.tenants[1].authority.secretEnv = 'ANOTHER_SECRET';
    if (kind === 'different-storage') c.tenants[1].destination.artifacts.bucket = 'another-bucket';
    if (kind === 'different-writer') c.tenants[1].destination.writerCredentialId = 'another-writer';
    if (kind === 'unknown-key') Object.assign(c.inventory, { partial: true });
    if (kind === 'too-many')
      c.tenants = Array.from({ length: 17 }, () => structuredClone(c.tenants[0]));
    expect(() => parseEnvironmentReplicationConfiguration(c)).toThrow();
  });
  it('rejects changed SQL before writing a usable plan', async () => {
    const f = await fixture();
    await writeFile(f.path, 'changed');
    await expect(
      createEnvironmentReplicationPlan(f.configuration, 'a'.repeat(64))
    ).rejects.toThrow();
  });
  it('the actual setup executor CLI creates a private format2 plan and rejects wrong code before credentials', async () => {
    const f = await fixture(),
      config = join(f.root, 'config.json'),
      out = join(f.root, 'plan.json');
    await writeFile(config, JSON.stringify(f.configuration));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runReplicationCli(['plan', '--config', config, '--out', out], {});
    expect(process.exitCode).not.toBe(1);
    expect((await stat(out)).mode & 0o077).toBe(0);
    const plan = parseEnvironmentReplicationPlan(await readFile(out, 'utf8'));
    expect(plan.configuration.tenants).toHaveLength(2);
    plan.executorSha256 = 'f'.repeat(64);
    const changed = canonicalRestoreJson(plan);
    await writeFile(out, changed);
    await runReplicationCli(
      [
        'sync',
        '--plan',
        out,
        '--plan-sha256',
        createHash('sha256').update(changed).digest('hex'),
        '--state',
        join(f.root, 'state.json'),
      ],
      {}
    );
    expect(process.exitCode).toBe(1);
    await expect(stat(join(f.root, 'state.json'))).rejects.toThrow();
  });
});
