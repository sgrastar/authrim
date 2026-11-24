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
import { adminTenantCreateHandler } from '../admin-tenants';
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

describe('tenant create', () => {
  const body = { id: 'second', name: 'Second Tenant' };

  function platform(
    options: { idTaken?: boolean; codeTaken?: boolean; rowCode?: string; rowMissing?: boolean } = {}
  ) {
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE id = ?') {
        return options.idTaken ? { id: 'second' } : null;
      }
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE tenant_code = ?') {
        return options.codeTaken ? { id: 'other' } : null;
      }
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        if (options.rowMissing) return null;
        return createTenantRow('second', {
          tenant_code: options.rowCode ?? 'second',
          name: 'Second Tenant',
          lifecycle_state: 'provisioning',
        });
      }
      return { rowsAffected: 1 };
    });
    return adapters.defaultAdapter;
  }

  it('creates the operation and the draft, and answers 202 with both', async () => {
    const adapter = platform();
    const created = operation({ requestHash: await requestHashOf(body) });
    fakes.repo.getByTenant.mockResolvedValueOnce(null);
    fakes.repo.create.mockResolvedValue(created);
    const c = context(body, {}, {}, undefined, undefined);
    const result = await call(adminTenantCreateHandler, c);
    expect(result.status).toBe(202);
    expect(result.body).toEqual({
      id: 'second',
      tenant_code: 'second',
      name: 'Second Tenant',
      description: null,
      isolation_policy: 'tenant_exclusive',
      lifecycle_state: 'provisioning',
      is_default: false,
      created_at: 1,
      updated_at: 1,
      provisioning: { mode: 'control-plane', ...formatted(created) },
    });
    const operationId = `tenant_create_${(await sha256Hex('test\0second')).slice(0, 32)}`;
    expect(fakes.repo.getByTenant).toHaveBeenCalledWith('second', 'test');
    expect(fakes.repo.create).toHaveBeenCalledWith({
      operationId,
      environmentId: 'test',
      tenantId: 'second',
      tenantCode: 'second',
      tenantName: 'Second Tenant',
      tenantDescription: null,
      operationKind: 'create',
      sourceTenantId: null,
      preparationPayload: null,
      residencyPolicyId: 'builtin:residency:default',
      residencyPartition: 'default',
      isolationPolicy: 'tenant_exclusive',
      requestHash: await requestHashOf(body),
      idempotencyKey: operationId,
      createdBy: 'platform-admin',
      now: expect.any(Number),
    });
    const insert = must(adapter.calls.find((call) => call.sql.includes('INSERT INTO tenants')));
    expect(insert.sql).toContain('ON CONFLICT(id) DO NOTHING');
    expect(insert.params.slice(0, 2)).toEqual(['second', 'second']);
    expect(insert.params.slice(3, 8)).toEqual([
      'Second Tenant',
      null,
      'tenant_exclusive',
      'provisioning',
      null,
    ]);
    expect(createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'tenant.provisioning_requested',
      'tenant',
      'second',
      expect.objectContaining({
        operation_id: 'op-1',
        tenant_code: 'second',
        isolation_policy: 'tenant_exclusive',
      })
    );
    expect(c.waitUntil).toHaveBeenCalledTimes(1);
    expect(fakes.backupCovered).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: 'second' },
      expect.any(Function)
    );
  });

  it('uses the given code, description, isolation policy, residency profile and idempotency key', async () => {
    platform();
    const input = {
      id: 'second',
      name: 'Second Tenant',
      tenant_code: 'code-2',
      description: 'Desc',
      isolation_policy: 'shared_pool',
    };
    const hash = await requestHashOf({
      id: 'second',
      code: 'code-2',
      name: 'Second Tenant',
      description: 'Desc',
      isolation: 'shared_pool',
      residency: 'eu-profile',
    });
    fakes.repo.getByTenant.mockResolvedValueOnce(null);
    fakes.repo.create.mockResolvedValue(operation({ requestHash: hash, tenantCode: 'code-2' }));
    await call(
      adminTenantCreateHandler,
      context(input, { DEFAULT_RESIDENCY_PROFILE_ID: 'eu-profile' }, {}, undefined, '  my-key.1  ')
    );
    expect(fakes.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantCode: 'code-2',
        tenantDescription: 'Desc',
        isolationPolicy: 'shared_pool',
        residencyPolicyId: 'eu-profile',
        requestHash: hash,
        idempotencyKey: 'my-key.1',
      })
    );
  });

  it('falls back to the derived key when the header is blank, and refuses a malformed key', async () => {
    platform();
    fakes.repo.getByTenant.mockResolvedValue(null);
    fakes.repo.create.mockResolvedValue(operation({ requestHash: await requestHashOf(body) }));
    await call(adminTenantCreateHandler, context(body, {}, {}, undefined, '   '));
    expect(fakes.repo.create.mock.calls[0][0].idempotencyKey).toMatch(
      /^tenant_create_[0-9a-f]{32}$/
    );
    fakes.repo.create.mockClear();
    for (const key of ['-leading', 'has space', 'x'.repeat(129), 'bad/slash']) {
      const result = await call(adminTenantCreateHandler, context(body, {}, {}, undefined, key));
      expect(result.status).toBe(400);
      expect(result.body.details).toEqual({
        variables: { field: 'Idempotency-Key', reason: 'Invalid idempotency key' },
      });
    }
    expect(fakes.repo.create).not.toHaveBeenCalled();
    const longest = 'a'.repeat(128);
    const ok = await call(adminTenantCreateHandler, context(body, {}, {}, undefined, longest));
    expect(ok.status).toBe(202);
  });

  it('refuses a tenant id or code that already exists, creating nothing', async () => {
    fakes.repo.getByTenant.mockResolvedValue(null);
    platform({ idTaken: true });
    const id = await call(adminTenantCreateHandler, context(body));
    expect(id.status).toBe(400);
    expect(id.body.details).toEqual({
      variables: { field: 'id', reason: 'Tenant ID already exists' },
    });
    platform({ codeTaken: true });
    const code = await call(adminTenantCreateHandler, context(body));
    expect(code.body.details).toEqual({
      variables: { field: 'tenant_code', reason: 'Tenant code already exists' },
    });
    expect(fakes.repo.create).not.toHaveBeenCalled();
  });

  it('refuses an invalid body with the first problems joined', async () => {
    platform();
    for (const invalid of [
      {},
      { id: 'Bad_ID', name: 'x' },
      { id: 'platform', name: 'x' },
      { id: 'ok', name: '' },
    ]) {
      const result = await call(adminTenantCreateHandler, context(invalid));
      expect(result.status).toBe(400);
      expect(result.body.details.variables.field).toBe('body');
    }
    const reserved = await call(adminTenantCreateHandler, context({ id: 'platform', name: 'x' }));
    expect(reserved.body.details.variables.reason).toBe('id is reserved');
    expect(fakes.repo.getByTenant).not.toHaveBeenCalled();
  });

  it('answers 500 when the environment name is missing', async () => {
    platform();
    const result = await call(
      adminTenantCreateHandler,
      context(body, { AUTHRIM_ENVIRONMENT_NAME: undefined })
    );
    expect(result.status).toBe(500);
  });

  it('adopts a matching existing operation, restarting it only while it can still run', async () => {
    platform();
    const hash = await requestHashOf(body);
    for (const [status, restarts] of [
      ['queued', 1],
      ['running', 1],
      ['waiting_retry', 1],
      ['blocked', 0],
      ['succeeded', 0],
      ['canceled', 0],
    ] as const) {
      fakes.backupCovered.mockClear();
      fakes.repo.create.mockClear();
      fakes.repo.getByTenant.mockResolvedValue(operation({ requestHash: hash, status }));
      const c = context(body);
      const result = await call(adminTenantCreateHandler, c);
      expect(result.status).toBe(202);
      expect(result.body.provisioning.status).toBe(status);
      expect(c.waitUntil).toHaveBeenCalledTimes(restarts);
      expect(fakes.repo.create).not.toHaveBeenCalled();
    }
  });

  it('re-creates a missing draft row from the operation, active when it already succeeded', async () => {
    const hash = await requestHashOf(body);
    let reads = 0;
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        reads += 1;
        return reads === 1 ? null : createTenantRow('second', { lifecycle_state: 'active' });
      }
      return { rowsAffected: 1 };
    });
    fakes.repo.getByTenant.mockResolvedValue(
      operation({ requestHash: hash, status: 'succeeded', tenantDescription: 'kept' })
    );
    const result = await call(adminTenantCreateHandler, context(body));
    expect(result.status).toBe(202);
    const insert = must(
      adapters.defaultAdapter.calls.find((call) => call.sql.includes('INSERT INTO tenants'))
    );
    expect(insert.params.slice(0, 2)).toEqual(['second', 'second']);
    expect(insert.params.slice(3, 8)).toEqual([
      'Second Tenant',
      'kept',
      'tenant_exclusive',
      'active',
      null,
    ]);
    // A running one is re-created as provisioning.
    reads = 0;
    fakes.repo.getByTenant.mockResolvedValue(operation({ requestHash: hash, status: 'running' }));
    await call(adminTenantCreateHandler, context(body));
    const second = adapters.defaultAdapter.calls.filter((call) =>
      call.sql.includes('INSERT INTO tenants')
    )[1];
    expect(second.params[6]).toBe('provisioning');
  });

  it('answers 500 when the draft row is still missing after being re-created', async () => {
    adapters.defaultAdapter = createAdapter((sql, _params, op) =>
      op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?') ? null : { rowsAffected: 1 }
    );
    fakes.repo.getByTenant.mockResolvedValue(operation({ requestHash: await requestHashOf(body) }));
    expect((await call(adminTenantCreateHandler, context(body))).status).toBe(500);
  });

  it('refuses a request that conflicts with the operation already kept for the tenant', async () => {
    const adapter = platform();
    fakes.repo.getByTenant.mockResolvedValue(operation({ requestHash: 'another-hash' }));
    const result = await call(adminTenantCreateHandler, context(body));
    expect(result.status).toBe(400);
    expect(result.body.details).toEqual({
      variables: {
        field: 'id',
        reason: 'Tenant provisioning request conflicts with existing operation',
      },
    });
    expect(adapter.calls).toHaveLength(0);
  });

  it('settles a concurrent create: adopts a matching one, refuses a different one, rethrows otherwise', async () => {
    platform();
    const hash = await requestHashOf(body);
    fakes.repo.create.mockRejectedValue(new Error('unique violation'));
    fakes.repo.getByTenant
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(operation({ requestHash: hash }));
    const adopted = await call(adminTenantCreateHandler, context(body));
    expect(adopted.status).toBe(202);
    expect(adopted.body.provisioning.operation_id).toBe('op-1');

    fakes.repo.getByTenant.mockReset();
    fakes.repo.getByTenant
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(operation({ requestHash: 'different' }));
    const conflict = await call(adminTenantCreateHandler, context(body));
    expect(conflict.status).toBe(400);
    expect(conflict.body.details.variables.reason).toBe(
      'Tenant provisioning request conflicts with existing operation'
    );

    fakes.repo.getByTenant.mockReset();
    fakes.repo.getByTenant.mockResolvedValue(null);
    expect((await call(adminTenantCreateHandler, context(body))).status).toBe(500);
  });

  it('refuses when the draft row belongs to another tenant code', async () => {
    platform({ rowCode: 'someone-else' });
    fakes.repo.getByTenant.mockResolvedValue(null);
    fakes.repo.create.mockResolvedValue(operation({ requestHash: await requestHashOf(body) }));
    const c = context(body);
    const result = await call(adminTenantCreateHandler, c);
    expect(result.status).toBe(400);
    expect(result.body.details.variables.reason).toBe(
      'Tenant provisioning request conflicts with existing operation'
    );
    expect(c.waitUntil).not.toHaveBeenCalled();
    expect(createAuditLogFromContext).not.toHaveBeenCalled();
  });

  it('answers 500 when the draft row cannot be read after the insert', async () => {
    platform({ rowMissing: true });
    fakes.repo.getByTenant.mockResolvedValue(null);
    fakes.repo.create.mockResolvedValue(operation({ requestHash: await requestHashOf(body) }));
    expect((await call(adminTenantCreateHandler, context(body))).status).toBe(500);
  });

  it('is refused in single-tenant mode and for a tenant administrator', async () => {
    platform();
    vi.mocked(isSingleTenantMode).mockReturnValue(true);
    expect((await call(adminTenantCreateHandler, context(body))).status).toBe(409);
    vi.mocked(isSingleTenantMode).mockReturnValue(false);
    expect((await call(adminTenantCreateHandler, context(body, {}, {}, TENANT_ADMIN))).status).toBe(
      403
    );
    expect(fakes.repo.getByTenant).not.toHaveBeenCalled();
  });
});
