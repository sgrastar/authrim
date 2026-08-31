import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/cloudflare.js', () => ({
  getWorkersSubdomain: vi.fn(async () => 'test-account'),
}));

import * as atomicFile from '../core/atomic-file.js';
import { createDefaultConfig } from '../core/config.js';
import { getEnvironmentPaths } from '../core/paths.js';
import {
  backupDeployConfigs,
  getDeployWranglerPath,
  getMasterWranglerPath,
  restoreDeployConfigs,
  saveMasterWranglerConfigs,
  syncWranglerConfigs,
} from '../core/wrangler-sync.js';

const COMPONENT = 'ar-auth';
const OLD_DEPLOY_CONTENT = `name = "old-auth"

# Environment: test
[env.test]
name = "old-auth"
`;
const MASTER_CONTENT = `name = "test-auth"

# Environment: test
[env.test]
name = "test-auth"
`;

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function createWranglerTestConfig() {
  const config = createDefaultConfig('test');
  config.components.adminUi = false;
  return config;
}

describe('atomic wrangler config publication', () => {
  let baseDir: string;
  let packagesDir: string;
  let masterPath: string;
  let deployPath: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'authrim-wrangler-atomic-'));
    packagesDir = join(baseDir, 'packages');
    const envPaths = getEnvironmentPaths({ baseDir, env: 'test' });
    masterPath = getMasterWranglerPath(envPaths, COMPONENT);
    deployPath = getDeployWranglerPath(packagesDir, COMPONENT);
    mkdirSync(dirname(masterPath), { recursive: true });
    mkdirSync(dirname(deployPath), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('keeps the previous master file intact when atomic publication is interrupted', async () => {
    writeFileSync(masterPath, 'previous-master\n', { mode: 0o600 });
    vi.spyOn(atomicFile, 'writePrivateFileAtomically').mockRejectedValueOnce(
      new Error('simulated_sigkill_before_rename')
    );

    const result = await saveMasterWranglerConfigs(
      createWranglerTestConfig(),
      { d1: {}, kv: {} },
      {
        baseDir,
        env: 'test',
        components: [COMPONENT],
        validateCapabilities: false,
      }
    );

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([`${COMPONENT}: simulated_sigkill_before_rename`]);
    expect(readFileSync(masterPath, 'utf-8')).toBe('previous-master\n');
    expect(fileMode(masterPath)).toBe(0o600);
  });

  it('publishes a complete master file atomically and preserves a restrictive mode', async () => {
    writeFileSync(masterPath, 'previous-master\n', { mode: 0o600 });

    const result = await saveMasterWranglerConfigs(
      createWranglerTestConfig(),
      { d1: {}, kv: {} },
      {
        baseDir,
        env: 'test',
        components: [COMPONENT],
        validateCapabilities: false,
      }
    );

    expect(result.success).toBe(true);
    expect(readFileSync(masterPath, 'utf-8')).toContain('[env.test]');
    expect(fileMode(masterPath)).toBe(0o600);
    expect(readdirSync(dirname(masterPath)).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('keeps the previous deploy file intact when atomic sync is interrupted', async () => {
    writeFileSync(masterPath, MASTER_CONTENT, { mode: 0o600 });
    writeFileSync(deployPath, OLD_DEPLOY_CONTENT, { mode: 0o600 });
    vi.spyOn(atomicFile, 'writePrivateFileAtomically').mockRejectedValueOnce(
      new Error('simulated_sigkill_before_rename')
    );

    const result = await syncWranglerConfigs({
      baseDir,
      env: 'test',
      packagesDir,
      components: [COMPONENT],
      force: true,
    });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([`${COMPONENT}: simulated_sigkill_before_rename`]);
    expect(readFileSync(deployPath, 'utf-8')).toBe(OLD_DEPLOY_CONTENT);
  });

  it('atomically syncs deploy config and never widens master or deploy permissions', async () => {
    writeFileSync(masterPath, MASTER_CONTENT, { mode: 0o600 });
    writeFileSync(deployPath, OLD_DEPLOY_CONTENT, { mode: 0o666 });

    const result = await syncWranglerConfigs({
      baseDir,
      env: 'test',
      packagesDir,
      components: [COMPONENT],
      force: true,
    });

    expect(result.success).toBe(true);
    expect(readFileSync(deployPath, 'utf-8')).toContain('name = "test-auth"');
    expect(readFileSync(deployPath, 'utf-8')).not.toContain('name = "old-auth"');
    expect(fileMode(deployPath)).toBe(0o600);
    expect(readdirSync(dirname(deployPath)).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('publishes manual-edit backups atomically with the source restriction', async () => {
    writeFileSync(masterPath, MASTER_CONTENT, { mode: 0o644 });
    writeFileSync(deployPath, OLD_DEPLOY_CONTENT, { mode: 0o600 });

    const result = await syncWranglerConfigs(
      {
        baseDir,
        env: 'test',
        packagesDir,
        components: [COMPONENT],
      },
      async () => 'backup'
    );

    const backupPath = `${deployPath}.backup`;
    expect(result.success).toBe(true);
    expect(readFileSync(backupPath, 'utf-8')).toBe(OLD_DEPLOY_CONTENT);
    expect(fileMode(backupPath)).toBe(0o600);
  });

  it('keeps backup and deploy finals intact across interrupted backup and restore writes', async () => {
    const backupPath = `${deployPath}.backup`;
    writeFileSync(deployPath, 'source-deploy\n', { mode: 0o600 });
    writeFileSync(backupPath, 'previous-backup\n', { mode: 0o600 });

    vi.spyOn(atomicFile, 'writePrivateFileAtomically').mockRejectedValueOnce(
      new Error('simulated_backup_sigkill')
    );
    await expect(backupDeployConfigs({ env: 'test', packagesDir })).rejects.toThrow(
      'simulated_backup_sigkill'
    );
    expect(readFileSync(backupPath, 'utf-8')).toBe('previous-backup\n');

    vi.restoreAllMocks();
    writeFileSync(deployPath, 'changed-deploy\n');
    vi.spyOn(atomicFile, 'writePrivateFileAtomically').mockRejectedValueOnce(
      new Error('simulated_restore_sigkill')
    );
    await expect(restoreDeployConfigs({ env: 'test', packagesDir })).rejects.toThrow(
      'simulated_restore_sigkill'
    );
    expect(readFileSync(deployPath, 'utf-8')).toBe('changed-deploy\n');
  });

  it('backs up and restores atomically while preserving restrictive modes', async () => {
    const backupPath = `${deployPath}.backup`;
    writeFileSync(deployPath, 'source-deploy\n', { mode: 0o600 });
    writeFileSync(backupPath, 'stale-backup\n', { mode: 0o666 });

    await expect(backupDeployConfigs({ env: 'test', packagesDir })).resolves.toContain(COMPONENT);
    expect(readFileSync(backupPath, 'utf-8')).toBe('source-deploy\n');
    expect(fileMode(backupPath)).toBe(0o600);

    writeFileSync(deployPath, 'changed-deploy\n');
    chmodSync(deployPath, 0o644);
    await expect(restoreDeployConfigs({ env: 'test', packagesDir })).resolves.toContain(COMPONENT);
    expect(readFileSync(deployPath, 'utf-8')).toBe('source-deploy\n');
    expect(fileMode(deployPath)).toBe(0o600);
    expect(existsSync(backupPath)).toBe(true);
  });
});
