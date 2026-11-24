/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
/**
 * Mutation-focused tests for the tenant lifecycle commands (suspend, resume, freeze, unfreeze,
 * restore-validate), their transition table and idempotency, the validation job list and retry,
 * and the continuation of a failed deletion.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stepUp = vi.hoisted(() => ({ gate: vi.fn(async (): Promise<Response | null> => null) }));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp.gate,
  refuseAdminFreshAuth: vi.fn(),
}));
const fakes = vi.hoisted(() => ({
  needsCancel: vi.fn(async (): Promise<boolean> => false),
  chainId: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock('@authrim/ar-lib-core', async () =>
  (await import('./helpers/admin-tenants-mutation-harness')).buildCoreMock()
);
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
vi.mock('../tenant-deletion-reactivation-guard', () => ({
  failedTenantDeletionNeedsCancel: fakes.needsCancel,
}));
vi.mock('../tenant-deletion-chain', () => ({
  resolveTenantDeletionChainOperationId: fakes.chainId,
}));

import {} from '@authrim/ar-lib-core';
import {
  adminTenantFreezeHandler,
  adminTenantResumeHandler,
  adminTenantRestoreValidateHandler,
  adminTenantSuspendHandler,
  adminTenantUnfreezeHandler,
  validateTenantLifecycleTransition,
} from '../admin-tenants';
import { ensureSupportedTenantId } from '../single-tenant-guard';
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
  tenantScope: ['second'],
  permissions: [],
};
const BREAK_GLASS_ADMIN = {
  userId: 'platform-admin',
  roles: ['ar_super_admin'],
  globalRoles: ['ar_super_admin'],
  tenantScope: ['*'],
  permissions: ['admin:tenants:lifecycle:break_glass'],
};

function context(
  body: Record<string, unknown>,
  options: {
    key?: string | null;
    auth?: Record<string, unknown>;
    env?: Record<string, unknown>;
  } = {}
) {
  const c = createContext(body, options.env ?? {}, { id: 'second', jobId: 'job-1' }, options.auth);
  const key = 'key' in options ? options.key : 'key-1';
  c.req.header = vi.fn((name: string) =>
    name.toLowerCase() === 'idempotency-key' ? key : undefined
  );
  return c;
}

async function call(handler: unknown, c: unknown) {
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

interface Setup {
  tenant?: object | null;
  jobsStoreJob?: Record<string, unknown> | null;
  inventoryJob?: Record<string, unknown> | null;
  updateRows?: number;
  deleting?: boolean;
  insertError?: Error;
  moveBackRows?: number;
  moveBackError?: boolean;
  current?: Record<string, unknown> | null | 'throw';
}

function setup(options: Setup = {}) {
  const tenant =
    'tenant' in options
      ? options.tenant
      : createTenantRow('second', { lifecycle_state: 'active', updated_at: 10 });
  adapters.defaultAdapter = createAdapter((sql, _params, op) => {
    if (op === 'queryOne' && sql.startsWith('SELECT 1 AS found'))
      return options.deleting ? { found: 1 } : null;
    if (op === 'queryOne' && sql.includes('FROM admin_jobs')) return options.inventoryJob ?? null;
    if (
      op === 'queryOne' &&
      sql === 'SELECT lifecycle_state, updated_at FROM tenants WHERE id = ?'
    ) {
      if (options.current === 'throw') throw new Error('read failed');
      return options.current ?? null;
    }
    if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) return tenant;
    if (op === 'execute' && sql.includes('UPDATE tenants SET lifecycle_state = ?')) {
      const isMoveBack =
        !sql.includes('NOT EXISTS') &&
        must(adapters.defaultAdapter).calls.filter((c) => c.op === 'execute').length > 1;
      if (isMoveBack) {
        if (options.moveBackError) throw new Error('move back failed');
        return { rowsAffected: options.moveBackRows ?? 1 };
      }
      return { rowsAffected: options.updateRows ?? 1 };
    }
    return null;
  });
  adapters.lifecycleJobsAdapter = createAdapter((sql, _params, op) => {
    if (op === 'queryOne' && sql.includes('FROM admin_jobs')) return options.jobsStoreJob ?? null;
    if (op === 'execute' && sql.includes('INSERT INTO admin_jobs') && options.insertError) {
      throw options.insertError;
    }
    return { rowsAffected: 1 };
  });
  return { platform: adapters.defaultAdapter, jobs: adapters.lifecycleJobsAdapter };
}

const stateBody = (extra: Record<string, unknown> = {}) => ({
  expected_state: 'active',
  expected_updated_at: 10,
  reason: 'planned maintenance',
  ...extra,
});

beforeEach(() => {
  adapters.defaultAdapter = null;
  adapters.tenantAdapters.clear();
  adapters.adminAdapter = null;
  adapters.lifecycleJobsAdapter = null;
  vi.clearAllMocks();
  fakes.needsCancel.mockReset();
  fakes.needsCancel.mockResolvedValue(false);
  fakes.chainId.mockReset();
  fakes.chainId.mockResolvedValue(null);
  vi.mocked(ensureSupportedTenantId).mockResolvedValue(null);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

describe('validateTenantLifecycleTransition', () => {
  it.each([
    ['suspend', 'active', 'suspended', false],
    ['resume', 'suspended', 'active', true],
    ['freeze', 'active', 'frozen', false],
    ['freeze', 'migration_read_only', 'frozen', false],
    ['unfreeze', 'frozen', 'active', true],
    ['restore-validate', 'restore_pending', 'restore_validating', true],
    ['restore-validate', 'restore_validating', 'restore_validating', true],
  ] as const)('%s from %s goes to %s (async %s)', (command, from, to, async) => {
    expect(validateTenantLifecycleTransition(command, from)).toEqual({ targetState: to, async });
  });

  it.each([
    ['suspend', 'frozen'],
    ['resume', 'active'],
    ['freeze', 'suspended'],
    ['unfreeze', 'active'],
    ['restore-validate', 'active'],
    ['suspend', 'deleting'],
  ] as const)('refuses %s from %s without break glass', (command, from) => {
    expect(() => validateTenantLifecycleTransition(command, from)).toThrow(
      `Invalid lifecycle transition: ${from} -> ${command}`
    );
  });

  it.each([
    ['suspend', 'frozen', 'suspended', false],
    ['freeze', 'suspended', 'frozen', false],
    ['restore-validate', 'active', 'restore_validating', true],
    ['resume', 'frozen', 'active', true],
    ['unfreeze', 'suspended', 'active', true],
  ] as const)('break glass lets %s from %s reach %s (async %s)', (command, from, to, async) => {
    expect(validateTenantLifecycleTransition(command, from, true)).toEqual({
      targetState: to,
      async,
    });
  });

  it.each(['deleted', 'deleting', 'provisioning'] as const)(
    'break glass never moves a %s tenant',
    (from) => {
      expect(() => validateTenantLifecycleTransition('resume', from, true)).toThrow(
        `Invalid lifecycle transition: ${from} -> resume`
      );
    }
  );
});

describe('lifecycle command: request checks', () => {
  it('is refused for a tenant administrator and by the single-tenant guard', async () => {
    const { platform } = setup();
    expect(
      (await call(adminTenantSuspendHandler, context(stateBody(), { auth: TENANT_ADMIN }))).status
    ).toBe(403);
    vi.mocked(ensureSupportedTenantId).mockResolvedValue(new Response('{"e":1}', { status: 409 }));
    expect((await call(adminTenantSuspendHandler, context(stateBody()))).status).toBe(409);
    expect(platform.calls).toHaveLength(0);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['blank', '   '],
    ['201 characters', 'k'.repeat(201)],
  ])('refuses a request with an Idempotency-Key that is %s', async (_name, key) => {
    const { platform } = setup();
    const result = await call(
      adminTenantSuspendHandler,
      context(stateBody(), { key: key as never })
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: 'invalid_request',
      error_description: 'A valid Idempotency-Key header is required',
    });
    expect(platform.calls).toHaveLength(0);
  });

  it('accepts a 200 character key, trimmed', async () => {
    const { platform } = setup();
    const result = await call(
      adminTenantSuspendHandler,
      context(stateBody(), { key: ` ${'k'.repeat(200)} ` })
    );
    expect(result.status).toBe(200);
    expect(platform.calls[0].params).toEqual(['second', 'k'.repeat(200)]);
  });

  it.each([
    [{ ...stateBody(), expected_state: 'gone' }, 'Invalid enum value'],
    [{ ...stateBody(), expected_updated_at: -1 }, 'Number must be greater than or equal to 0'],
    [{ ...stateBody(), expected_updated_at: 1.5 }, 'Expected integer'],
    [{ ...stateBody(), reason: 'no' }, 'String must contain at least 3 character(s)'],
    [{ ...stateBody(), reason: '  ab  ' }, 'String must contain at least 3 character(s)'],
    [{ ...stateBody(), reason: 'r'.repeat(1001) }, 'String must contain at most 1000 character(s)'],
  ])('refuses an invalid body %#', async (body, message) => {
    const { platform } = setup();
    const result = await call(adminTenantSuspendHandler, context(body));
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_request');
    expect(result.body.error_description).toContain(message);
    expect(platform.calls).toHaveLength(0);
  });

  it('accepts reasons of 3 and 1000 characters', async () => {
    setup();
    expect(
      (await call(adminTenantSuspendHandler, context(stateBody({ reason: 'abc' })))).status
    ).toBe(200);
    setup();
    expect(
      (await call(adminTenantSuspendHandler, context(stateBody({ reason: 'r'.repeat(1000) }))))
        .status
    ).toBe(200);
  });

  it('treats an administrator without a permission list as holding no break-glass permission', async () => {
    const { platform } = setup();
    const result = await call(
      adminTenantSuspendHandler,
      context(stateBody({ break_glass: true }), {
        auth: {
          userId: 'p',
          roles: ['ar_super_admin'],
          globalRoles: ['ar_super_admin'],
          tenantScope: ['*'],
        },
      })
    );
    expect(result.status).toBe(403);
    expect(platform.calls).toHaveLength(0);
  });

  it('needs the break-glass permission for a break-glass request', async () => {
    const { platform } = setup({
      tenant: createTenantRow('second', { lifecycle_state: 'frozen', updated_at: 10 }),
    });
    const refused = await call(
      adminTenantSuspendHandler,
      context(stateBody({ expected_state: 'frozen', break_glass: true }))
    );
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      error: 'insufficient_permissions',
      error_description: 'Break-glass tenant lifecycle permission is required',
    });
    expect(platform.calls).toHaveLength(0);
    const allowed = await call(
      adminTenantSuspendHandler,
      context(stateBody({ expected_state: 'frozen', break_glass: true }), {
        auth: BREAK_GLASS_ADMIN,
      })
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ lifecycle_state: 'suspended', status: 'completed' });
  });
});

describe('lifecycle command: idempotent replay', () => {
  const job = (config: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
    id: 'job-9',
    status: 'pending',
    progress: '{"stage":"queued","checks":[]}',
    config: config === null ? null : JSON.stringify(config),
    ...extra,
  });
  const sameConfig = {
    command: 'suspend',
    source_state: 'active',
    expected_updated_at: 10,
    reason: 'planned maintenance',
    break_glass: false,
  };

  it('answers the stored job, 202 while it is not completed, without a second job', async () => {
    const { platform, jobs } = setup({ jobsStoreJob: job(sameConfig) });
    const result = await call(adminTenantSuspendHandler, context(stateBody()));
    expect(result.status).toBe(202);
    expect(result.body).toEqual({
      job_id: 'job-9',
      status: 'pending',
      idempotent_replay: true,
      progress: { stage: 'queued', checks: [] },
    });
    expect(jobs.calls).toHaveLength(1);
    expect(jobs.calls[0].params).toEqual(['second', 'key-1']);
    expect(platform.calls).toHaveLength(0);
  });

  it('answers 200 for a completed job and null progress when it has none', async () => {
    setup({ jobsStoreJob: job(sameConfig, { status: 'completed', progress: null }) });
    const result = await call(adminTenantSuspendHandler, context(stateBody()));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      job_id: 'job-9',
      status: 'completed',
      idempotent_replay: true,
      progress: null,
    });
  });

  it('finds a job kept in the tenant inventory before, after looking in DB_ADMIN', async () => {
    const { platform, jobs } = setup({ inventoryJob: job(sameConfig, { id: 'legacy-1' }) });
    const result = await call(adminTenantSuspendHandler, context(stateBody()));
    expect(result.body.job_id).toBe('legacy-1');
    expect(jobs.calls).toHaveLength(1);
    expect(platform.calls).toHaveLength(1);
  });

  it.each([
    ['command', { command: 'freeze' }],
    ['source state', { source_state: 'frozen' }],
    ['expected version', { expected_updated_at: 11 }],
    ['reason', { reason: 'other reason' }],
    ['break glass', { break_glass: true }],
  ])('refuses a key reused with another %s', async (_name, change) => {
    setup({ jobsStoreJob: job({ ...sameConfig, ...change }) });
    const result = await call(adminTenantSuspendHandler, context(stateBody()));
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'idempotency_conflict',
      error_description: 'Idempotency-Key was already used with a different request payload',
    });
  });

  it('treats a stored job without a config as a different request', async () => {
    setup({ jobsStoreJob: job(null) });
    expect((await call(adminTenantSuspendHandler, context(stateBody()))).status).toBe(409);
  });
});

describe('lifecycle command: guards on the tenant', () => {
  it('answers 404 for a missing tenant', async () => {
    setup({ tenant: null });
    const result = await call(adminTenantSuspendHandler, context(stateBody()));
    expect(result.status).toBe(404);
    expect(result.body.details).toEqual({ variables: { resource: 'tenant' } });
  });

  it.each([
    ['the state', { expected_state: 'frozen' }],
    ['the version', { expected_updated_at: 9 }],
  ])('refuses when %s changed', async (_name, change) => {
    const { jobs } = setup();
    const result = await call(adminTenantSuspendHandler, context(stateBody(change)));
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'lifecycle_conflict',
      error_description: 'Tenant lifecycle state or version changed',
      current_state: 'active',
      current_updated_at: 10,
    });
    expect(jobs.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['suspend', adminTenantSuspendHandler, 'active'],
    ['freeze', adminTenantFreezeHandler, 'active'],
    ['restore-validate', adminTenantRestoreValidateHandler, 'restore_pending'],
  ])('refuses to %s the tenant flagged as default', async (_name, handler, state) => {
    const { platform } = setup({
      tenant: createTenantRow('second', { lifecycle_state: state, updated_at: 10, is_default: 1 }),
    });
    const result = await call(handler, context(stateBody({ expected_state: state })));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: 'invalid_request',
      error_description: 'Cannot deactivate the default tenant',
    });
    expect(platform.calls.filter((call) => call.op === 'execute')).toHaveLength(0);
  });

  it('lets the default tenant be resumed and unfrozen', async () => {
    setup({
      tenant: createTenantRow('second', {
        lifecycle_state: 'suspended',
        updated_at: 10,
        is_default: 1,
      }),
    });
    const resumed = await call(
      adminTenantResumeHandler,
      context(stateBody({ expected_state: 'suspended' }))
    );
    expect(resumed.status).toBe(202);
    setup({
      tenant: createTenantRow('second', {
        lifecycle_state: 'frozen',
        updated_at: 10,
        is_default: 1,
      }),
    });
    const unfrozen = await call(
      adminTenantUnfreezeHandler,
      context(stateBody({ expected_state: 'frozen' }))
    );
    expect(unfrozen.status).toBe(202);
  });

  it('protects the deployment default tenant from suspend and freeze but not from the others', async () => {
    const env = { DEFAULT_TENANT_ID: 'second' };
    setup();
    for (const handler of [adminTenantSuspendHandler, adminTenantFreezeHandler]) {
      const result = await call(handler, context(stateBody(), { env }));
      expect(result.status).toBe(409);
      expect(result.body).toEqual({
        error: 'default_tenant_protected',
        error_description: 'The deployment default tenant cannot be suspended or frozen',
      });
    }
    setup({ tenant: createTenantRow('second', { lifecycle_state: 'suspended', updated_at: 10 }) });
    expect(
      (
        await call(
          adminTenantResumeHandler,
          context(stateBody({ expected_state: 'suspended' }), { env })
        )
      ).status
    ).toBe(202);
  });

  it('refuses a transition the table does not allow', async () => {
    setup({ tenant: createTenantRow('second', { lifecycle_state: 'frozen', updated_at: 10 }) });
    const result = await call(
      adminTenantSuspendHandler,
      context(stateBody({ expected_state: 'frozen' }))
    );
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'invalid_lifecycle_transition',
      error_description: 'Invalid lifecycle transition: frozen -> suspend',
    });
  });
});
