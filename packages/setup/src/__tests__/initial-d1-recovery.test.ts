import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cloudflareMock = vi.hoisted(() => ({
  getAccountId: vi.fn(),
  listD1Databases: vi.fn(),
}));

vi.mock('../core/cloudflare.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/cloudflare.js')>()),
  ...cloudflareMock,
}));

import { recoverInitialControlPlaneD1Identity } from '../core/control-plane-bootstrap.js';
import {
  beginOrResumeProvisioningIntent,
  loadProvisioningIntent,
  recordProvisioningResourceCreateIssued,
} from '../core/provisioning-intent.js';
import { getEnvironmentPaths } from '../core/paths.js';

const databaseId = '99999999-9999-4999-8999-999999999999';
const binding = 'TEST_TDB_PII_BOOTSTRAP_PII';
const name = 'test-authrim-tenant-pii-bootstrap-db';
const accountId = '98edc9b77724418e61ae577980a7369b';

describe('initial Control-plane D1 identity recovery', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'authrim-initial-d1-recovery-'));
    const intent = await beginOrResumeProvisioningIntent({
      baseDir: rootDir,
      environment: 'test',
      accountId,
      resourceSpec: {
        purpose: 'initial_control_plane_tenant_shards',
        resources: [
          {
            kind: 'd1',
            binding: 'TEST_TDB_DEFAULT_BOOTSTRAP_CORE',
            name: 'test-authrim-tenant-default-bootstrap-db',
          },
          {
            kind: 'd1',
            binding: 'TEST_TDB_USERS_BOOTSTRAP_CORE',
            name: 'test-authrim-tenant-users-bootstrap-db',
          },
          { kind: 'd1', binding, name },
        ],
      },
    });
    await recordProvisioningResourceCreateIssued({
      baseDir: rootDir,
      environment: 'test',
      expectedIntentId: intent.intent.id,
      resource: { kind: 'd1', binding, name },
    });
    const paths = getEnvironmentPaths({ baseDir: rootDir, env: 'test' });
    await writeFile(
      paths.lock,
      JSON.stringify({
        version: '1',
        env: 'test',
        d1: {},
        kv: {},
        workers: {},
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      })
    );
    cloudflareMock.getAccountId.mockResolvedValue(accountId);
    cloudflareMock.listD1Databases.mockResolvedValue([{ name, uuid: databaseId }]);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('records the exact provider ID after account and inventory verification', async () => {
    await expect(
      recoverInitialControlPlaneD1Identity({ rootDir, env: 'test', binding, databaseId })
    ).resolves.toEqual({ name, id: databaseId });
    const intent = await loadProvisioningIntent({ baseDir: rootDir, environment: 'test' });
    expect(intent?.resources[`d1:${binding}`]).toMatchObject({
      state: 'identified',
      id: databaseId,
    });
  });

  it.each([
    ['wrong immutable ID', '88888888-8888-4888-8888-888888888888', accountId, name],
    ['wrong account', databaseId, '00000000000000000000000000000000', name],
    ['wrong resource name', databaseId, accountId, 'other-database'],
  ])('keeps the create checkpoint unchanged for %s', async (_reason, id, account, remoteName) => {
    cloudflareMock.getAccountId.mockResolvedValue(account);
    cloudflareMock.listD1Databases.mockResolvedValue([{ name: remoteName, uuid: databaseId }]);

    await expect(
      recoverInitialControlPlaneD1Identity({ rootDir, env: 'test', binding, databaseId: id })
    ).rejects.toThrow();
    const intent = await loadProvisioningIntent({ baseDir: rootDir, environment: 'test' });
    expect(intent?.resources[`d1:${binding}`]).toMatchObject({ state: 'create_issued' });
  });
});
