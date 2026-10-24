/**
 * zod 3 -> 4 migration pins for admin-tenants.ts
 * (CreateTenantSchema, UpdateTenantSchema, TenantLifecycleCommandSchema).
 *
 * `createErrorResponse` is mocked: status comes from the real implementation, the body is
 * `{ error: code, ...options }` so `variables.reason` (joined zod messages) is pinned.
 * The lifecycle command handler builds its own `{ error, error_description }` body (no mock needed).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => ({
  platform: null as unknown,
  admin: null as unknown,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createD1Adapter: vi.fn(() => stores.platform),
    requireAdminDatabaseAdapter: vi.fn(() => stores.admin),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => stores.admin),
    createAuditLogFromContext: vi.fn(async () => undefined),
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })),
    })),
    createErrorResponse: vi.fn(async (c, code, options) => {
      const real = await actual.createErrorResponse(c, code, options);
      return Response.json({ error: code, ...options }, { status: real.status });
    }),
  };
});

vi.mock('../../single-tenant-guard', () => ({
  createSingleTenantMutationError: vi.fn(() => new Response('{}', { status: 409 })),
  ensureSupportedTenantId: vi.fn(async () => null),
  getSingleTenantId: vi.fn(() => 'default'),
  isSingleTenantMode: vi.fn(() => false),
}));

import {
  adminTenantCreateHandler,
  adminTenantSuspendHandler,
  adminTenantUpdateHandler,
} from '../../admin-tenants';

interface RecordingAdapter {
  calls: Array<{ op: string; sql: string; params: unknown[] }>;
  query: ReturnType<typeof vi.fn>;
  queryOne: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
}

function adapter(
  handler: (sql: string, params: unknown[], op: string) => unknown = () => null
): RecordingAdapter {
  const self: RecordingAdapter = {
    calls: [],
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      self.calls.push({ op: 'query', sql, params });
      return handler(sql, params, 'query') ?? [];
    }),
    queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
      self.calls.push({ op: 'queryOne', sql, params });
      return handler(sql, params, 'queryOne') ?? null;
    }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      self.calls.push({ op: 'execute', sql, params });
      return handler(sql, params, 'execute') ?? { rowsAffected: 1 };
    }),
    transaction: vi.fn(async (fn: (tx: RecordingAdapter) => Promise<unknown>) => fn(self)),
  };
  return self;
}

const ADMIN_AUTH = {
  userId: 'platform-admin',
  roles: ['system_admin'],
  globalRoles: ['system_admin'],
  tenantScope: ['*'],
  permissions: [],
};

function context(body: unknown, params: Record<string, string> = {}, idempotencyKey?: string) {
  return {
    req: {
      path: '/api/admin/tenants',
      json: vi.fn(async () => body),
      param: vi.fn((name: string) => params[name]),
      header: vi.fn((name: string) =>
        name.toLowerCase() === 'idempotency-key' ? idempotencyKey : undefined
      ),
    },
    env: {
      BASE_DOMAIN: 'auth.example.com',
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      DB: {},
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
    get: vi.fn((key: string) => (key === 'adminAuth' ? ADMIN_AUTH : undefined)),
    header: vi.fn(),
  } as never;
}

async function run(handler: (c: never) => Promise<Response>, c: never) {
  const response = await handler(c);
  return { status: response.status, body: await response.json() };
}

const invalidBody = (reason: string) => ({
  status: 400,
  body: { error: 'AR130003', variables: { field: 'body', reason } },
});

const ID_MSG =
  'id must start and end with a lowercase letter or digit (hyphens allowed in between)';
const CODE_MSG =
  'tenant_code must start and end with a lowercase letter or digit (hyphens allowed in between)';

beforeEach(() => {
  vi.clearAllMocks();
  stores.platform = adapter();
  stores.admin = adapter();
});

describe('zod pins: CreateTenantSchema (POST /tenants)', () => {
  const create = (body: unknown) => run(adminTenantCreateHandler, context(body));

  it('non-object roots', async () => {
    expect(await create(null)).toEqual(invalidBody('Expected object, received null'));
    expect(await create([])).toEqual(invalidBody('Expected object, received array'));
    expect(await create('x')).toEqual(invalidBody('Expected object, received string'));
  });

  it('missing required fields: Required for id then name', async () => {
    expect(await create({})).toEqual(invalidBody('Required, Required'));
    expect(await create({ id: 'acme' })).toEqual(invalidBody('Required'));
  });

  it('per-field issues and joined order', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ id: 5, name: 'N' }, 'Expected string, received number'],
      [{ id: '', name: 'N' }, `String must contain at least 1 character(s), ${ID_MSG}`],
      [{ id: 'A', name: 'N' }, ID_MSG],
      [{ id: '-ab', name: 'N' }, ID_MSG],
      [{ id: 'ab-', name: 'N' }, ID_MSG],
      [{ id: 'a_b', name: 'N' }, ID_MSG],
      [{ id: 'a'.repeat(64), name: 'N' }, 'String must contain at most 63 character(s)'],
      [{ id: 'platform', name: 'N' }, 'id is reserved'],
      [{ id: 'acme', name: '' }, 'String must contain at least 1 character(s)'],
      [{ id: 'acme', name: 'n'.repeat(201) }, 'String must contain at most 200 character(s)'],
      [{ id: 'acme', name: 7 }, 'Expected string, received number'],
      [{ id: 'acme', name: 'N', tenant_code: 'Bad Code' }, CODE_MSG],
      [{ id: 'acme', name: 'N', tenant_code: 'platform' }, 'tenant_code is reserved'],
      [
        { id: 'acme', name: 'N', tenant_code: '' },
        `String must contain at least 1 character(s), ${CODE_MSG}`,
      ],
      [{ id: 'acme', name: 'N', tenant_code: null }, 'Expected string, received null'],
      [
        { id: 'acme', name: 'N', description: 'd'.repeat(501) },
        'String must contain at most 500 character(s)',
      ],
      [{ id: 'acme', name: 'N', description: null }, 'Expected string, received null'],
      [
        { id: 'acme', name: 'N', isolation_policy: 'dedicated' },
        "Invalid enum value. Expected 'shared_pool' | 'tenant_exclusive', received 'dedicated'",
      ],
      [
        { id: 'acme', name: 'N', isolation_policy: null },
        "Expected 'shared_pool' | 'tenant_exclusive', received null",
      ],
      [
        { id: 'BAD ID', name: '', tenant_code: 'X', description: 1, isolation_policy: 'x' },
        `${ID_MSG}, String must contain at least 1 character(s), ${CODE_MSG}, Expected string, received number, Invalid enum value. Expected 'shared_pool' | 'tenant_exclusive', received 'x'`,
      ],
    ];
    for (const [body, reason] of cases) {
      expect(await create(body)).toEqual(invalidBody(reason));
    }
  });

  it('zod 3: .refine() still runs after .regex() failed on the same string', async () => {
    // In zod 3 the .refine() still runs after the .regex() check failed (string is only "dirty"),
    // so both messages are reported, regex first.
    expect(await create({ id: ' platform', name: 'N' })).toEqual(
      invalidBody(`${ID_MSG}, id is reserved`)
    );
    expect(await create({ id: 'Platform', name: 'N' })).toEqual(
      invalidBody(`${ID_MSG}, id is reserved`)
    );
  });

  it('valid body reaches provisioning with defaults applied (isolation_policy=tenant_exclusive)', async () => {
    const adminStore = stores.admin as RecordingAdapter;
    adminStore.execute.mockImplementation(async (sql: string, params: unknown[]) => {
      adminStore.calls.push({ op: 'execute', sql, params });
      throw new Error('stop after first insert');
    });
    const result = await create({ id: 'acme', name: 'Acme', extra: 'dropped' });
    expect(result.status).toBe(500);
    const insert = adminStore.calls.find((call) =>
      call.sql.includes('INSERT INTO tenant_provisioning_operations')
    );
    // [operation_id, environment_id, tenant_id, tenant_code, tenant_name, tenant_description,
    //  kind, source, payload, residency_policy, partition, isolation_policy, ...]
    expect(insert?.params.slice(2, 12)).toEqual([
      'acme',
      'acme',
      'Acme',
      null,
      'create',
      null,
      null,
      expect.any(String),
      'default',
      'tenant_exclusive',
    ]);
  });

  it('explicit isolation_policy / tenant_code / description are carried through', async () => {
    const adminStore = stores.admin as RecordingAdapter;
    adminStore.execute.mockImplementation(async (sql: string, params: unknown[]) => {
      adminStore.calls.push({ op: 'execute', sql, params });
      throw new Error('stop after first insert');
    });
    await create({
      id: 'acme',
      name: 'Acme',
      tenant_code: 'acme-code',
      description: 'd',
      isolation_policy: 'shared_pool',
    });
    const insert = adminStore.calls.find((call) =>
      call.sql.includes('INSERT INTO tenant_provisioning_operations')
    );
    expect([insert?.params[2], insert?.params[3], insert?.params[5], insert?.params[11]]).toEqual([
      'acme',
      'acme-code',
      'd',
      'shared_pool',
    ]);
  });

  it('boundary values pass validation (63-char id, 200-char name, 500-char description)', async () => {
    const adminStore = stores.admin as RecordingAdapter;
    adminStore.execute.mockImplementation(async () => {
      throw new Error('stop');
    });
    const result = await create({
      id: 'a'.repeat(63),
      name: 'n'.repeat(200),
      description: 'd'.repeat(500),
    });
    expect(result.status).toBe(500);
  });
});

describe('zod pins: UpdateTenantSchema (PATCH /tenants/:id, strict)', () => {
  const update = (body: unknown) => run(adminTenantUpdateHandler, context(body, { id: 'acme' }));

  it('root / unknown-key / field issues', async () => {
    expect(await update(null)).toEqual(invalidBody('Expected object, received null'));
    expect(await update([])).toEqual(invalidBody('Expected object, received array'));
    expect(await update({ foo: 1 })).toEqual(invalidBody("Unrecognized key(s) in object: 'foo'"));
    expect(await update({ foo: 1, bar: 2 })).toEqual(
      invalidBody("Unrecognized key(s) in object: 'foo', 'bar'")
    );
    expect(await update({ id: 'acme' })).toEqual(
      invalidBody("Unrecognized key(s) in object: 'id'")
    );
    expect(await update({ name: '' })).toEqual(
      invalidBody('String must contain at least 1 character(s)')
    );
    expect(await update({ name: 5 })).toEqual(invalidBody('Expected string, received number'));
    expect(await update({ tenant_code: 'UPPER' })).toEqual(invalidBody(CODE_MSG));
    expect(await update({ tenant_code: 'platform' })).toEqual(
      invalidBody('tenant_code is reserved')
    );
    expect(await update({ description: 5 })).toEqual(
      invalidBody('Expected string, received number')
    );
    expect(await update({ description: 'd'.repeat(501) })).toEqual(
      invalidBody('String must contain at most 500 character(s)')
    );
    expect(await update({ name: '', foo: 1 })).toEqual(
      invalidBody(
        "String must contain at least 1 character(s), Unrecognized key(s) in object: 'foo'"
      )
    );
  });

  it('description accepts null (nullable) and empty string; empty object is a no-op returning the row', async () => {
    const row = {
      id: 'acme',
      tenant_code: 'acme',
      name: 'Acme',
      description: 'old',
      isolation_policy: 'tenant_exclusive',
      lifecycle_state: 'active',
      is_default: 0,
      created_at: 1,
      updated_at: 2,
    };
    stores.platform = adapter((sql, _params, op) =>
      op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?') ? row : null
    );
    const noop = await update({});
    expect(noop.status).toBe(200);
    expect(noop.body).toMatchObject({ id: 'acme', name: 'Acme', description: 'old' });
    expect((stores.platform as RecordingAdapter).execute).not.toHaveBeenCalled();

    await update({ description: null });
    await update({ description: '' });
    const updates = (stores.platform as RecordingAdapter).calls.filter(
      (call) => call.op === 'execute'
    );
    expect(
      updates.map((call) => [call.sql.replace(/updated_at = \?/, 'U'), call.params[0]])
    ).toEqual([
      ['UPDATE tenants SET description = ?, U WHERE id = ?', null],
      ['UPDATE tenants SET description = ?, U WHERE id = ?', ''],
    ]);
  });
});

describe('zod pins: TenantLifecycleCommandSchema (POST /tenants/:id/suspend)', () => {
  const suspend = (body: unknown, key: string | undefined = 'idem-1') =>
    run(adminTenantSuspendHandler, context(body, { id: 'acme' }, key));
  const lifecycleError = (description: string) => ({
    status: 400,
    body: { error: 'invalid_request', error_description: description },
  });
  const good = { expected_state: 'active', expected_updated_at: 5, reason: 'maintenance window' };

  it('Idempotency-Key is checked before the body', async () => {
    expect(await suspend({}, '')).toEqual(
      lifecycleError('A valid Idempotency-Key header is required')
    );
  });

  it('missing / wrong-typed fields (error_description is the joined messages)', async () => {
    expect(await suspend({})).toEqual(lifecycleError('Required, Required, Required'));
    expect(await suspend(null)).toEqual(lifecycleError('Expected object, received null'));
    expect(await suspend([])).toEqual(lifecycleError('Expected object, received array'));
    expect(await suspend({ ...good, expected_state: 'gone' })).toEqual(
      lifecycleError(
        "Invalid enum value. Expected 'provisioning' | 'active' | 'suspended' | 'frozen' | 'migration_read_only' | 'deleting' | 'deleted' | 'restore_pending' | 'restore_validating', received 'gone'"
      )
    );
    expect(await suspend({ ...good, expected_updated_at: -1 })).toEqual(
      lifecycleError('Number must be greater than or equal to 0')
    );
    expect(await suspend({ ...good, expected_updated_at: 1.5 })).toEqual(
      lifecycleError('Expected integer, received float')
    );
    expect(await suspend({ ...good, expected_updated_at: '5' })).toEqual(
      lifecycleError('Expected number, received string')
    );
    expect(await suspend({ ...good, reason: 'ab' })).toEqual(
      lifecycleError('String must contain at least 3 character(s)')
    );
    expect(await suspend({ ...good, reason: '  ab  ' })).toEqual(
      lifecycleError('String must contain at least 3 character(s)')
    );
    expect(await suspend({ ...good, reason: 'r'.repeat(1001) })).toEqual(
      lifecycleError('String must contain at most 1000 character(s)')
    );
    expect(await suspend({ ...good, reason: 3 })).toEqual(
      lifecycleError('Expected string, received number')
    );
    expect(await suspend({ ...good, break_glass: 'yes' })).toEqual(
      lifecycleError('Expected boolean, received string')
    );
    expect(await suspend({ ...good, break_glass: null })).toEqual(
      lifecycleError('Expected boolean, received null')
    );
    expect(
      await suspend({ expected_state: 'x', expected_updated_at: 'y', reason: 1, break_glass: 2 })
    ).toEqual(
      lifecycleError(
        "Invalid enum value. Expected 'provisioning' | 'active' | 'suspended' | 'frozen' | 'migration_read_only' | 'deleting' | 'deleted' | 'restore_pending' | 'restore_validating', received 'x', Expected number, received string, Expected string, received number, Expected boolean, received number"
      )
    );
  });

  it('whitespace-only reason: trim runs before min(3)', async () => {
    expect(await suspend({ ...good, reason: '     ' })).toEqual(
      lifecycleError('String must contain at least 3 character(s)')
    );
  });

  it('unknown keys are stripped; reason is trimmed; break_glass defaults to false (observed via idempotent replay)', async () => {
    const existing = {
      id: 'job-1',
      status: 'pending',
      progress: JSON.stringify({ stage: 'queued', checks: [] }),
      config: JSON.stringify({
        command: 'suspend',
        source_state: 'active',
        expected_updated_at: 5,
        reason: 'maintenance window',
        break_glass: false,
      }),
    };
    const jobs = adapter((sql, _p, op) =>
      op === 'queryOne' && sql.includes('FROM admin_jobs') ? existing : null
    );
    stores.platform = jobs;
    stores.admin = jobs;
    const replay = await suspend({
      ...good,
      reason: '   maintenance window  ',
      surplus: 'ignored',
    });
    expect(replay).toEqual({
      status: 202,
      body: {
        job_id: 'job-1',
        status: 'pending',
        idempotent_replay: true,
        progress: { stage: 'queued', checks: [] },
      },
    });
    // explicit break_glass=true is parsed as true and hits the break-glass permission check
    expect(await suspend({ ...good, break_glass: true })).toMatchObject({
      status: 403,
    });
  });
});
