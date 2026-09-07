import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { D1_DATABASES, getD1DatabaseName } from '../core/naming.js';

const capacity = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  request: vi.fn(),
}));
const machineAccess = vi.hoisted(() => ({
  run: vi.fn((input: { action: () => Promise<unknown> }) => input.action()),
}));
const cloudflare = vi.hoisted(() => ({
  listD1: vi.fn(),
}));
const operationHooks = vi.hoisted(() => ({
  beforeAcquire: vi.fn(async () => undefined),
}));
vi.mock('../core/control-capacity-client.js', () => ({
  listSetupExclusiveCapacityTenants: capacity.list,
  previewSetupControlCapacity: capacity.preview,
  requestSetupControlCapacity: capacity.request,
}));
vi.mock('../core/setup-machine-access-lifecycle.js', () => ({
  runEphemeralSetupMachineAccess: machineAccess.run,
}));
vi.mock('../core/cloudflare.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/cloudflare.js')>()),
  listD1Databases: cloudflare.listD1,
}));
vi.mock('../core/lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/lock.js')>();
  return {
    ...actual,
    acquireEnvironmentOperationForEnvironment: async (
      input: Parameters<typeof actual.acquireEnvironmentOperationForEnvironment>[0]
    ) => {
      await operationHooks.beforeAcquire();
      return actual.acquireEnvironmentOperationForEnvironment(input);
    },
  };
});

import { acquireEnvironmentOperationForEnvironment } from '../core/lock.js';
import { createApiRoutes, generateSessionToken } from '../web/api.js';

const originalCwd = process.cwd();
let root: string;

const preview = {
  dryRun: true,
  profile: 'recommended',
  scope: 'shared_pool',
  tenantId: null,
  available: true,
  reasonCode: null,
  capacityUnitsAdded: 0,
  d1DatabasesAdded: 0,
  projectedEnvironmentD1Count: 10,
  targets: [],
} as const;

function fixedD1Lock() {
  return Object.fromEntries(
    D1_DATABASES.map((database) => [
      database.binding,
      {
        id:
          database.binding === 'CONTROL_DB'
            ? 'control-id'
            : database.binding === 'DB_ADMIN'
              ? 'admin-id'
              : `${database.binding.toLowerCase()}-id`,
        name: getD1DatabaseName('test', database.dbType),
      },
    ])
  );
}

function deployedLock() {
  return {
    version: '1.0.0',
    env: 'test',
    createdAt: '2026-07-30T00:00:00.000Z',
    productVersion: '0.4.0',
    d1: fixedD1Lock(),
    kv: {},
  };
}

async function writeLock(lock: ReturnType<typeof deployedLock>): Promise<void> {
  await writeFile(join(root, '.authrim', 'test', 'lock.json'), JSON.stringify(lock));
}

function request(
  token: string,
  body: unknown,
  origin = 'http://localhost'
): NonNullable<Parameters<typeof fetch>[1]> {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Token': token,
      Origin: origin,
    },
    body: JSON.stringify(body),
  };
}

