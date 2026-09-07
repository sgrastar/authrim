import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execa: vi.fn() }));
vi.mock('execa', () => ({ execa: mocks.execa }));

import {
  completeInitialSetup,
  displaySetupInstructions,
  getFullSetupUrl,
  isSetupCompleted,
  storeSetupToken,
} from '../core/admin.js';

const token = 'A'.repeat(43);
const originalCwd = process.cwd();
let root: string;

async function writeToken(path: string, value = token): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'setup_token.txt'), value);
}

async function writeWorker(base = root): Promise<string> {
  const worker = join(base, 'packages', 'ar-auth');
  await mkdir(worker, { recursive: true });
  await writeFile(join(worker, 'wrangler.toml'), 'name = "test"');
  return worker;
}

describe('initial admin setup', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-admin-setup-')));
    process.chdir(root);
    mocks.execa.mockReset();
    mocks.execa.mockResolvedValue({ stdout: '' });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  it('validates environment names before running commands', async () => {
    await expect(isSetupCompleted('../prod', root)).rejects.toThrow('Invalid environment name');
    await expect(storeSetupToken({ env: 'Prod!', baseDir: root })).rejects.toThrow(
      'Invalid environment name'
    );
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it('returns false when wrangler config is absent or the completion check fails', async () => {
    await expect(isSetupCompleted('prod', root)).resolves.toBe(false);
    await writeWorker();
    mocks.execa.mockRejectedValueOnce(new Error('wrangler failed'));
    await expect(isSetupCompleted('prod', root)).resolves.toBe(false);
  });

  it.each([
    ['true\n', true],
    ['false\n', false],
    ['', false],
  ])('reads setup completion flag %j', async (stdout, completed) => {
    const worker = await writeWorker();
    mocks.execa.mockResolvedValueOnce({ stdout });
    await expect(isSetupCompleted('prod', root)).resolves.toBe(completed);
    expect(mocks.execa).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['--env', 'prod', '--binding', 'AUTHRIM_CONFIG']),
      expect.objectContaining({ cwd: worker, reject: false })
    );
  });

  it('reports all supported token locations when key generation has not run', async () => {
    const result = await storeSetupToken({ env: 'prod', baseDir: root });
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('.authrim-keys');
    expect(result.error).toContain('.authrim/prod/keys');
    expect(result.error).toContain('.keys/prod');
  });

  it.each(['short', `${'A'.repeat(42)}=`, 'A'.repeat(44)])(
    'rejects malformed setup token %s',
    async (value) => {
      await writeToken(join(root, '.authrim-keys', 'prod'), value);
      const result = await storeSetupToken({ env: 'prod', baseDir: root, keysBaseDir: root });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid setup token format');
    }
  );

  it('reports a missing ar-auth deployment after reading a valid external token', async () => {
    await writeToken(join(root, '.authrim-keys', 'prod'));
    const progress: string[] = [];
    const result = await storeSetupToken({
      env: 'prod',
      baseDir: root,
      keysBaseDir: root,
      onProgress: (message) => progress.push(message),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot find ar-auth package');
    expect(progress.some((line) => line.includes('Checking for ar-auth'))).toBe(true);
  });

  it('skips token storage when setup is already complete', async () => {
    await writeToken(join(root, '.authrim-keys', 'prod'));
    await writeWorker();
    mocks.execa.mockResolvedValueOnce({ stdout: 'true' });
    await expect(
      storeSetupToken({ env: 'prod', baseDir: root, keysBaseDir: root })
    ).resolves.toEqual({ success: true, alreadyCompleted: true });
    expect(mocks.execa).toHaveBeenCalledTimes(1);
  });

  it('continues after completion lookup failure and stores token using --path', async () => {
    const tokenDir = join(root, '.authrim-keys', 'prod');
    await writeToken(tokenDir);
    const worker = await writeWorker();
    mocks.execa
      .mockRejectedValueOnce(new Error('read denied'))
      .mockResolvedValueOnce({ stdout: '' });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const result = await storeSetupToken({
      env: 'prod',
      baseDir: root,
      keysBaseDir: root,
      ttlSeconds: 120,
    });
    vi.useRealTimers();
    expect(result).toEqual({
      success: true,
      setupUrl: `/admin-init-setup?token=${token}`,
      expiresAt: '2026-01-01T00:02:00.000Z',
    });
    expect(mocks.execa).toHaveBeenLastCalledWith(
      'npx',
      expect.arrayContaining([
        'put',
        'setup:token',
        '--path',
        join(tokenDir, 'setup_token.txt'),
        '--ttl',
        '120',
        '--remote',
      ]),
      expect.objectContaining({ cwd: worker, reject: true })
    );
  });

  it('sanitizes command failures into a setup result', async () => {
    await writeToken(join(root, '.authrim-keys', 'prod'));
    await writeWorker();
    mocks.execa.mockResolvedValueOnce({ stdout: '' }).mockRejectedValueOnce(new Error('KV denied'));
    await expect(
      storeSetupToken({ env: 'prod', baseDir: root, keysBaseDir: root })
    ).resolves.toEqual({ success: false, error: 'Failed to store setup token: KV denied' });
  });

  it('supports explicit, legacy, internal, and authrim-subdirectory token locations', async () => {
    const scenarios = [
      { tokenDir: join(root, 'custom', 'prod'), options: { keysDir: join(root, 'custom') } },
      { tokenDir: join(root, '.keys', 'prod'), options: { legacy: true } },
      { tokenDir: join(root, '.authrim', 'prod', 'keys'), options: {} },
      { tokenDir: join(root, 'authrim', '.authrim', 'prod', 'keys'), options: {} },
    ];
    for (const scenario of scenarios) {
      await writeToken(scenario.tokenDir);
      await writeWorker();
      mocks.execa.mockResolvedValueOnce({ stdout: 'true' });
      await expect(
        storeSetupToken({ env: 'prod', baseDir: root, ...scenario.options })
      ).resolves.toMatchObject({ success: true, alreadyCompleted: true });
      await rm(scenario.tokenDir, { recursive: true, force: true });
    }
  });

  it('builds a validated full URL and strips trailing slashes', () => {
    expect(getFullSetupUrl('https://admin.example.com///', token)).toBe(
      `https://admin.example.com/admin-init-setup?token=${token}`
    );
    expect(() => getFullSetupUrl('https://admin.example.com', 'invalid')).toThrow(
      'Invalid setup token format'
    );
  });

  it('renders plain and colored setup instructions through the supplied output', () => {
    const plain: string[] = [];
    displaySetupInstructions('https://admin.example/setup', {
      color: false,
      onOutput: (line) => plain.push(line),
    });
    expect(plain.join('\n')).toContain('https://admin.example/setup');
    expect(plain.join('\n')).not.toContain('\x1b[');
    const colored: string[] = [];
    displaySetupInstructions('url', { onOutput: (line) => colored.push(line) });
    expect(colored.join('\n')).toContain('\x1b[1m');
  });

  it('completes setup with full URL or propagates already-complete state', async () => {
    await writeToken(join(root, '.authrim-keys', 'prod'));
    await writeWorker();
    mocks.execa.mockResolvedValueOnce({ stdout: '' }).mockResolvedValueOnce({ stdout: '' });
    await expect(
      completeInitialSetup({
        env: 'prod',
        baseUrl: 'https://admin.example.com/',
        baseDir: root,
        keysBaseDir: root,
      })
    ).resolves.toMatchObject({
      success: true,
      setupUrl: `https://admin.example.com/admin-init-setup?token=${token}`,
    });

    mocks.execa.mockResolvedValueOnce({ stdout: 'true' });
    await expect(
      completeInitialSetup({
        env: 'prod',
        baseUrl: 'https://admin.example.com',
        baseDir: root,
        keysBaseDir: root,
      })
    ).resolves.toEqual({ success: true, alreadyCompleted: true });
  });
});
