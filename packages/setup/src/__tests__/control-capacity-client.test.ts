import { beforeEach, describe, expect, it, vi } from 'vitest';

const token = vi.hoisted(() => vi.fn());
vi.mock('../core/admin-machine-access.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/admin-machine-access.js')>();
  return { ...actual, requestAdminMachineAccessToken: token };
});

import {
  listSetupExclusiveCapacityTenants,
  previewSetupControlCapacity,
  requestSetupControlCapacity,
  retrySetupControlOperationStep,
} from '../core/control-capacity-client.js';

const request = { profile: 'recommended', scope: 'shared_pool', tenantId: null } as const;
const preview = {
  dryRun: true,
  ...request,
  available: true,
  reasonCode: null,
  capacityUnitsAdded: 1,
  d1DatabasesAdded: 1,
  projectedEnvironmentD1Count: 11,
  targets: [
    {
      unitKey: 'residency-default:jp:tenant_core/users',
      unitIndex: 1,
      workerScripts: ['test-ar-auth'],
      operationId: 'capacity-operation-1',
      environmentId: 'test',
      dataRole: 'tenant_core/users',
      residencyPolicyId: 'residency-default',
      residencyPartition: 'jp',
      logicalShardId: 'users:jp:capacity-1',
      databaseName: 'authrim-test-users-jp-capacity-1',
      bindingRef: 'TDB_USERS_CAPACITY_1_CORE',
      readReplicationMode: 'disabled',
      migrationStreamId: 'd1-core',
    },
  ],
} as const;

describe('setup Control capacity client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    token.mockResolvedValue({
      accessToken: 'ephemeral-machine-token',
      tokenType: 'Bearer',
      expiresIn: 600,
      scope: 'admin:control_plane:read',
    });
  });

  it('uses read-only machine authority for a secret-free preview', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ preview })));
    await expect(
      previewSetupControlCapacity({
        apiBaseUrl: 'https://api.example.test',
        keysDir: '/keys',
        request,
        fetch,
      })
    ).resolves.toEqual(preview);
    expect(token).toHaveBeenCalledWith({
      apiBaseUrl: 'https://api.example.test',
      keysDir: '/keys',
      scopes: ['admin:control_plane:read'],
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.example.test/api/admin/platform/control-plane/capacity/preview');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer ephemeral-machine-token' });
    expect(init?.headers).not.toHaveProperty('Idempotency-Key');
  });

  it('uses provision-only authority and an idempotency header for mutation', async () => {
    const operation = {
      operationId: 'capacity-operation-1',
      status: 'blocked',
      attemptCount: 0,
      nextAttemptAt: null,
      lastErrorCode: 'operator_action_required',
      createdAt: 1_800_000_000,
      updatedAt: 1_800_000_000,
    } as const;
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ result: { preview, operations: [operation] }, auditId: 'audit-1' })
        )
    );
    await expect(
      requestSetupControlCapacity({
        apiBaseUrl: 'https://api.example.test/',
        keysDir: '/keys',
        request,
        fetch,
      })
    ).resolves.toEqual({ result: { preview, operations: [operation] }, auditId: 'audit-1' });
    expect(token).toHaveBeenCalledWith({
      apiBaseUrl: 'https://api.example.test/',
      keysDir: '/keys',
      scopes: ['admin:control_plane:provision'],
    });
    const [, init] = fetch.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer ephemeral-machine-token',
      'Idempotency-Key': expect.stringMatching(/^setup-capacity-/u),
    });
  });

  it('uses the setup machine to audit and retry a rejected binding step', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            operation: { operationId: 'operation-1', status: 'running' },
            auditId: 'audit-retry-1',
          })
        )
    );

    await expect(
      retrySetupControlOperationStep({
        apiBaseUrl: 'https://api.example.test',
        keysDir: '/keys',
        operationId: 'operation-1',
        stepKey: 'reconcile_worker_bindings',
        fetch,
      })
    ).resolves.toBeUndefined();
    expect(token).toHaveBeenCalledWith({
      apiBaseUrl: 'https://api.example.test',
      keysDir: '/keys',
      scopes: ['admin:control_plane:provision'],
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://api.example.test/api/admin/platform/control-plane/operations/operation-1/retry-step'
    );
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer ephemeral-machine-token',
      'Idempotency-Key': expect.stringMatching(/^setup-retry-/u),
    });
    expect(JSON.parse(String(init?.body))).toEqual({ stepKey: 'reconcile_worker_bindings' });
  });

  it('rejects cross-scope input and malformed or secret-bearing responses', async () => {
    await expect(
      previewSetupControlCapacity({
        apiBaseUrl: 'https://api.example.test',
        keysDir: '/keys',
        request: { profile: 'minimum', scope: 'tenant_exclusive', tenantId: null },
        fetch: vi.fn(),
      })
    ).rejects.toThrow('control_capacity_request_invalid');
    expect(token).not.toHaveBeenCalled();

    await expect(
      previewSetupControlCapacity({
        apiBaseUrl: 'https://api.example.test',
        keysDir: '/keys',
        request,
        fetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ preview: { ...preview, apiToken: 'forbidden' } }))
        ),
      })
    ).rejects.toThrow('control_capacity_preview_invalid');
  });

  it('lists only active dedicated tenant IDs from the environment-scoped Control DB', async () => {
    const query = vi.fn(async () => [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }]);
    await expect(
      listSetupExclusiveCapacityTenants({
        controlDatabaseName: 'test-control',
        environmentId: 'test',
        query,
      })
    ).resolves.toEqual(['tenant-a', 'tenant-b']);
    expect(query.mock.calls[0]?.[1]).toContain("isolation_policy = 'tenant_exclusive'");
    expect(query.mock.calls[0]?.[1]).toContain("environment_id = 'test'");

    await expect(
      listSetupExclusiveCapacityTenants({
        controlDatabaseName: 'test-control',
        environmentId: '../test',
        query,
      })
    ).rejects.toThrow('control_capacity_tenant_list_invalid');
  });
});
