import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createManagedWorkerDeployTicket,
  MANAGED_WORKER_DEPLOY_BUILD_COMMAND,
} from '../core/managed-worker-deploy.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const guardScript = fileURLToPath(
  new URL('../../../../scripts/guard-managed-worker-deploy.mjs', import.meta.url)
);

async function createManagedPackage(): Promise<{ rootDir: string; packageDir: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), 'authrim-managed-deploy-test-'));
  tempDirs.push(rootDir);
  const packageDir = join(rootDir, 'packages', 'ar-auth');
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, 'wrangler.toml'),
    `[build]\ncommand = "${MANAGED_WORKER_DEPLOY_BUILD_COMMAND}"\n`,
    'utf8'
  );
  return { rootDir, packageDir };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('managed Worker deployment guard', () => {
  it('keeps local development and binding type generation available without a ticket', async () => {
    const { packageDir } = await createManagedPackage();

    for (const command of ['dev', 'types']) {
      await expect(
        execFileAsync(process.execPath, [guardScript], {
          cwd: packageDir,
          env: { WRANGLER_COMMAND: command },
        })
      ).resolves.toMatchObject({ stderr: '' });
    }
  });

  it('rejects a raw Wrangler build without a setup-issued capability', async () => {
    const { packageDir } = await createManagedPackage();

    await expect(
      execFileAsync(process.execPath, [guardScript], {
        cwd: packageDir,
        env: { WRANGLER_COMMAND: 'deploy' },
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('managed deployment ticket is missing'),
    });
  });

  it('accepts exactly one matching short-lived capability', async () => {
    const { packageDir } = await createManagedPackage();
    const ticket = await createManagedWorkerDeployTicket({
      wranglerCommand: 'deploy',
      component: 'ar-auth',
      environment: 'test',
      workerName: 'test-ar-auth',
      packageDir,
    });
    expect(ticket).toBeDefined();

    try {
      await expect(
        execFileAsync(process.execPath, [guardScript], {
          cwd: packageDir,
          env: { ...process.env, ...ticket!.env, WRANGLER_COMMAND: 'deploy' },
        })
      ).resolves.toMatchObject({ stderr: '' });
      await expect(ticket!.assertConsumed()).resolves.toBeUndefined();
      await expect(
        execFileAsync(process.execPath, [guardScript], {
          cwd: packageDir,
          env: { ...process.env, ...ticket!.env, WRANGLER_COMMAND: 'deploy' },
        })
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('managed deployment ticket was already used'),
      });
    } finally {
      await ticket!.cleanup();
    }
  });

  it('rejects expired and cross-component capabilities', async () => {
    const { packageDir } = await createManagedPackage();
    const expired = await createManagedWorkerDeployTicket({
      wranglerCommand: 'deploy',
      component: 'ar-auth',
      environment: 'test',
      workerName: 'test-ar-auth',
      packageDir,
      now: 0,
    });
    expect(expired).toBeDefined();

    try {
      await expect(
        execFileAsync(process.execPath, [guardScript], {
          cwd: packageDir,
          env: { ...process.env, ...expired!.env, WRANGLER_COMMAND: 'deploy' },
        })
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('managed deployment ticket has expired'),
      });
      await expect(
        execFileAsync(process.execPath, [guardScript], {
          cwd: join(packageDir, '..'),
          env: { ...process.env, ...expired!.env, WRANGLER_COMMAND: 'deploy' },
        })
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('scope does not match'),
      });
    } finally {
      await expired!.cleanup();
    }
  });

  it('rejects a config change after the deployment capability is issued', async () => {
    const { packageDir } = await createManagedPackage();
    const ticket = await createManagedWorkerDeployTicket({
      wranglerCommand: 'deploy',
      component: 'ar-auth',
      environment: 'test',
      workerName: 'test-ar-auth',
      packageDir,
    });
    expect(ticket).toBeDefined();

    try {
      await writeFile(
        join(packageDir, 'wrangler.toml'),
        `[build]\ncommand = "${MANAGED_WORKER_DEPLOY_BUILD_COMMAND}"\n[env.wrong]\nname = "wrong-ar-auth"\n`,
        'utf8'
      );
      await expect(
        execFileAsync(process.execPath, [guardScript], {
          cwd: packageDir,
          env: { ...process.env, ...ticket!.env, WRANGLER_COMMAND: 'deploy' },
        })
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('config changed after authorization'),
      });
    } finally {
      await ticket!.cleanup();
    }
  });
});
