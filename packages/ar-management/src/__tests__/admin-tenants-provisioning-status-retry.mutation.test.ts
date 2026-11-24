/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
/**
 * Mutation-focused tests for the tenant provisioning handlers: create (the request hash, the
 * draft row, idempotency), status, retry and cleanup. The operation repository and the saga are
 * fakes; the handler's own SQL, responses and side effects are asserted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stepUp = vi.hoisted(() => ({ gate: vi.fn(async (): Promise<Response | null> => null) }));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp.gate,
  refuseAdminFreshAuth: vi.fn(),
}));

const fakes = vi.hoisted(() => ({
  repo: {
    getByTenant: vi.fn(),
    create: vi.fn(),
    retryBlocked: vi.fn(),
    cancel: vi.fn(),
    claimNext: vi.fn(),
  },
  decode: vi.fn(),
  disableAlias: vi.fn(),
  cloneCleanup: vi.fn(),
  backupCovered: vi.fn(),
  d1Adapters: new Map<string, unknown>(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const harness = await import('./helpers/admin-tenants-mutation-harness');
  return {
    ...harness.buildCoreMock(),
    runTenantBackupCoveredEffect: fakes.backupCovered,
    ensureDatabaseAdapter: vi.fn((db: unknown) => db),
    createD1Adapter: vi.fn((_db: unknown, name: string) => {
      return fakes.d1Adapters.get(name) ?? harness.adapters.defaultAdapter;
    }),
  };
});
vi.mock('../single-tenant-guard', () => ({
  createSingleTenantMutationError: vi.fn(
    () => new Response(JSON.stringify({ error: 'single_tenant_mode' }), { status: 409 })
  ),
  ensureSupportedTenantId: vi.fn(async (): Promise<Response | null> => null),
  getSingleTenantId: vi.fn(() => 'default'),
  isSingleTenantMode: vi.fn(() => false),
}));
vi.mock('../tenant-region-shard-policy', () => ({
  ensureTenantProvisioningRegionShardConfig: vi.fn(),
}));
vi.mock('../tenant-provisioning-operation', () => ({
  TenantProvisioningOperationRepository: vi.fn().mockImplementation(function MockRepository() {
    return fakes.repo;
  }),
}));
vi.mock('../tenant-provisioning-orchestrator', () => ({
  decodeTenantProvisioningRoute: fakes.decode,
  runTenantProvisioningSaga: vi.fn(),
}));
vi.mock('../tenant-alias-directory', () => ({
  activateTenantAliasDirectory: vi.fn(),
  disableTenantAliasDirectory: fakes.disableAlias,
  prepareTenantAliasDirectory: vi.fn(),
}));
vi.mock('../admin-tenant-clone', () => ({
  cleanupTenantCloneKvArtifacts: fakes.cloneCleanup,
  prepareTenantCloneForProvisioning: vi.fn(),
}));

import { createAuditLogFromContext } from '@authrim/ar-lib-core';
import {
  adminTenantCreateHandler,
  adminTenantProvisioningCleanupHandler,
  adminTenantProvisioningRetryHandler,
  adminTenantProvisioningStatusHandler,
} from '../admin-tenants';
import { isSingleTenantMode } from '../single-tenant-guard';
import {
  adapters,
  createAdapter,
  createContext,
  createTenantRow,
} from './helpers/admin-tenants-mutation-harness';
import { must } from './helpers/must';

type Handler = (c: never) => Promise<Response>;

const TENANT_ADMIN = {
  userId: 'tenant-admin',
  roles: ['ar_tenant_admin'],
  globalRoles: [],
  tenantScope: ['tenant-a'],
  permissions: [],
};

const sha256Hex = async (value: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');

const requestHashOf = (input: Record<string, unknown>) =>
  sha256Hex(
    JSON.stringify({
      tenantId: input.id,
      tenantCode: input.code ?? input.id,
      name: input.name,
      description: input.description ?? null,
      operationKind: 'create',
      sourceTenantId: null,
      preparationPayload: null,
      residencyPolicyId: input.residency ?? 'builtin:residency:default',
      residencyPartition: 'default',
      isolationPolicy: input.isolation ?? 'tenant_exclusive',
    })
  );

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'op-1',
    environmentId: 'test',
    tenantId: 'second',
    tenantCode: 'second',
    tenantName: 'Second Tenant',
    tenantDescription: null,
    operationKind: 'create',
    sourceTenantId: null,
    preparationPayload: null,
    preparationResult: null,
    residencyPolicyId: 'builtin:residency:default',
    residencyPartition: 'default',
    isolationPolicy: 'tenant_exclusive',
    requestHash: 'hash',
    idempotencyKey: 'key',
    status: 'queued',
    currentStep: 'request_accepted',
    capacityOperationIds: {},
    defaultRouteAllocation: null,
    attemptCount: 2,
    retryBudgetStartedAt: 1,
    nextAttemptAt: 50,
    lastErrorCode: 'some_error',
    fencingToken: 1,
    createdBy: 'platform-admin',
    createdAt: 10,
    startedAt: 11,
    completedAt: null,
    updatedAt: 12,
    steps: [
      {
        stepKey: 'request_accepted',
        displayOrder: 1,
        status: 'succeeded',
        attemptCount: 1,
        nextAttemptAt: null,
        lastErrorCode: null,
        observedResourceId: 'res-1',
        startedAt: 10,
        completedAt: 11,
        updatedAt: 11,
      },
    ],
    ...overrides,
  };
}

const formatted = (op: ReturnType<typeof operation>) => ({
  operation_id: op.operationId,
  tenant_id: op.tenantId,
  operation_kind: op.operationKind,
  source_tenant_id: op.sourceTenantId,
  isolation_policy: op.isolationPolicy,
  status: op.status,
  current_step: op.currentStep,
  attempt_count: op.attemptCount,
  next_attempt_at: op.nextAttemptAt,
  last_error_code: op.lastErrorCode,
  created_at: op.createdAt,
  updated_at: op.updatedAt,
  completed_at: op.completedAt,
  preparation_result: op.preparationResult,
  capacity_operation_ids: op.capacityOperationIds,
  steps: [
    {
      step_key: 'request_accepted',
      status: 'succeeded',
      attempt_count: 1,
      next_attempt_at: null,
      last_error_code: null,
      observed_resource_id: 'res-1',
      started_at: 10,
      completed_at: 11,
      updated_at: 11,
    },
  ],
});

function context(
  body: Record<string, unknown> = {},
  env: Record<string, unknown> = {},
  params: Record<string, string> = { id: 'second' },
  auth?: Record<string, unknown>,
  header?: string | null
) {
  const c = createContext(body, env, params, auth);
  if (header !== null) c.req.header = vi.fn(() => header);
  const waitUntil = vi.fn();
  c.executionCtx = { waitUntil };
  return Object.assign(c, { waitUntil });
}

async function call(handler: unknown, c: ReturnType<typeof context>) {
  const response = await (handler as Handler)(c as never);
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body };
}

beforeEach(() => {
  adapters.defaultAdapter = null;
  adapters.tenantAdapters.clear();
  adapters.adminAdapter = null;
  adapters.lifecycleJobsAdapter = null;
  fakes.d1Adapters.clear();
  vi.clearAllMocks();
  fakes.repo.getByTenant.mockReset();
  fakes.repo.create.mockReset();
  fakes.repo.retryBlocked.mockReset();
  fakes.repo.cancel.mockReset();
  fakes.decode.mockReset();
  fakes.disableAlias.mockReset();
  fakes.cloneCleanup.mockReset();
  fakes.backupCovered.mockReset();
  fakes.backupCovered.mockReturnValue(Promise.resolve());
  vi.mocked(isSingleTenantMode).mockReturnValue(false);
  stepUp.gate.mockResolvedValue(null);
  adapters.adminAdapter = createAdapter();
});

describe('tenant provisioning status', () => {
  it('requires the environment name, and answers 404 for an unknown operation', async () => {
    await expect(
      call(
        adminTenantProvisioningStatusHandler,
        context({}, { AUTHRIM_ENVIRONMENT_NAME: undefined })
      )
    ).rejects.toThrow('tenant_provisioning_environment_missing');
    fakes.repo.getByTenant.mockResolvedValue(null);
    const result = await call(adminTenantProvisioningStatusHandler, context());
    expect(result.status).toBe(404);
    expect(result.body.details).toEqual({
      variables: { resource: 'tenant_provisioning_operation', id: 'second' },
    });
    expect(fakes.repo.getByTenant).toHaveBeenCalledWith('second', 'test');
  });

  it('answers the operation and nudges it only while it can still run', async () => {
    for (const [status, nudged] of [
      ['queued', 1],
      ['waiting_retry', 1],
      ['running', 1],
      ['blocked', 0],
      ['succeeded', 0],
      ['canceled', 0],
    ] as const) {
      const op = operation({ status });
      fakes.repo.getByTenant.mockResolvedValue(op);
      const c = context();
      const result = await call(adminTenantProvisioningStatusHandler, c);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ...formatted(op), capacity_operations: [] });
      expect(c.waitUntil).toHaveBeenCalledTimes(nudged);
    }
  });

  it('adds the capacity operations Control still knows, skipping unknown and failing ones', async () => {
    fakes.repo.getByTenant.mockResolvedValue(
      operation({
        capacityOperationIds: {
          'tenant_core/default': 'cap-1',
          tenant_pii: 'cap-2',
          'tenant_core/users': 'cap-3',
        },
      })
    );
    const getProvisioningOperation = vi.fn(async (id: string) => {
      if (id === 'cap-2') return null;
      if (id === 'cap-3') throw new Error('control down');
      return {
        operationId: 'cap-1',
        status: 'running',
        attemptCount: 3,
        nextAttemptAt: 99,
        lastErrorCode: null,
        updatedAt: 77,
        steps: [
          {
            stepKey: 'create_database',
            status: 'running',
            attemptCount: 1,
            nextAttemptAt: null,
            lastErrorCode: null,
            observedResourceId: 'db-1',
            progressCurrent: 2,
            progressTotal: 5,
            startedAt: 70,
            completedAt: null,
            updatedAt: 71,
          },
        ],
      };
    });
    const result = await call(
      adminTenantProvisioningStatusHandler,
      context({}, { CONTROL: { getProvisioningOperation } })
    );
    expect(result.body.capacity_operations).toEqual([
      {
        data_role: 'tenant_core/default',
        operation_id: 'cap-1',
        status: 'running',
        attempt_count: 3,
        next_attempt_at: 99,
        last_error_code: null,
        updated_at: 77,
        steps: [
          {
            step_key: 'create_database',
            status: 'running',
            attempt_count: 1,
            next_attempt_at: null,
            last_error_code: null,
            observed_resource_id: 'db-1',
            progress_current: 2,
            progress_total: 5,
            started_at: 70,
            completed_at: null,
            updated_at: 71,
          },
        ],
      },
    ]);
    expect(getProvisioningOperation).toHaveBeenCalledTimes(3);
  });

  it('is refused for a tenant administrator', async () => {
    expect(
      (
        await call(
          adminTenantProvisioningStatusHandler,
          context({}, {}, { id: 'second' }, TENANT_ADMIN)
        )
      ).status
    ).toBe(403);
  });
});

describe('tenant provisioning retry', () => {
  it('answers 404 when no operation exists', async () => {
    fakes.repo.getByTenant.mockResolvedValue(null);
    const result = await call(adminTenantProvisioningRetryHandler, context());
    expect(result.status).toBe(404);
    expect(result.body.details).toEqual({
      variables: { resource: 'tenant_provisioning_operation', id: 'second' },
    });
  });

  it('answers 500 without an environment name', async () => {
    expect(
      (
        await call(
          adminTenantProvisioningRetryHandler,
          context({}, { AUTHRIM_ENVIRONMENT_NAME: undefined })
        )
      ).status
    ).toBe(500);
  });

  it.each(['queued', 'running', 'waiting_retry', 'succeeded', 'canceled'])(
    'refuses to retry an operation that is %s',
    async (status) => {
      const op = operation({ status });
      fakes.repo.getByTenant.mockResolvedValue(op);
      const result = await call(adminTenantProvisioningRetryHandler, context());
      expect(result.status).toBe(409);
      expect(result.body).toEqual({
        error: 'tenant_provisioning_not_blocked',
        message: 'Tenant provisioning is not waiting for an administrator retry.',
        provisioning: formatted(op),
      });
      expect(fakes.repo.retryBlocked).not.toHaveBeenCalled();
    }
  );

  it('re-queues a blocked operation, starts it and audits the actor', async () => {
    fakes.repo.getByTenant.mockResolvedValue(operation({ status: 'blocked' }));
    const retried = operation({ operationId: 'op-retried', status: 'queued' });
    fakes.repo.retryBlocked.mockResolvedValue(retried);
    const c = context();
    const result = await call(adminTenantProvisioningRetryHandler, c);
    expect(result.status).toBe(202);
    expect(result.body).toEqual(formatted(retried));
    expect(fakes.repo.retryBlocked).toHaveBeenCalledWith('op-1', 'test', expect.any(Number));
    expect(c.waitUntil).toHaveBeenCalledTimes(1);
    expect(createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'tenant.provisioning_retry.requested',
      'tenant',
      'second',
      expect.objectContaining({ operation_id: 'op-retried', admin_actor_id: 'platform-admin' })
    );
  });

  it('answers 500 when the operation changed under the retry', async () => {
    fakes.repo.getByTenant.mockResolvedValue(operation({ status: 'blocked' }));
    fakes.repo.retryBlocked.mockResolvedValue(null);
    const c = context();
    expect((await call(adminTenantProvisioningRetryHandler, c)).status).toBe(500);
    expect(c.waitUntil).not.toHaveBeenCalled();
    expect(createAuditLogFromContext).not.toHaveBeenCalled();
  });
});

describe('tenant provisioning: background processing and edge cases', () => {
  const body = { id: 'second', name: 'Second Tenant' };

  /** Run what the handler handed to the backup-covered effect, as a worker would. */
  function runBackground() {
    fakes.backupCovered.mockImplementation(
      async (_env: unknown, _scope: unknown, work: () => Promise<unknown>) => work()
    );
    fakes.repo.claimNext.mockReset();
    fakes.repo.claimNext.mockResolvedValue(null);
  }
  const pending = (c: ReturnType<typeof context>) =>
    c.waitUntil.mock.calls[0][0] as Promise<unknown>;

  function platform(rowOverrides: Record<string, unknown> = {}) {
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && /^SELECT id FROM tenants/.test(sql)) return null;
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return createTenantRow('second', { lifecycle_state: 'provisioning', ...rowOverrides });
      }
      return { rowsAffected: 1 };
    });
  }

  it('processes the next operation in the background after a create, an adoption, a status read and a retry', async () => {
    runBackground();
    platform();
    const hash = await requestHashOf(body);
    fakes.repo.getByTenant.mockResolvedValueOnce(null);
    fakes.repo.create.mockResolvedValue(operation({ requestHash: hash }));
    const created = context(body);
    await call(adminTenantCreateHandler, created);
    await pending(created);
    expect(fakes.repo.claimNext).toHaveBeenCalledWith(
      'test',
      expect.stringMatching(/^management:/),
      expect.any(Number)
    );

    fakes.repo.claimNext.mockClear();
    fakes.repo.getByTenant.mockResolvedValue(operation({ requestHash: hash, status: 'running' }));
    const adopted = context(body);
    await call(adminTenantCreateHandler, adopted);
    await pending(adopted);
    expect(fakes.repo.claimNext).toHaveBeenCalledTimes(1);

    fakes.repo.claimNext.mockClear();
    const status = context();
    await call(adminTenantProvisioningStatusHandler, status);
    await pending(status);
    expect(fakes.repo.claimNext).toHaveBeenCalledTimes(1);

    fakes.repo.claimNext.mockClear();
    fakes.repo.getByTenant.mockResolvedValue(operation({ status: 'blocked' }));
    fakes.repo.retryBlocked.mockResolvedValue(operation());
    const retry = context();
    await call(adminTenantProvisioningRetryHandler, retry);
    await pending(retry);
    expect(fakes.repo.claimNext).toHaveBeenCalledTimes(1);
  });

  it('records the draft of a concurrently created operation as active when it already succeeded', async () => {
    platform();
    const hash = await requestHashOf(body);
    fakes.repo.create.mockRejectedValue(new Error('unique violation'));
    fakes.repo.getByTenant
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(operation({ requestHash: hash, status: 'succeeded' }));
    const result = await call(adminTenantCreateHandler, context(body));
    expect(result.status).toBe(202);
    const insert = must(
      must(adapters.defaultAdapter).calls.find((entry) => entry.sql.includes('INSERT INTO tenants'))
    );
    expect(insert.params[6]).toBe('active');
  });

  it('records unknown as the creator when the caller has no identity', async () => {
    platform();
    fakes.repo.getByTenant.mockResolvedValueOnce(null);
    fakes.repo.create.mockResolvedValue(operation({ requestHash: await requestHashOf(body) }));
    await call(
      adminTenantCreateHandler,
      context(
        body,
        {},
        {},
        {
          roles: ['ar_super_admin'],
          globalRoles: ['ar_super_admin'],
          tenantScope: ['*'],
          permissions: [],
        }
      )
    );
    expect(fakes.repo.create.mock.calls[0][0].createdBy).toBe('unknown');
  });

  it('cleans the settings KV page by page, in batches of 25 deletes, and works without one', async () => {
    const op = operation({ status: 'canceled', defaultRouteAllocation: null });
    fakes.repo.getByTenant.mockResolvedValue(op);
    fakes.decode.mockReturnValue(null);
    adapters.defaultAdapter = createAdapter();
    adapters.adminAdapter = createAdapter();
    const names = Array.from({ length: 60 }, (_, i) => `settings:tenant:second:k${i}`);
    const pages = [
      { keys: names.slice(0, 30).map((name) => ({ name })), list_complete: false, cursor: 'c1' },
      { keys: names.slice(30).map((name) => ({ name })), list_complete: true },
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    const settings = {
      list: vi.fn(async () => pages.shift()),
      delete: vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
      }),
      get: vi.fn(),
      put: vi.fn(),
    };
    const result = await call(
      adminTenantProvisioningCleanupHandler,
      context({}, { SETTINGS: settings })
    );
    expect(result.status).toBe(200);
    expect(settings.list.mock.calls).toEqual([
      [{ prefix: 'settings:tenant:second:', cursor: undefined, limit: 1000 }],
      [{ prefix: 'settings:tenant:second:', cursor: 'c1', limit: 1000 }],
    ]);
    expect(settings.delete).toHaveBeenCalledTimes(60);
    expect(maxInFlight).toBe(25);
    const without = await call(
      adminTenantProvisioningCleanupHandler,
      context({}, { SETTINGS: undefined })
    );
    expect(without.status).toBe(200);
  });

  it('stops retry and cleanup at the single-tenant guard', async () => {
    const { ensureSupportedTenantId } = await import('../single-tenant-guard');
    vi.mocked(ensureSupportedTenantId).mockImplementation(
      async () => new Response('{"e":1}', { status: 409 })
    );
    try {
      expect((await call(adminTenantProvisioningRetryHandler, context())).status).toBe(409);
      expect((await call(adminTenantProvisioningCleanupHandler, context())).status).toBe(409);
      expect(fakes.repo.getByTenant).not.toHaveBeenCalled();
    } finally {
      vi.mocked(ensureSupportedTenantId).mockResolvedValue(null);
    }
  });

  it('refuses a retry for a tenant administrator', async () => {
    const result = await call(
      adminTenantProvisioningRetryHandler,
      context({}, {}, { id: 'second' }, TENANT_ADMIN)
    );
    expect(result.status).toBe(403);
    expect(fakes.repo.getByTenant).not.toHaveBeenCalled();
  });
});
