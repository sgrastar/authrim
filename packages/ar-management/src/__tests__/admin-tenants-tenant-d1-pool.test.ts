import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  adminTenantCreateHandler,
  adminTenantDeleteHandler,
  adminTenantGetHandler,
  adminTenantProvisioningCleanupHandler,
  adminTenantProvisioningRetryHandler,
  adminTenantUpdateHandler,
  adminTenantSuspendHandler,
  adminTenantResumeHandler,
  adminTenantLifecycleJobRetryHandler,
  adminTenantsListHandler,
  activateProvisionedTenant,
  provisionTenant,
  rollbackProvisionedTenant,
} from '../admin-tenants';

type QueryOp = 'query' | 'queryOne' | 'execute';

interface MockAdapter {
  query: ReturnType<typeof vi.fn>;
  queryOne: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  batch: ReturnType<typeof vi.fn>;
  isHealthy: ReturnType<typeof vi.fn>;
  getType: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  calls: Array<{ op: QueryOp; sql: string; params: unknown[] }>;
}

interface TenantRow {
  id: string;
  tenant_code: string;
  name: string;
  description: string | null;
  lifecycle_state: string;
  is_default: number;
  created_at: number;
  updated_at: number;
}

interface TenantDatabaseSlotRow {
  slot_id: string;
  slot_number: number;
  core_binding_ref: string;
  pii_binding_ref: string;
  core_database_name: string;
  pii_database_name: string;
  core_database_id: string;
  pii_database_id: string;
  state: string;
  assigned_tenant_id: string | null;
}

const adapters = vi.hoisted(() => ({
  defaultAdapter: null as MockAdapter | null,
  tenantAdapters: new Map<string, MockAdapter>(),
  adminAdapter: null as MockAdapter | null,
}));

vi.mock('@authrim/ar-lib-core', () => ({
  ADMIN_PERMISSIONS: {
    TENANT_LIFECYCLE_BREAK_GLASS: 'admin:tenants:lifecycle:break_glass',
  },
  hasAdminPermission: vi.fn((permissions: string[], required: string) =>
    permissions.includes(required)
  ),
  AR_ERROR_CODES: {
    ADMIN_RESOURCE_NOT_FOUND: 'admin_resource_not_found',
    ADMIN_INSUFFICIENT_PERMISSIONS: 'admin_insufficient_permissions',
    INTERNAL_ERROR: 'internal_error',
    VALIDATION_INVALID_VALUE: 'validation_invalid_value',
  },
  createAuthContextFromHono: vi.fn((_c: unknown, tenantId: string) => ({
    coreAdapter: adapters.tenantAdapters.get(tenantId) ?? adapters.defaultAdapter,
  })),
  createAuditLogFromContext: vi.fn(async () => {}),
  createErrorResponse: vi.fn((_c: unknown, code: string, details?: unknown) => {
    const status =
      code === 'validation_invalid_value'
        ? 400
        : code === 'admin_resource_not_found'
          ? 404
          : code === 'admin_insufficient_permissions'
            ? 403
            : 500;
    return new Response(JSON.stringify({ error: code, details }), { status });
  }),
  getDefaultTenantId: vi.fn(() => 'default'),
  getLogger: vi.fn(() => ({
    module: vi.fn(() => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    })),
  })),
  getPrimaryTenantId: vi.fn(() => 'default'),
  getTenantIdFromContext: vi.fn(() => 'default'),
  putTenantExistsCache: vi.fn(async (kv: KVNamespace | undefined, tenantId: string) => {
    await kv?.put(`v1:tenant-exists:${tenantId}`, 'true', { expirationTtl: 3600 });
  }),
  deleteTenantExistsCache: vi.fn(async (kv: KVNamespace | undefined, tenantId: string) => {
    await kv?.delete(`v1:tenant-exists:${tenantId}`);
  }),
  seedCustomClaimSchemas: vi.fn(async () => {}),
  TENANT_POLICY_PRESETS: [
    {
      id: 'b2c-standard',
      defaults: {
        maxSessionAgeSeconds: 3600,
        allowedAcrValues: [],
        allowedPromptValues: [],
      },
    },
  ],
  buildContractKey: vi.fn((_env: Env, scope: string, tenantId: string) => `${scope}:${tenantId}`),
  buildIssuerUrl: vi.fn((env: Env, tenantId: string) => `https://${tenantId}.${env.BASE_DOMAIN}`),
  requireAdminDatabaseAdapter: vi.fn(() => {
    if (!adapters.adminAdapter) {
      throw new Error('admin adapter not configured');
    }
    return adapters.adminAdapter;
  }),
  TenantDatabaseRegistryRepository: vi.fn().mockImplementation(function MockRepository() {
    return {
      upsertRegistryRow: vi.fn(async () => {}),
      setActivePointer: vi.fn(async () => {}),
    };
  }),
  buildTenantRuntimeRegistryGenerationKey: vi.fn(
    (tenantId: string, target: string) => `runtime:generation:${target}:${tenantId}`
  ),
  buildTenantRuntimeRegistrySnapshotKey: vi.fn(
    (tenantId: string, target: string) => `runtime:snapshot:${target}:${tenantId}`
  ),
  publishTenantRuntimeRegistrySnapshot: vi.fn(async () => {}),
  usesNakedDomainIssuer: vi.fn(() => false),
}));

vi.mock('../single-tenant-guard', () => ({
  createSingleTenantMutationError: vi.fn(
    () => new Response(JSON.stringify({ error: 'single_tenant_mode' }), { status: 409 })
  ),
  ensureSupportedTenantId: vi.fn(),
  getSingleTenantId: vi.fn(() => 'default'),
  isSingleTenantMode: vi.fn(() => false),
}));

