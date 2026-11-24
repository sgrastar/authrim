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
import { adminTenantProvisioningCleanupHandler } from '../admin-tenants';
import { isSingleTenantMode } from '../single-tenant-guard';
import {
  adapters,
  createAdapter,
  createContext,
  createKVNamespace,
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

describe('tenant provisioning cleanup', () => {
  const route = (state = 'reserved') => ({
    allocationId: 'alloc-1',
    tenantId: 'second',
    state,
    target: {
      shardId: 'shard-1',
      dataRole: 'tenant_core/default',
      residencyPolicyId: 'builtin:residency:default',
      residencyPartition: 'default',
      routeGeneration: 3,
      bindingRef: 'DB_TENANT_1',
      databaseId: 'db-id',
      databaseName: 'db-name',
      allocationScope: 'tenant_exclusive',
      ownerTenantId: 'second',
      assignmentGeneration: 1,
    },
  });
  const tenantDb = () => ({ prepare: vi.fn() });

  function setup(op: Record<string, unknown> | null, options: { route?: unknown } = {}) {
    fakes.repo.getByTenant.mockResolvedValue(op);
    fakes.decode.mockReturnValue('route' in options ? options.route : null);
    adapters.defaultAdapter = createAdapter();
    adapters.adminAdapter = createAdapter();
    const tenantAdapter = createAdapter();
    fakes.d1Adapters.set('tenant-provisioning-cleanup:second', tenantAdapter);
    return { platform: adapters.defaultAdapter, admin: adapters.adminAdapter, tenantAdapter };
  }

  it('answers 404 when no operation exists, and 500 without an environment name', async () => {
    setup(null);
    expect((await call(adminTenantProvisioningCleanupHandler, context())).status).toBe(404);
    expect(
      (
        await call(
          adminTenantProvisioningCleanupHandler,
          context({}, { AUTHRIM_ENVIRONMENT_NAME: undefined })
        )
      ).status
    ).toBe(500);
  });

  it.each(['succeeded', 'running'])('refuses to clean up a %s operation', async (status) => {
    const op = operation({ status });
    const { admin } = setup(op);
    const result = await call(adminTenantProvisioningCleanupHandler, context());
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'tenant_provisioning_cleanup_conflict',
      message: 'Running or completed tenant provisioning cannot be cleaned up.',
      provisioning: formatted(op),
    });
    expect(admin.calls).toHaveLength(0);
    expect(fakes.repo.cancel).not.toHaveBeenCalled();
  });

  it.each(['lookup_activate', 'tenant_active'])('refuses once the step is %s', async (step) => {
    const op = operation({ status: 'waiting_retry', currentStep: step });
    setup(op);
    const result = await call(adminTenantProvisioningCleanupHandler, context());
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'tenant_provisioning_cleanup_conflict',
      message:
        'Lookup activation may already be externally visible. Retry provisioning to complete activation.',
      provisioning: formatted(op),
    });
    expect(fakes.repo.cancel).not.toHaveBeenCalled();
  });

  it('refuses, with the current state, when the conditional cancel does not apply', async () => {
    const op = operation({ status: 'blocked', currentStep: 'seed_tenant' });
    const { platform } = setup(op);
    fakes.repo.cancel.mockResolvedValue(null);
    const current = operation({ status: 'running', currentStep: 'registry_publish' });
    fakes.repo.getByTenant.mockResolvedValueOnce(op).mockResolvedValueOnce(current);
    const result = await call(adminTenantProvisioningCleanupHandler, context());
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'tenant_provisioning_cleanup_conflict',
      message:
        'Tenant provisioning changed while cleanup was starting; nothing was removed. Retry provisioning or check its status.',
      provisioning: formatted(current),
    });
    expect(fakes.repo.cancel).toHaveBeenCalledWith(
      'op-1',
      'test',
      expect.any(Number),
      'seed_tenant'
    );
    expect(platform.calls).toHaveLength(0);
    // The operation vanished: no provisioning member.
    fakes.repo.getByTenant.mockReset();
    fakes.repo.getByTenant.mockResolvedValueOnce(op).mockResolvedValueOnce(null);
    const gone = await call(adminTenantProvisioningCleanupHandler, context());
    expect(gone.status).toBe(409);
    expect('provisioning' in gone.body).toBe(false);
  });

  it('cancels, removes the registry artifacts, the draft and the settings, and answers cleaned', async () => {
    const op = operation({ status: 'blocked', currentStep: 'seed_tenant' });
    const { platform, admin } = setup(op);
    fakes.repo.cancel.mockResolvedValue({ ...op, status: 'canceled' });
    const config = createKVNamespace();
    const settings = createKVNamespace();
    const registry = createKVNamespace();
    await config.put('settings:tenant:second:tenant', 'x');
    await config.put('tenant:second', 'x');
    await settings.put('settings:tenant:second:login-ui', 'x');
    await settings.put('settings:tenant:second:email-settings', 'x');
    await settings.put('settings:tenant:other:login-ui', 'keep');
    const env = {
      AUTHRIM_CONFIG: config,
      SETTINGS: settings,
      TENANT_RUNTIME_REGISTRY: registry,
      AUTHRIM_DEPLOYMENT_TARGET: 'edge',
    };
    const result = await call(adminTenantProvisioningCleanupHandler, context({}, env));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'cleaned', tenant_id: 'second', operation_id: 'op-1' });
    expect(admin.calls.map((call) => call.sql)).toEqual([
      'DELETE FROM tenant_database_active_pointers WHERE tenant_id = ?',
      'DELETE FROM tenant_database_registry WHERE tenant_id = ?',
      expect.stringContaining('UPDATE tenant_runtime_registry_snapshots'),
    ]);
    expect(admin.calls.every((call) => call.params[0] === 'second')).toBe(true);
    expect(registry.delete).toHaveBeenCalledWith('runtime:snapshot:edge:second');
    expect(registry.delete).toHaveBeenCalledWith('runtime:generation:edge:second');
    const marked = must(
      platform.calls.find((call) => call.sql.includes("lifecycle_state = 'deleted'"))
    );
    expect(marked.sql).toBe(
      "UPDATE tenants SET lifecycle_state = 'deleted', updated_at = ? WHERE id = ? AND lifecycle_state = 'provisioning'"
    );
    expect(marked.params[1]).toBe('second');
    expect(config.delete).toHaveBeenCalledWith('tenant:second');
    expect(config.delete).toHaveBeenCalledWith('settings:tenant:second:tenant');
    expect(config.delete).toHaveBeenCalledWith('settings:tenant:second:email-settings');
    expect(config.delete).toHaveBeenCalledWith('v1:tenant-exists:second');
    expect(settings.delete).toHaveBeenCalledTimes(2);
    expect(await settings.get('settings:tenant:other:login-ui')).toBe('keep');
    expect(fakes.cloneCleanup).not.toHaveBeenCalled();
    expect(createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'tenant.provisioning_cleanup.succeeded',
      'tenant',
      'second',
      expect.objectContaining({ operation_id: 'op-1', admin_actor_id: 'platform-admin' })
    );
  });

  it('skips the cancel for an already canceled operation, and cleans a clone tenant data too', async () => {
    const op = operation({
      status: 'canceled',
      operationKind: 'clone',
      currentStep: 'seed_tenant',
    });
    setup(op);
    const result = await call(adminTenantProvisioningCleanupHandler, context());
    expect(result.status).toBe(200);
    expect(fakes.repo.cancel).not.toHaveBeenCalled();
    expect(fakes.cloneCleanup).toHaveBeenCalledWith(expect.anything(), 'second');
  });

  it('removes the tenant database draft and its Login UI client, then releases a reserved route', async () => {
    const op = operation({ status: 'canceled', defaultRouteAllocation: {} });
    const { tenantAdapter } = setup(op, { route: route('reserved') });
    const releaseTenantDefaultRoute = vi.fn();
    const result = await call(
      adminTenantProvisioningCleanupHandler,
      context({}, { DB_TENANT_1: tenantDb(), CONTROL: { releaseTenantDefaultRoute } })
    );
    expect(result.status).toBe(200);
    expect(tenantAdapter.calls).toHaveLength(2);
    expect(tenantAdapter.calls[0].sql).toContain('DELETE FROM oauth_clients');
    expect(tenantAdapter.calls[0].sql).toContain("lifecycle_state = 'provisioning'");
    expect(tenantAdapter.calls[0].params).toEqual(['second', 'second']);
    expect(tenantAdapter.calls[1]).toEqual({
      op: 'execute',
      sql: "DELETE FROM tenants WHERE id = ? AND lifecycle_state = 'provisioning'",
      params: ['second'],
    });
    expect(releaseTenantDefaultRoute).toHaveBeenCalledWith({ allocationId: 'alloc-1' });
    expect(fakes.disableAlias).not.toHaveBeenCalled();
  });

  it('does not release a route that was committed or released already', async () => {
    const op = operation({ status: 'canceled', defaultRouteAllocation: {} });
    setup(op, { route: route('committed') });
    const releaseTenantDefaultRoute = vi.fn();
    const result = await call(
      adminTenantProvisioningCleanupHandler,
      context({}, { DB_TENANT_1: tenantDb(), CONTROL: { releaseTenantDefaultRoute } })
    );
    expect(result.status).toBe(200);
    expect(releaseTenantDefaultRoute).not.toHaveBeenCalled();
  });

  it('answers 500 when a reserved route cannot be released, or its binding is missing', async () => {
    const op = operation({ status: 'canceled', defaultRouteAllocation: {} });
    setup(op, { route: route('reserved') });
    const noControl = await call(
      adminTenantProvisioningCleanupHandler,
      context({}, { DB_TENANT_1: tenantDb() })
    );
    expect(noControl.status).toBe(500);
    expect(createAuditLogFromContext).not.toHaveBeenCalled();
    const noBinding = await call(adminTenantProvisioningCleanupHandler, context());
    expect(noBinding.status).toBe(500);
    const notDatabase = await call(
      adminTenantProvisioningCleanupHandler,
      context({}, { DB_TENANT_1: { notPrepare: true } })
    );
    expect(notDatabase.status).toBe(500);
  });

  it('turns the published alias directory off once the registry step succeeded', async () => {
    const op = operation({
      status: 'canceled',
      defaultRouteAllocation: {},
      steps: [
        {
          stepKey: 'registry_publish',
          displayOrder: 5,
          status: 'succeeded',
          attemptCount: 1,
          nextAttemptAt: null,
          lastErrorCode: null,
          observedResourceId: null,
          startedAt: 1,
          completedAt: 2,
          updatedAt: 2,
        },
      ],
    });
    setup(op, { route: route('committed') });
    const env = { DB_TENANT_1: tenantDb() };
    const result = await call(adminTenantProvisioningCleanupHandler, context({}, env));
    expect(result.status).toBe(200);
    expect(fakes.disableAlias).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'second',
      tenantCode: 'second',
      tenantSlug: 'second',
      routeProjection: {
        schemaVersion: 1,
        tenantRouteGeneration: 3,
        residencyPolicyId: 'builtin:residency:default',
        target: {
          dataRole: 'tenant_core/default',
          residencyPartition: 'default',
          shardId: 'shard-1',
          bindingRef: 'DB_TENANT_1',
          requiredBindingRouteGeneration: 3,
        },
      },
    });
  });

  it('does not turn the alias off when the registry step did not succeed or there is no route', async () => {
    const pending = operation({
      status: 'canceled',
      steps: [{ ...operation().steps[0], stepKey: 'registry_publish', status: 'running' }],
    });
    setup(pending, { route: route('committed') });
    await call(adminTenantProvisioningCleanupHandler, context({}, { DB_TENANT_1: tenantDb() }));
    const published = operation({
      status: 'canceled',
      steps: [{ ...operation().steps[0], stepKey: 'registry_publish', status: 'succeeded' }],
    });
    setup(published, { route: null });
    await call(adminTenantProvisioningCleanupHandler, context());
    const wrongStep = operation({
      status: 'canceled',
      steps: [{ ...operation().steps[0], stepKey: 'seed_tenant', status: 'succeeded' }],
    });
    setup(wrongStep, { route: route('committed') });
    await call(adminTenantProvisioningCleanupHandler, context({}, { DB_TENANT_1: tenantDb() }));
    expect(fakes.disableAlias).not.toHaveBeenCalled();
  });

  it('tolerates an alias directory that is already terminal, but not other failures', async () => {
    const published = operation({
      status: 'canceled',
      steps: [{ ...operation().steps[0], stepKey: 'registry_publish', status: 'succeeded' }],
    });
    setup(published, { route: route('committed') });
    fakes.disableAlias.mockRejectedValueOnce(new Error('tenant_alias_lifecycle_terminal'));
    const env = { DB_TENANT_1: tenantDb() };
    expect((await call(adminTenantProvisioningCleanupHandler, context({}, env))).status).toBe(200);
    fakes.disableAlias.mockRejectedValueOnce(new Error('something_else'));
    expect((await call(adminTenantProvisioningCleanupHandler, context({}, env))).status).toBe(500);
    fakes.disableAlias.mockRejectedValueOnce('not an error');
    expect((await call(adminTenantProvisioningCleanupHandler, context({}, env))).status).toBe(500);
  });

  it('answers 500 and keeps the draft when a registry artifact cannot be removed', async () => {
    const { platform, admin } = setup(operation({ status: 'canceled' }));
    admin.execute.mockRejectedValueOnce(new Error('registry cleanup failed'));
    const result = await call(adminTenantProvisioningCleanupHandler, context());
    expect(result.status).toBe(500);
    expect(platform.calls).toHaveLength(0);
    expect(createAuditLogFromContext).not.toHaveBeenCalled();
  });

  it('is refused for a tenant administrator', async () => {
    setup(operation({ status: 'canceled' }));
    expect(
      (
        await call(
          adminTenantProvisioningCleanupHandler,
          context({}, {}, { id: 'second' }, TENANT_ADMIN)
        )
      ).status
    ).toBe(403);
  });
});
