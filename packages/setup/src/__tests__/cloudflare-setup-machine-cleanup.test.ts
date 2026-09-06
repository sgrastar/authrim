import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({ execa: execaMock }));

import {
  ensureSetupMachineKeyFiles,
  setupMachineKeyFilesExist,
} from '../core/admin-machine-access.js';
import { cleanupSetupMachineAccessInD1 } from '../core/cloudflare.js';

describe('setup machine cleanup', () => {
  let keysDir: string | undefined;

  beforeEach(async () => {
    keysDir = await realpath(await mkdtemp(join(tmpdir(), 'authrim-setup-machine-cleanup-')));
    await ensureSetupMachineKeyFiles(keysDir, 'setup-cleanup-test');
    execaMock.mockReset();
  });

  afterEach(async () => {
    if (keysDir) await rm(keysDir, { recursive: true, force: true });
    keysDir = undefined;
  });

  it('deletes the local private key even when remote principal cleanup fails', async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Cloudflare D1 cleanup unavailable',
    });

    await expect(
      cleanupSetupMachineAccessInD1('test', keysDir!, undefined, {
        databaseIdentifier: '11111111-1111-4111-8111-111111111111',
      })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('remote cleanup failed'),
    });
    expect(setupMachineKeyFilesExist(keysDir!)).toBe(false);
  });
});
