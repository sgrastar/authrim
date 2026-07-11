import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';

const ensureSupplementalKeyFilesMock = vi.hoisted(() => vi.fn());
const ensureAdminUiBffMachineAccessInD1Mock = vi.hoisted(() => vi.fn());
const loadAdminUiBffWorkerSecretsMock = vi.hoisted(() => vi.fn());

vi.mock('../core/keys.js', () => ({
  ensureSupplementalKeyFiles: ensureSupplementalKeyFilesMock,
}));

vi.mock('../core/cloudflare.js', () => ({
  ensureAdminUiBffMachineAccessInD1: ensureAdminUiBffMachineAccessInD1Mock,
}));

vi.mock('../core/admin-machine-access.js', () => ({
  loadAdminUiBffWorkerSecrets: loadAdminUiBffWorkerSecretsMock,
}));

import { prepareAdminUiBffDeployment } from '../core/admin-ui-bff-deployment.js';

const tempDirs: string[] = [];

describe('prepareAdminUiBffDeployment', () => {
  beforeEach(() => {
    ensureSupplementalKeyFilesMock.mockReset();
    ensureAdminUiBffMachineAccessInD1Mock.mockReset();
    loadAdminUiBffWorkerSecretsMock.mockReset();
    ensureSupplementalKeyFilesMock.mockResolvedValue({ createdFiles: [] });
    ensureAdminUiBffMachineAccessInD1Mock.mockResolvedValue({ success: true });
    loadAdminUiBffWorkerSecretsMock.mockResolvedValue({
      ADMIN_UI_BFF_CLIENT_ID: 'authrim-admin-ui-bff',
      ADMIN_UI_BFF_KEY_ID: 'kid',
      ADMIN_UI_BFF_PRIVATE_KEY_PEM: 'private',
      ADMIN_UI_BFF_SCOPES: 'clients:read',
    });
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('generates missing supplemental keys, registers the public credential, then loads secrets', async () => {
    const keysDir = await mkdtemp(join(tmpdir(), 'authrim-admin-ui-bff-'));
    tempDirs.push(keysDir);
    const callOrder: string[] = [];
    ensureSupplementalKeyFilesMock.mockImplementation(async () => {
      callOrder.push('keys');
      return { createdFiles: [] };
    });
    ensureAdminUiBffMachineAccessInD1Mock.mockImplementation(async () => {
      callOrder.push('register');
      return { success: true };
    });
    loadAdminUiBffWorkerSecretsMock.mockImplementation(async () => {
      callOrder.push('load');
      return {
        ADMIN_UI_BFF_CLIENT_ID: 'authrim-admin-ui-bff',
        ADMIN_UI_BFF_KEY_ID: 'kid',
        ADMIN_UI_BFF_PRIVATE_KEY_PEM: 'private',
        ADMIN_UI_BFF_SCOPES: 'clients:read',
      };
    });

    await expect(
      prepareAdminUiBffDeployment({
        env: 'test',
        config: createDefaultConfig('test'),
        keysDir,
      })
    ).resolves.toEqual(expect.objectContaining({ ADMIN_UI_BFF_PRIVATE_KEY_PEM: 'private' }));
    expect(callOrder).toEqual(['keys', 'register', 'load']);
  });

  it('fails closed before reading or deploying the private key when DB registration fails', async () => {
    const keysDir = await mkdtemp(join(tmpdir(), 'authrim-admin-ui-bff-'));
    tempDirs.push(keysDir);
    ensureAdminUiBffMachineAccessInD1Mock.mockResolvedValue({
      success: false,
      error: 'DB_ADMIN unavailable',
    });

    await expect(
      prepareAdminUiBffDeployment({
        env: 'test',
        config: createDefaultConfig('test'),
        keysDir,
      })
    ).rejects.toThrow('DB_ADMIN unavailable');
    expect(loadAdminUiBffWorkerSecretsMock).not.toHaveBeenCalled();
  });

  it('rejects a missing key archive before attempting repair', async () => {
    await expect(
      prepareAdminUiBffDeployment({
        env: 'test',
        config: createDefaultConfig('test'),
        keysDir: join(tmpdir(), 'authrim-keys-do-not-exist'),
      })
    ).rejects.toThrow('Keys directory not found');
    expect(ensureSupplementalKeyFilesMock).not.toHaveBeenCalled();
  });
});