describe('setup Web Control capacity API', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-web-control-capacity-')));
    process.chdir(root);
    const directory = join(root, '.authrim', 'test');
    await mkdir(directory, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'authrim-test' }));
    await writeFile(join(directory, 'config.json'), JSON.stringify(createDefaultConfig('test')));
    await writeLock(deployedLock());
    vi.clearAllMocks();
    capacity.list.mockResolvedValue(['tenant-a']);
    capacity.preview.mockResolvedValue(preview);
    capacity.request.mockResolvedValue({ result: { preview, operations: [] }, auditId: 'audit-1' });
    cloudflare.listD1.mockResolvedValue(
      Object.values(fixedD1Lock()).map((database) => ({
        name: database.name,
        uuid: database.id,
      }))
    );
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  it('lists dedicated tenants and forwards preview/request to the shared Control planner', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const tenantsResponse = await app.request('/control/capacity/tenants?environmentId=test', {
      headers: { 'X-Session-Token': token },
    });
    expect(tenantsResponse.status).toBe(200);
    await expect(tenantsResponse.json()).resolves.toEqual({ success: true, tenants: ['tenant-a'] });

    const body = {
      environmentId: 'test',
      profile: 'recommended',
      scope: 'shared_pool',
      tenantId: null,
    };
    const previewResponse = await app.request(
      'http://localhost/control/capacity/preview',
      request(token, body)
    );
    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toEqual({ success: true, preview });
    expect(capacity.preview).toHaveBeenCalledWith({
      apiBaseUrl: expect.any(String),
      keysDir: expect.any(String),
      controlDatabaseName: 'control-id',
      request: { profile: 'recommended', scope: 'shared_pool', tenantId: null },
    });
    expect(machineAccess.run).toHaveBeenCalledTimes(1);
    expect(machineAccess.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ databaseIdentifier: 'admin-id' })
    );

    const mutationResponse = await app.request(
      'http://localhost/control/capacity/request',
      request(token, body)
    );
    expect(mutationResponse.status).toBe(202);
    await expect(mutationResponse.json()).resolves.toEqual({
      success: true,
      result: { preview, operations: [] },
      auditId: 'audit-1',
    });
    expect(machineAccess.run).toHaveBeenCalledTimes(2);
  });

  it('does not mutate when a canonical D1 name was replaced with a different UUID', async () => {
    cloudflare.listD1.mockResolvedValueOnce(
      Object.values(fixedD1Lock()).map((database) => ({
        name: database.name,
        uuid: database.id === 'admin-id' ? 'replacement-admin-id' : database.id,
      }))
    );
    const token = generateSessionToken();
    const response = await createApiRoutes().request(
      'http://localhost/control/capacity/preview',
      request(token, {
        environmentId: 'test',
        profile: 'recommended',
        scope: 'shared_pool',
        tenantId: null,
      })
    );

    expect(response.status).toBe(500);
    expect(machineAccess.run).not.toHaveBeenCalled();
    expect(capacity.preview).not.toHaveBeenCalled();
    expect(capacity.request).not.toHaveBeenCalled();
  });

  it.each([
    [
      'release',
      {
        releaseUpdate: {
          targetVersion: '0.4.1',
          phase: 'planned' as const,
          manifestChecksum: 'a'.repeat(64),
          startedAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
          appliedTargets: [],
          manualTargets: [],
        },
      },
    ],
    [
      'topology',
      {
        topologyUpdate: {
          kind: 'r2' as const,
          phase: 'pending_deploy' as const,
          targetProductVersion: '0.4.0',
          configChecksum: 'b'.repeat(64),
          authorizationTokenHash: 'c'.repeat(64),
          startedAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
        },
      },
    ],
  ])('fails closed when a %s operation is active', async (_label, patch) => {
    await writeLock({ ...deployedLock(), ...patch });
    const token = generateSessionToken();
    const response = await createApiRoutes().request(
      'http://localhost/control/capacity/request',
      request(token, {
        environmentId: 'test',
        profile: 'recommended',
        scope: 'shared_pool',
        tenantId: null,
      })
    );

    expect(response.status).toBe(500);
    expect(cloudflare.listD1).not.toHaveBeenCalled();
    expect(machineAccess.run).not.toHaveBeenCalled();
    expect(capacity.preview).not.toHaveBeenCalled();
    expect(capacity.request).not.toHaveBeenCalled();
  });

  it('detects a config replacement between planning and lock acquisition before mutation', async () => {
    operationHooks.beforeAcquire.mockImplementationOnce(async () => {
      const changed = createDefaultConfig('test');
      changed.tenant.name = 'changed-after-planning';
      await writeFile(join(root, '.authrim', 'test', 'config.json'), JSON.stringify(changed));
    });
    const token = generateSessionToken();
    const response = await createApiRoutes().request(
      'http://localhost/control/capacity/preview',
      request(token, {
        environmentId: 'test',
        profile: 'minimum',
        scope: 'shared_pool',
        tenantId: null,
      })
    );

    expect(response.status).toBe(500);
    expect(cloudflare.listD1).not.toHaveBeenCalled();
    expect(machineAccess.run).not.toHaveBeenCalled();
    expect(capacity.preview).not.toHaveBeenCalled();
  });

  it('detects a lock replacement between planning and lock acquisition before mutation', async () => {
    operationHooks.beforeAcquire.mockImplementationOnce(async () => {
      await writeLock({ ...deployedLock(), productVersion: '0.4.1' });
    });
    const token = generateSessionToken();
    const response = await createApiRoutes().request(
      'http://localhost/control/capacity/preview',
      request(token, {
        environmentId: 'test',
        profile: 'minimum',
        scope: 'shared_pool',
        tenantId: null,
      })
    );

    expect(response.status).toBe(500);
    expect(cloudflare.listD1).not.toHaveBeenCalled();
    expect(machineAccess.run).not.toHaveBeenCalled();
    expect(capacity.preview).not.toHaveBeenCalled();
  });

  it('returns conflict without mutation when another process owns the environment lock', async () => {
    const competing = await acquireEnvironmentOperationForEnvironment({
      baseDir: root,
      env: 'test',
      operation: 'competing-update',
      requireExisting: true,
    });
    try {
      const token = generateSessionToken();
      const response = await createApiRoutes().request(
        'http://localhost/control/capacity/preview',
        request(token, {
          environmentId: 'test',
          profile: 'minimum',
          scope: 'shared_pool',
          tenantId: null,
        })
      );
      expect(response.status).toBe(409);
    } finally {
      await competing.release();
    }

    expect(cloudflare.listD1).not.toHaveBeenCalled();
    expect(machineAccess.run).not.toHaveBeenCalled();
    expect(capacity.preview).not.toHaveBeenCalled();
  });

  it('releases the environment lock after Control throws', async () => {
    capacity.preview.mockRejectedValueOnce(new Error('control_preview_failed'));
    const token = generateSessionToken();
    const response = await createApiRoutes().request(
      'http://localhost/control/capacity/preview',
      request(token, {
        environmentId: 'test',
        profile: 'minimum',
        scope: 'shared_pool',
        tenantId: null,
      })
    );
    expect(response.status).toBe(500);

    const after = await acquireEnvironmentOperationForEnvironment({
      baseDir: root,
      env: 'test',
      operation: 'after-capacity-failure',
      requireExisting: true,
    });
    await after.release();
  });

  it('releases the environment lock after a successful Control preview', async () => {
    const token = generateSessionToken();
    const response = await createApiRoutes().request(
      'http://localhost/control/capacity/preview',
      request(token, {
        environmentId: 'test',
        profile: 'minimum',
        scope: 'shared_pool',
        tenantId: null,
      })
    );
    expect(response.status).toBe(200);

    const after = await acquireEnvironmentOperationForEnvironment({
      baseDir: root,
      env: 'test',
      operation: 'after-capacity-success',
      requireExisting: true,
    });
    await after.release();
  });

  it('rejects cross-origin and invalid scope-owner requests before calling Control', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const body = {
      environmentId: 'test',
      profile: 'minimum',
      scope: 'shared_pool',
      tenantId: null,
    };
    const crossOrigin = await app.request(
      'http://localhost/control/capacity/preview',
      request(token, body, 'https://attacker.example')
    );
    expect(crossOrigin.status).toBe(403);

    const invalid = await app.request(
      'http://localhost/control/capacity/preview',
      request(token, { ...body, scope: 'tenant_exclusive' })
    );
    expect(invalid.status).toBe(400);
    expect(capacity.preview).not.toHaveBeenCalled();
  });

  it('rejects a concurrent capacity request before creating duplicate machine access', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const body = {
      environmentId: 'test',
      profile: 'recommended',
      scope: 'shared_pool',
      tenantId: null,
    };
    let releaseFirst!: (value: typeof preview) => void;
    capacity.preview
      .mockImplementationOnce(
        () => new Promise<typeof preview>((resolve) => (releaseFirst = resolve))
      )
      .mockResolvedValueOnce(preview);

    const first = app.request('http://localhost/control/capacity/preview', request(token, body));
    await vi.waitFor(() => expect(capacity.preview).toHaveBeenCalledTimes(1));
    const second = app.request('http://localhost/control/capacity/preview', request(token, body));
    const secondResponse = await second;
    expect(capacity.preview).toHaveBeenCalledTimes(1);
    expect(machineAccess.run).toHaveBeenCalledTimes(1);
    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'setup_operation_in_progress',
    });

    releaseFirst(preview);
    await expect(first).resolves.toMatchObject({ status: 200 });
    expect(capacity.preview).toHaveBeenCalledTimes(1);
    expect(machineAccess.run).toHaveBeenCalledTimes(1);
  });
});
