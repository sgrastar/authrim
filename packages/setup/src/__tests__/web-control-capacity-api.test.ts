import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';

const capacity = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  request: vi.fn(),
}));
const machineAccess = vi.hoisted(() => ({
  run: vi.fn((input: { action: () => Promise<unknown> }) => input.action()),
}));
vi.mock('../core/control-capacity-client.js', () => ({
  listSetupExclusiveCapacityTenants: capacity.list,
  previewSetupControlCapacity: capacity.preview,
  requestSetupControlCapacity: capacity.request,
}));
vi.mock('../core/setup-machine-access-lifecycle.js', () => ({
  withEphemeralSetupMachineAccess: machineAccess.run,
}));

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
    await writeFile(
      join(directory, 'lock.json'),
      JSON.stringify({
        version: '1.0.0',
        env: 'test',
        createdAt: '2026-07-30T00:00:00.000Z',
        d1: { CONTROL_DB: { id: 'control-id', name: 'test-control' } },
        kv: {},
      })
    );
    vi.clearAllMocks();
    capacity.list.mockResolvedValue(['tenant-a']);
    capacity.preview.mockResolvedValue(preview);
    capacity.request.mockResolvedValue({ result: { preview, operations: [] }, auditId: 'audit-1' });
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
      controlDatabaseName: 'test-control',
      request: { profile: 'recommended', scope: 'shared_pool', tenantId: null },
    });
    expect(machineAccess.run).toHaveBeenCalledTimes(1);

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

  it('serializes concurrent capacity requests before creating ephemeral machine access', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(capacity.preview).toHaveBeenCalledTimes(1);
    expect(machineAccess.run).toHaveBeenCalledTimes(1);

    releaseFirst(preview);
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(capacity.preview).toHaveBeenCalledTimes(2);
    expect(machineAccess.run).toHaveBeenCalledTimes(2);
  });
});