function createAdapter(
  handler: (
    sql: string,
    params: unknown[],
    op: QueryOp,
    adapter: MockAdapter
  ) => unknown | Promise<unknown> = () => null
): MockAdapter {
  const adapter = {
    calls: [],
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      adapter.calls.push({ op: 'query', sql, params });
      return (await handler(sql, params, 'query', adapter)) ?? [];
    }),
    queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
      adapter.calls.push({ op: 'queryOne', sql, params });
      return (await handler(sql, params, 'queryOne', adapter)) ?? null;
    }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      adapter.calls.push({ op: 'execute', sql, params });
      return (await handler(sql, params, 'execute', adapter)) ?? { rowsAffected: 1 };
    }),
    transaction: vi.fn(async (fn: (tx: MockAdapter) => Promise<unknown>) => fn(adapter)),
    batch: vi.fn(async () => []),
    isHealthy: vi.fn(async () => ({ healthy: true, latency: 0 })),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => {}),
  } as MockAdapter;
  return adapter;
}

function createKVNamespace() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix = '' }: { prefix?: string }) => ({
      list_complete: true as const,
      keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      cacheStatus: null,
    })),
  } as unknown as KVNamespace;
}

function createKeyManager() {
  const durableObject = {
    getStatusRpc: vi.fn(async () => ({ activeKeyId: null })),
    rotateKeysRpc: vi.fn(async () => {}),
  };
  return {
    idFromName: vi.fn((name: string) => ({ name })),
    get: vi.fn(() => durableObject),
  } as unknown as Env['KEY_MANAGER'];
}

function createTenantRow(id: string, overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id,
    tenant_code: id,
    name: id,
    description: null,
    lifecycle_state: 'active',
    is_default: 0,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createTenantRowFromInsertParams(params: unknown[]): TenantRow {
  return createTenantRow(String(params[0]), {
    tenant_code: String(params[1]),
    name: String(params[3]),
    description: params[4] as string | null,
    lifecycle_state: String(params[5]),
    created_at: Number(params[7]),
    updated_at: Number(params[8]),
  });
}

function createContext(
  body: Record<string, unknown>,
  envOverrides: Partial<Env> = {},
  routeParams: Record<string, string> = {},
  adminAuth: Record<string, unknown> = {
    userId: 'platform-admin',
    roles: ['system_admin'],
    permissions: [],
  }
) {
  const responseHeaders = new Headers();
  return {
    req: {
      json: vi.fn(async () => body),
      param: vi.fn((name: string) => routeParams[name]),
      header: vi.fn((name: string) =>
        name.toLowerCase() === 'idempotency-key' ? 'lifecycle-test-key' : undefined
      ),
    },
    env: {
      BASE_DOMAIN: 'auth.example.com',
      DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:tenant-d1',
      AUTHRIM_CONFIG: createKVNamespace(),
      SETTINGS: createKVNamespace(),
      TENANT_RUNTIME_REGISTRY: createKVNamespace(),
      KEY_MANAGER: createKeyManager(),
      ...envOverrides,
    } as Env,
    json: vi.fn((responseBody: unknown, status = 200) => {
      return new Response(JSON.stringify(responseBody), { status, headers: responseHeaders });
    }),
    get: vi.fn((key: string) => {
      if (key === 'adminAuth') {
        return adminAuth;
      }
      return undefined;
    }),
    header: vi.fn((name: string, value: string) => responseHeaders.set(name, value)),
  } as any;
}

function createSlot(overrides: Partial<TenantDatabaseSlotRow> = {}): TenantDatabaseSlotRow {
  return {
    slot_id: 'slot-0001',
    slot_number: 1,
    core_binding_ref: 'TDB_SLOT_0001_CORE',
    pii_binding_ref: 'TDB_SLOT_0001_PII',
    core_database_name: 'authrim-test-tdb-slot-0001-core',
    pii_database_name: 'authrim-test-tdb-slot-0001-pii',
    core_database_id: 'core-db-id',
    pii_database_id: 'pii-db-id',
    state: 'available',
    assigned_tenant_id: null,
    ...overrides,
  };
}

describe('tenant D1 pool tenant management', () => {
  beforeEach(() => {
    adapters.defaultAdapter = null;
    adapters.tenantAdapters.clear();
    adapters.adminAdapter = null;
    vi.clearAllMocks();
  });

  it('returns the tenant D1 pool summary in the tenant list', async () => {
    adapters.defaultAdapter = createAdapter((sql) => {
      if (sql.includes('FROM tenants')) {
        return [createTenantRow('first', { name: 'First' })];
      }
      return null;
    });
    adapters.adminAdapter = createAdapter((sql) => {
      if (sql.includes('FROM tenant_database_slots')) {
        return [
          { state: 'available', count: 2 },
          { state: 'assigned', count: 1 },
          { state: 'reset_required', count: 1 },
        ];
      }
      return null;
    });

    const response = await adminTenantsListHandler(createContext({}));
    const body = (await response.json()) as {
      tenant_d1_pool: {
        enabled: boolean;
        capacity: number;
        available_slots: number;
        assigned_slots: number;
        reset_required_slots: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body.tenant_d1_pool).toMatchObject({
      enabled: true,
      capacity: 4,
      available_slots: 2,
      assigned_slots: 1,
      reset_required_slots: 1,
    });
  });

  it('limits tenant inventory list to the authenticated tenant scope for non-platform admins', async () => {
    adapters.defaultAdapter = createAdapter((sql, params) => {
      if (sql.includes('FROM tenants')) {
        expect(sql).toContain('WHERE id IN (?)');
        expect(params).toEqual(['first']);
        return [createTenantRow('first', { name: 'First' })];
      }
      return null;
    });
    adapters.adminAdapter = createAdapter(() => []);

    const response = await adminTenantsListHandler(
      createContext(
        {},
        {},
        {},
        {
          adminId: 'tenant-admin',
          roles: ['admin'],
          tenantId: 'first',
          tenantScope: ['first'],
        }
      )
    );
    const body = (await response.json()) as { tenants: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.tenants.map((tenant) => tenant.id)).toEqual(['first']);
  });

  it('denies tenant detail access for non-platform admins even when the URL is known', async () => {
    const response = await adminTenantGetHandler(
      createContext(
        {},
        {},
        { id: 'second' },
        {
          adminId: 'tenant-admin',
          roles: ['admin'],
          tenantId: 'first',
          tenantScope: ['first'],
        }
      )
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe('admin_insufficient_permissions');
  });

  it('returns 409 when no preallocated tenant D1 slot is available', async () => {
    adapters.defaultAdapter = createAdapter((sql) => {
      if (sql === 'SELECT id FROM tenants WHERE id = ?') {
        return null;
      }
      if (sql === 'SELECT id FROM tenants WHERE tenant_code = ?') {
        return null;
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });
    adapters.adminAdapter = createAdapter((sql, _params, op) => {
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slots') &&
        sql.includes('LIMIT 1')
      ) {
        return null;
      }
      if (op === 'queryOne' && sql.includes('COUNT(*) AS total')) {
        return { total: 3 };
      }
      throw new Error(`unexpected admin adapter SQL: ${sql}`);
    });

    const response = await adminTenantCreateHandler(
      createContext({ id: 'second', name: 'Second Tenant' })
    );
    const body = (await response.json()) as {
      error: string;
      current_capacity: number;
      required_additional_slots: number;
    };

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: 'tenant_d1_slot_exhausted',
      current_capacity: 3,
      required_additional_slots: 1,
    });
    expect(
      adapters.defaultAdapter.calls.some(
        (call) => call.op === 'execute' && call.sql.includes('INSERT INTO tenants')
      )
    ).toBe(false);
  });

  it('does not create a tenant row when slot reservation loses a conditional update race', async () => {
    const slot = createSlot();

    adapters.defaultAdapter = createAdapter((sql) => {
      if (sql === 'SELECT id FROM tenants WHERE id = ?') {
        return null;
      }
      if (sql === 'SELECT id FROM tenants WHERE tenant_code = ?') {
        return null;
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });
    adapters.adminAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('WHERE state =') && sql.includes('LIMIT 1')) {
        return slot;
      }
      if (op === 'execute' && sql.includes("SET state = 'reserved'")) {
        return { rowsAffected: 0 };
      }
      if (op === 'queryOne' && sql.includes('WHERE slot_id = ? AND state = ?')) {
        return null;
      }
      if (op === 'queryOne' && sql.includes('COUNT(*) AS total')) {
        return { total: 1 };
      }
      throw new Error(`unexpected admin adapter SQL: ${sql}`);
    });

    const response = await adminTenantCreateHandler(
      createContext({ id: 'second', name: 'Second Tenant' })
    );
    const body = (await response.json()) as { error: string; current_capacity: number };

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: 'tenant_d1_slot_exhausted',
      current_capacity: 1,
    });
    expect(
      adapters.defaultAdapter.calls.some(
        (call) => call.op === 'execute' && call.sql.includes('INSERT INTO tenants')
      )
    ).toBe(false);
  });

  it('reserves a slot, seeds the tenant database, and marks the slot assigned', async () => {
    const slot = createSlot();
    let slotState = 'available';
    let assignedTenantId: string | null = null;
    let controlTenant: TenantRow | null = null;
    let tenantDbRow: TenantRow | null = null;

    adapters.defaultAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE id = ?') {
        return null;
      }
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE tenant_code = ?') {
        return null;
      }
      if (op === 'execute' && sql.includes('INSERT INTO tenants')) {
        controlTenant = createTenantRowFromInsertParams(params);
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes("UPDATE tenants SET lifecycle_state = 'active'")) {
        if (controlTenant) {
          controlTenant = {
            ...controlTenant,
            lifecycle_state: 'active',
            updated_at: Number(params[0]),
          };
        }
        return { rowsAffected: 1 };
      }
      if (
        op === 'queryOne' &&
        sql.includes(
          'SELECT id, tenant_code, name, description, lifecycle_state, is_default, created_at, updated_at FROM tenants WHERE id = ?'
        )
      ) {
        return controlTenant;
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    const tenantAdapter = createAdapter((sql, params, op) => {
      if (op === 'execute' && sql.includes('INSERT INTO tenants')) {
        tenantDbRow = createTenantRowFromInsertParams(params);
        return { rowsAffected: 1 };
      }
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE id = ?') {
        return tenantDbRow ? { id: tenantDbRow.id } : null;
      }
      throw new Error(`unexpected tenant adapter SQL: ${sql}`);
    });
    adapters.tenantAdapters.set('second', tenantAdapter);

    adapters.adminAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql.includes('WHERE state =') && sql.includes('LIMIT 1')) {
        return slotState === 'available'
          ? { ...slot, state: slotState, assigned_tenant_id: null }
          : null;
      }
      if (op === 'execute' && sql.includes("SET state = 'reserved'")) {
        slotState = 'reserved';
        assignedTenantId = String(params[0]);
        return { rowsAffected: 1 };
      }
      if (op === 'queryOne' && sql.includes('WHERE slot_id = ? AND state = ?')) {
        return slotState === 'reserved'
          ? { ...slot, state: slotState, assigned_tenant_id: assignedTenantId }
          : null;
      }
      if (op === 'execute' && sql.includes('tenant_database_slot_audit_events')) {
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes("SET state = 'assigned'")) {
        slotState = 'assigned';
        assignedTenantId = String(params[0]);
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected admin adapter SQL: ${sql}`);
    });

    const response = await adminTenantCreateHandler(
      createContext({ id: 'second', name: 'Second Tenant', description: 'Tenant D1' })
    );
    const body = (await response.json()) as {
      id: string;
      lifecycle_state: string;
      provisioning: { mode: string; slot_id: string; smoke_test: string };
    };

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      id: 'second',
      lifecycle_state: 'active',
      provisioning: {
        mode: 'tenant-d1-preallocated-pool',
        slot_id: 'slot-0001',
        smoke_test: 'passed',
      },
    });
    expect(tenantDbRow).toMatchObject({ id: 'second', lifecycle_state: 'active' });
    expect(slotState).toBe('assigned');
    expect(assignedTenantId).toBe('second');
  });

  it('marks the slot reset_required when smoke fails after tenant DB write', async () => {
    const slot = createSlot();
    let slotState = 'available';
    let assignedTenantId: string | null = null;
    let controlTenant: TenantRow | null = null;
    let tenantDbRow: TenantRow | null = null;

    adapters.defaultAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE id = ?') {
        return null;
      }
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE tenant_code = ?') {
        return null;
      }
      if (op === 'execute' && sql.includes('INSERT INTO tenants')) {
        controlTenant = createTenantRowFromInsertParams(params);
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes("UPDATE tenants SET lifecycle_state = 'suspended'")) {
        if (controlTenant) {
          controlTenant = {
            ...controlTenant,
            lifecycle_state: 'suspended',
            updated_at: Number(params[0]),
          };
        }
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes("UPDATE tenants SET lifecycle_state = 'deleted'")) {
        controlTenant = controlTenant
          ? { ...controlTenant, lifecycle_state: 'deleted', updated_at: Number(params[0]) }
          : null;
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    adapters.tenantAdapters.set(
      'second',
      createAdapter((sql, params, op) => {
        if (op === 'execute' && sql.includes('INSERT INTO tenants')) {
          tenantDbRow = createTenantRowFromInsertParams(params);
          return { rowsAffected: 1 };
        }
        if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE id = ?') {
          return tenantDbRow ? { id: tenantDbRow.id } : null;
        }
        throw new Error(`unexpected tenant adapter SQL: ${sql}`);
      })
    );

    adapters.adminAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql.includes('WHERE state =') && sql.includes('LIMIT 1')) {
        return slotState === 'available'
          ? { ...slot, state: slotState, assigned_tenant_id: null }
          : null;
      }
      if (op === 'execute' && sql.includes("SET state = 'reserved'")) {
        slotState = 'reserved';
        assignedTenantId = String(params[0]);
        return { rowsAffected: 1 };
      }
      if (op === 'queryOne' && sql.includes('WHERE slot_id = ? AND state = ?')) {
        return slotState === 'reserved'
          ? { ...slot, state: slotState, assigned_tenant_id: assignedTenantId }
          : null;
      }
      if (op === 'execute' && sql.includes('tenant_database_slot_audit_events')) {
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes('SET state = ?')) {
        slotState = String(params[0]);
        return { rowsAffected: 1 };
      }
      if (
        op === 'execute' &&
        (sql.includes('tenant_database_active_pointers') ||
          sql.includes('tenant_database_registry') ||
          sql.includes('tenant_runtime_registry_snapshots'))
      ) {
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected admin adapter SQL: ${sql}`);
    });

    const failingSettings = {
      get: vi.fn(async () => {
        throw new Error('settings read failed');
      }),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as KVNamespace;

    let fakeNow = 1_000_000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      fakeNow += 20_000;
      return fakeNow;
    });
    const response = await adminTenantCreateHandler(
      createContext({ id: 'second', name: 'Second Tenant' }, { SETTINGS: failingSettings })
    );
    dateNowSpy.mockRestore();

    expect(response.status).toBe(500);
    expect(slotState).toBe('reset_required');
    expect(controlTenant).toMatchObject({ id: 'second', lifecycle_state: 'suspended' });
  });

  it('cleans up a failed provisioning draft without releasing the reset-required slot', async () => {
    const slot = createSlot({
      state: 'reset_required',
      assigned_tenant_id: 'second',
    });
    let controlTenant: TenantRow | null = createTenantRow('second', {
      lifecycle_state: 'suspended',
    });
    let cleanupAuditWritten = false;

    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return controlTenant;
      }
      if (op === 'execute' && sql.includes("UPDATE tenants SET lifecycle_state = 'deleted'")) {
        controlTenant = controlTenant
          ? { ...controlTenant, lifecycle_state: 'deleted', updated_at: Number(_params[0]) }
          : null;
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    adapters.adminAdapter = createAdapter((sql, _params, op) => {
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slots') &&
        sql.includes("state IN ('reset_required', 'unavailable')")
      ) {
        return { slot_id: slot.slot_id, state: slot.state, updated_at: 1_700_000_000 };
      }
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slot_audit_events') &&
        sql.includes("result IN ('failed', 'succeeded')")
      ) {
        return {
          slot_id: slot.slot_id,
          error_code: 'settings read failed',
          created_at: 1_700_000_001,
          result: 'failed',
        };
      }
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slot_audit_events') &&
        sql.includes("result = 'failed'")
      ) {
        return { error_code: 'settings read failed', created_at: 1_700_000_001 };
      }
      if (
        op === 'execute' &&
        (sql.includes('tenant_database_active_pointers') ||
          sql.includes('tenant_database_registry') ||
          sql.includes('tenant_runtime_registry_snapshots'))
      ) {
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes('tenant_database_slot_audit_events')) {
        cleanupAuditWritten = true;
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected admin adapter SQL: ${sql}`);
    });

    const response = await adminTenantProvisioningCleanupHandler(
      createContext({}, {}, { id: 'second' })
    );
    const body = (await response.json()) as { status: string; slot_id: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'cleaned', slot_id: 'slot-0001' });
    expect(controlTenant).toMatchObject({ id: 'second', lifecycle_state: 'deleted' });
    expect(cleanupAuditWritten).toBe(true);
  });

  it('rejects provisioning retry while the failed slot still requires reset', async () => {
    const slot = createSlot({
      state: 'reset_required',
      assigned_tenant_id: 'second',
    });

    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return createTenantRow('second', { lifecycle_state: 'suspended' });
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    adapters.adminAdapter = createAdapter((sql, _params, op) => {
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slots') &&
        sql.includes("state IN ('reset_required', 'unavailable')")
      ) {
        return { slot_id: slot.slot_id, state: slot.state, updated_at: 1_700_000_000 };
      }
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slot_audit_events') &&
        sql.includes("result IN ('failed', 'succeeded')")
      ) {
        return {
          slot_id: slot.slot_id,
          error_code: 'settings read failed',
          created_at: 1_700_000_001,
          result: 'failed',
        };
      }
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slot_audit_events') &&
        sql.includes("result = 'failed'")
      ) {
        return { error_code: 'settings read failed', created_at: 1_700_000_001 };
      }
      if (
        op === 'queryOne' &&
        sql.includes('SELECT * FROM tenant_database_slots WHERE slot_id = ?')
      ) {
        return slot;
      }
      if (op === 'execute' && sql.includes('tenant_database_slot_audit_events')) {
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected admin adapter SQL: ${sql}`);
    });

    const response = await adminTenantProvisioningRetryHandler(
      createContext({}, {}, { id: 'second' })
    );
    const body = (await response.json()) as { error: string; current_state: string };

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: 'tenant_d1_slot_reset_required',
      current_state: 'reset_required',
    });
  });

  it('retries provisioning after the failed slot has been reset to available', async () => {
    const slot = createSlot({ state: 'available', assigned_tenant_id: null });
    let slotState = 'available';
    let assignedTenantId: string | null = null;
    let controlTenant: TenantRow | null = createTenantRow('second', {
      lifecycle_state: 'suspended',
    });
    let tenantDbRow: TenantRow | null = null;

    adapters.defaultAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return controlTenant;
      }
      if (op === 'execute' && sql.includes('INSERT INTO tenants')) {
        controlTenant = createTenantRowFromInsertParams(params);
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes("UPDATE tenants SET lifecycle_state = 'active'")) {
        if (controlTenant) {
          controlTenant = {
            ...controlTenant,
            lifecycle_state: 'active',
            updated_at: Number(params[0]),
          };
        }
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    adapters.tenantAdapters.set(
      'second',
      createAdapter((sql, params, op) => {
        if (op === 'execute' && sql.includes('INSERT INTO tenants')) {
          tenantDbRow = createTenantRowFromInsertParams(params);
          return { rowsAffected: 1 };
        }
        if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE id = ?') {
          return tenantDbRow ? { id: tenantDbRow.id } : null;
        }
        throw new Error(`unexpected tenant adapter SQL: ${sql}`);
      })
    );

    adapters.adminAdapter = createAdapter((sql, params, op) => {
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slots') &&
        sql.includes("state IN ('reset_required', 'unavailable')")
      ) {
        return null;
      }
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slot_audit_events') &&
        sql.includes('slot_id IS NOT NULL')
      ) {
        return {
          slot_id: slot.slot_id,
          error_code: 'settings read failed',
          created_at: 1_700_000_001,
          result: 'failed',
        };
      }
      if (
        op === 'queryOne' &&
        sql.includes('SELECT slot_id, state, updated_at FROM tenant_database_slots')
      ) {
        return { slot_id: slot.slot_id, state: slotState, updated_at: 1_700_000_010 };
      }
      if (
        op === 'queryOne' &&
        sql.includes('SELECT * FROM tenant_database_slots WHERE slot_id = ?')
      ) {
        return { ...slot, state: slotState, assigned_tenant_id: assignedTenantId };
      }
      if (op === 'execute' && sql.includes("SET state = 'reserved'")) {
        slotState = 'reserved';
        assignedTenantId = String(params[0]);
        return { rowsAffected: 1 };
      }
      if (op === 'queryOne' && sql.includes('WHERE slot_id = ? AND state = ?')) {
        return slotState === 'reserved'
          ? { ...slot, state: slotState, assigned_tenant_id: assignedTenantId }
          : null;
      }
      if (op === 'execute' && sql.includes('tenant_database_slot_audit_events')) {
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes("SET state = 'assigned'")) {
        slotState = 'assigned';
        assignedTenantId = String(params[0]);
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected admin adapter SQL: ${sql}`);
    });

    const response = await adminTenantProvisioningRetryHandler(
      createContext({}, {}, { id: 'second' })
    );
    const body = (await response.json()) as {
      id: string;
      lifecycle_state: string;
      provisioning: { retry: string; slot_id: string };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id: 'second',
      lifecycle_state: 'active',
      provisioning: { retry: 'succeeded', slot_id: 'slot-0001' },
    });
    expect(slotState).toBe('assigned');
    expect(controlTenant).toMatchObject({ id: 'second', lifecycle_state: 'active' });
    expect(tenantDbRow).toMatchObject({ id: 'second', lifecycle_state: 'active' });
  });

  it('rejects provisioning retry when the failed slot has already been reused', async () => {
    const reusedSlot = createSlot({
      state: 'assigned',
      assigned_tenant_id: 'third',
    });
    let retryAuditWritten = false;

    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return createTenantRow('second', { lifecycle_state: 'suspended' });
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    adapters.adminAdapter = createAdapter((sql, _params, op) => {
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slots') &&
        sql.includes("state IN ('reset_required', 'unavailable')")
      ) {
        return null;
      }
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slot_audit_events') &&
        sql.includes("result IN ('failed', 'succeeded')")
      ) {
        return {
          slot_id: reusedSlot.slot_id,
          error_code: 'registry write failed',
          created_at: 1_700_000_001,
          result: 'failed',
        };
      }
      if (
        op === 'queryOne' &&
        sql.includes('SELECT slot_id, state, updated_at FROM tenant_database_slots')
      ) {
        return {
          slot_id: reusedSlot.slot_id,
          state: reusedSlot.state,
          updated_at: 1_700_000_010,
        };
      }
      if (
        op === 'queryOne' &&
        sql.includes('SELECT * FROM tenant_database_slots WHERE slot_id = ?')
      ) {
        return reusedSlot;
      }
      if (op === 'execute' && sql.includes('tenant_database_slot_audit_events')) {
        retryAuditWritten = true;
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected admin adapter SQL: ${sql}`);
    });

    const response = await adminTenantProvisioningRetryHandler(
      createContext({}, {}, { id: 'second' })
    );
    const body = (await response.json()) as {
      error: string;
      current_state: string;
      slot_id: string;
    };

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: 'tenant_d1_slot_unavailable',
      current_state: 'assigned',
      slot_id: 'slot-0001',
    });
    expect(retryAuditWritten).toBe(true);
  });

  it('keeps a failed draft cleanable even if its released slot was reused', async () => {
    const reusedSlot = createSlot({
      state: 'assigned',
      assigned_tenant_id: 'third',
    });
    let controlTenant: TenantRow | null = createTenantRow('second', {
      lifecycle_state: 'suspended',
    });

    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return controlTenant;
      }
      if (op === 'execute' && sql.includes("UPDATE tenants SET lifecycle_state = 'deleted'")) {
        controlTenant = controlTenant
          ? { ...controlTenant, lifecycle_state: 'deleted', updated_at: Number(_params[0]) }
          : null;
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    adapters.adminAdapter = createAdapter((sql, _params, op) => {
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slots') &&
        sql.includes("state IN ('reset_required', 'unavailable')")
      ) {
        return null;
      }
      if (
        op === 'queryOne' &&
        sql.includes('FROM tenant_database_slot_audit_events') &&
        sql.includes("result IN ('failed', 'succeeded')")
      ) {
        return {
          slot_id: reusedSlot.slot_id,
          error_code: 'registry write failed',
          created_at: 1_700_000_001,
          result: 'failed',
        };
      }
      if (
        op === 'queryOne' &&
        sql.includes('SELECT slot_id, state, updated_at FROM tenant_database_slots')
      ) {
        return {
          slot_id: reusedSlot.slot_id,
          state: reusedSlot.state,
          updated_at: 1_700_000_010,
        };
      }
      if (
        op === 'execute' &&
        (sql.includes('tenant_database_active_pointers') ||
          sql.includes('tenant_database_registry') ||
          sql.includes('tenant_runtime_registry_snapshots'))
      ) {
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes('tenant_database_slot_audit_events')) {
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected admin adapter SQL: ${sql}`);
    });

    const response = await adminTenantProvisioningCleanupHandler(
      createContext({}, {}, { id: 'second' })
    );
    const body = (await response.json()) as { status: string; slot_id: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'cleaned', slot_id: 'slot-0001' });
    expect(controlTenant).toMatchObject({ id: 'second', lifecycle_state: 'deleted' });
  });

  it('requires dedicated commands for operator lifecycle updates', async () => {
    let tenantRow = createTenantRow('second', { lifecycle_state: 'active' });
    adapters.defaultAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return tenantRow;
      }
      if (op === 'execute' && sql.includes('UPDATE tenants SET lifecycle_state = ?')) {
        tenantRow = {
          ...tenantRow,
          lifecycle_state: String(params[0]),
          updated_at: Number(params[1]),
        };
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    const response = await adminTenantUpdateHandler(
      createContext({ lifecycle_state: 'suspended' }, {}, { id: 'second' })
    );
    expect(response.status).toBe(400);
    expect(tenantRow).toMatchObject({ id: 'second', lifecycle_state: 'active' });
    expect(adapters.defaultAdapter.execute).not.toHaveBeenCalled();
  });

  it('suspends an active tenant through a dedicated idempotent command', async () => {
    let tenantRow = createTenantRow('second', { lifecycle_state: 'active', updated_at: 10 });
    adapters.defaultAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql.includes('FROM admin_jobs')) return null;
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) return tenantRow;
      if (op === 'execute' && sql.includes('UPDATE tenants SET lifecycle_state = ?')) {
        tenantRow = {
          ...tenantRow,
          lifecycle_state: String(params[0]),
          updated_at: Number(params[1]),
        };
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes('INSERT INTO admin_jobs')) {
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const response = await adminTenantSuspendHandler(
      createContext(
        { expected_state: 'active', expected_updated_at: 10, reason: 'contract pause' },
        {},
        { id: 'second' }
      )
    );
    const body = (await response.json()) as { lifecycle_state: string; status: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ lifecycle_state: 'suspended', status: 'completed' });
    expect(tenantRow.lifecycle_state).toBe('suspended');
    expect(tenantRow.updated_at).toBeGreaterThan(10);
  });

  it('queues resume validation without activating the tenant early', async () => {
    let tenantRow = createTenantRow('second', { lifecycle_state: 'suspended', updated_at: 10 });
    adapters.defaultAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql.includes('FROM admin_jobs')) return null;
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) return tenantRow;
      if (op === 'execute' && sql.includes('UPDATE tenants SET lifecycle_state = ?')) {
        tenantRow = { ...tenantRow, updated_at: Number(params[1]) };
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes('INSERT INTO admin_jobs')) {
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const response = await adminTenantResumeHandler(
      createContext(
        { expected_state: 'suspended', expected_updated_at: 10, reason: 'service restored' },
        {},
        { id: 'second' }
      )
    );
    const body = (await response.json()) as { lifecycle_state: string; status: string };

    expect(response.status).toBe(202);
    expect(body).toMatchObject({ lifecycle_state: 'suspended', status: 'pending' });
    expect(tenantRow.lifecycle_state).toBe('suspended');
  });

  it('rejects stale lifecycle commands before writing a job', async () => {
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM admin_jobs')) return null;
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return createTenantRow('second', { lifecycle_state: 'active', updated_at: 11 });
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const response = await adminTenantSuspendHandler(
      createContext(
        { expected_state: 'active', expected_updated_at: 10, reason: 'contract pause' },
        {},
        { id: 'second' }
      )
    );

    expect(response.status).toBe(409);
    expect(adapters.defaultAdapter.execute).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key with a different payload', async () => {
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM admin_jobs')) {
        return {
          id: 'existing-job',
          status: 'completed',
          progress: '{}',
          config: JSON.stringify({
            command: 'freeze',
            source_state: 'active',
            expected_updated_at: 10,
            reason: 'security incident',
            break_glass: false,
          }),
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const response = await adminTenantSuspendHandler(
      createContext(
        { expected_state: 'active', expected_updated_at: 10, reason: 'contract pause' },
        {},
        { id: 'second' }
      )
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe('idempotency_conflict');
    expect(adapters.defaultAdapter.execute).not.toHaveBeenCalled();
  });

  it('requeues a failed lifecycle validation job with retry history preserved', async () => {
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM admin_jobs')) {
        return {
          id: 'lifecycle-job-1',
          status: 'failed',
          config: JSON.stringify({ source_state: 'frozen', reason: 'incident resolved' }),
        };
      }
      if (op === 'execute' && sql.includes('UPDATE admin_jobs')) return { rowsAffected: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const response = await adminTenantLifecycleJobRetryHandler(
      createContext({}, {}, { id: 'second', jobId: 'lifecycle-job-1' })
    );
    const body = (await response.json()) as { status: string; lifecycle_state: string };

    expect(response.status).toBe(202);
    expect(body).toMatchObject({ status: 'pending', lifecycle_state: 'frozen' });
    expect(adapters.defaultAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'pending'"),
      expect.arrayContaining(['lifecycle-job-1', 'second'])
    );
  });

  it('rejects direct PATCH requests to internal lifecycle states', async () => {
    adapters.defaultAdapter = createAdapter();

    const response = await adminTenantUpdateHandler(
      createContext({ lifecycle_state: 'deleted' }, {}, { id: 'second' })
    );

    expect(response.status).toBe(400);
    expect(adapters.defaultAdapter.execute).not.toHaveBeenCalled();
    expect(adapters.defaultAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('rejects direct lifecycle changes from terminal/internal states', async () => {
    const tenantRow = createTenantRow('second', { lifecycle_state: 'deleted' });
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return tenantRow;
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    const response = await adminTenantUpdateHandler(
      createContext({ lifecycle_state: 'active' }, {}, { id: 'second' })
    );
    const body = (await response.json()) as { details?: { variables?: { reason?: string } } };

    expect(response.status).toBe(400);
    expect(body.details?.variables?.reason).toContain('lifecycle_state');
    expect(adapters.defaultAdapter.execute).not.toHaveBeenCalled();
  });

  it('rejects deactivating the current default tenant by row flag', async () => {
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return createTenantRow('second', { is_default: 1 });
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    const response = await adminTenantUpdateHandler(
      createContext({ lifecycle_state: 'suspended' }, {}, { id: 'second' })
    );
    const body = (await response.json()) as { details?: { variables?: { reason?: string } } };

    expect(response.status).toBe(400);
    expect(body.details?.variables?.reason).toContain('lifecycle_state');
    expect(adapters.defaultAdapter.execute).not.toHaveBeenCalled();
  });

  it('queues tenant deletion and lifecycle update in one transaction', async () => {
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (
        op === 'queryOne' &&
        sql === 'SELECT id, is_default, lifecycle_state FROM tenants WHERE id = ?'
      ) {
        return { id: 'second', is_default: 0, lifecycle_state: 'active' };
      }
      if (
        op === 'execute' &&
        (sql.includes("UPDATE tenants SET lifecycle_state = 'deleting'") ||
          sql.includes('INSERT INTO admin_jobs'))
      ) {
        return { rowsAffected: 1 };
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    const response = await adminTenantDeleteHandler(createContext({}, {}, { id: 'second' }));
    const body = (await response.json()) as { job_id: string; status: string };

    expect(response.status).toBe(202);
    expect(body.status).toBe('pending');
    expect(adapters.defaultAdapter.transaction).toHaveBeenCalledOnce();
    expect(adapters.defaultAdapter.execute).toHaveBeenCalledWith(
      "UPDATE tenants SET lifecycle_state = 'deleting', updated_at = ? WHERE id = ?",
      [expect.any(Number), 'second']
    );
    expect(adapters.defaultAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_jobs'),
      expect.arrayContaining(['tenants/delete', 'pending', JSON.stringify({ tenant_id: 'second' })])
    );
  });

  it('rejects deleting the current default tenant by row flag', async () => {
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (
        op === 'queryOne' &&
        sql === 'SELECT id, is_default, lifecycle_state FROM tenants WHERE id = ?'
      ) {
        return { id: 'second', is_default: 1, lifecycle_state: 'active' };
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    const response = await adminTenantDeleteHandler(createContext({}, {}, { id: 'second' }));
    const body = (await response.json()) as { details?: { variables?: { reason?: string } } };

    expect(response.status).toBe(400);
    expect(body.details?.variables?.reason).toBe('Cannot delete the default tenant');
    expect(adapters.defaultAdapter.transaction).not.toHaveBeenCalled();
  });

  it('rejects deleting tenants already in internal lifecycle states', async () => {
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (
        op === 'queryOne' &&
        sql === 'SELECT id, is_default, lifecycle_state FROM tenants WHERE id = ?'
      ) {
        return { id: 'second', is_default: 0, lifecycle_state: 'deleting' };
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });

    const response = await adminTenantDeleteHandler(createContext({}, {}, { id: 'second' }));
    const body = (await response.json()) as { details?: { variables?: { reason?: string } } };

    expect(response.status).toBe(400);
    expect(body.details?.variables?.reason).toBe('Lifecycle state requires a dedicated operation');
    expect(adapters.defaultAdapter.transaction).not.toHaveBeenCalled();
  });

  it('does not invalidate tenant cache when deletion transaction fails', async () => {
    const kv = createKVNamespace();
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (
        op === 'queryOne' &&
        sql === 'SELECT id, is_default, lifecycle_state FROM tenants WHERE id = ?'
      ) {
        return { id: 'second', is_default: 0, lifecycle_state: 'active' };
      }
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });
    adapters.defaultAdapter.transaction.mockRejectedValueOnce(new Error('job insert failed'));

    const response = await adminTenantDeleteHandler(
      createContext({}, { AUTHRIM_CONFIG: kv }, { id: 'second' })
    );

    expect(response.status).toBe(500);
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('keeps a regular provisioned tenant hidden until explicit activation', async () => {
    let row: TenantRow | null = null;
    adapters.defaultAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE id = ?') return row;
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE tenant_code = ?') return null;
      if (op === 'execute' && sql.includes('INSERT INTO tenants')) {
        row = createTenantRowFromInsertParams(params);
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes("SET lifecycle_state = 'active'")) {
        row = row ? { ...row, lifecycle_state: 'active', updated_at: Number(params[0]) } : row;
        return { rowsAffected: 1 };
      }
      if (op === 'queryOne' && sql.startsWith('SELECT id, tenant_code')) return row;
      throw new Error(`unexpected default adapter SQL: ${sql}`);
    });
    adapters.tenantAdapters.set('copy', adapters.defaultAdapter);
    const config = createKVNamespace();
    const context = createContext(
      {},
      {
        DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:shared-d1',
        AUTHRIM_CONFIG: config,
      }
    );

    const provisioned = await provisionTenant(context, {
      id: 'copy',
      tenantCode: 'copy',
      name: 'Copy',
      description: null,
      deferActivation: true,
    });

    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;
    expect(provisioned.tenant.lifecycle_state).toBe('provisioning');
    expect(config.delete).toHaveBeenCalledWith('v1:tenant-exists:copy');
    expect(config.delete).toHaveBeenCalledTimes(1);
    expect(config.put).not.toHaveBeenCalledWith(
      'v1:tenant-exists:copy',
      'true',
      expect.anything()
    );

    const activated = await activateProvisionedTenant(context, 'copy');
    expect(activated.lifecycle_state).toBe('active');
    expect(config.put).toHaveBeenCalledWith('v1:tenant-exists:copy', 'true', {
      expirationTtl: 3600,
    });
    expect(config.delete).toHaveBeenCalledTimes(1);
  });

  it('reports rollback artifacts that could not be removed', async () => {
    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'execute' && sql.includes('DELETE FROM webhook_configs')) {
        throw new Error('D1 unavailable');
      }
      return { rowsAffected: 1 };
    });
    adapters.tenantAdapters.set('copy', adapters.defaultAdapter);
    const context = createContext({}, { DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:shared-d1' });

    const result = await rollbackProvisionedTenant(context, 'copy');

    expect(result.ok).toBe(false);
    expect(result.failures).toContain('webhook_configs');
  });

  it('lists every KV page before deleting rollback keys', async () => {
    adapters.defaultAdapter = createAdapter(() => ({ rowsAffected: 1 }));
    adapters.tenantAdapters.set('copy', adapters.defaultAdapter);
    const store = new Map([
      ['settings:tenant:copy:a', 'a'],
      ['settings:tenant:copy:b', 'b'],
      ['settings:tenant:copy:c', 'c'],
    ]);
    const settings = {
      list: vi.fn(async ({ prefix = '', cursor }: { prefix?: string; cursor?: string }) => {
        const matching = [...store.keys()].filter((key) => key.startsWith(prefix));
        const start = cursor ? Number(cursor) : 0;
        const keys = matching.slice(start, start + 1).map((name) => ({ name }));
        const next = start + keys.length;
        return next >= matching.length
          ? { list_complete: true as const, keys, cacheStatus: null }
          : { list_complete: false as const, keys, cursor: String(next), cacheStatus: null };
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    } as unknown as KVNamespace;

    const result = await rollbackProvisionedTenant(
      createContext(
        {},
        { DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:shared-d1', SETTINGS: settings }
      ),
      'copy'
    );

    expect(result.ok).toBe(true);
    expect([...store.keys()]).toEqual([]);
    expect(settings.list).toHaveBeenCalledTimes(4);
  });
});
