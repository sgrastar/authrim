import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  adminTenantCreateHandler,
  adminTenantProvisioningCleanupHandler,
  adminTenantProvisioningRetryHandler,
  adminTenantsListHandler,
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
  is_active: number;
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
  AR_ERROR_CODES: {
    ADMIN_RESOURCE_NOT_FOUND: 'admin_resource_not_found',
    INTERNAL_ERROR: 'internal_error',
    VALIDATION_INVALID_VALUE: 'validation_invalid_value',
  },
  createAuthContextFromHono: vi.fn((_c: unknown, tenantId: string) => ({
    coreAdapter: adapters.tenantAdapters.get(tenantId) ?? adapters.defaultAdapter,
  })),
  createAuditLogFromContext: vi.fn(async () => {}),
  createErrorResponse: vi.fn((_c: unknown, code: string, details?: unknown) => {
    const status =
      code === 'validation_invalid_value' ? 400 : code === 'admin_resource_not_found' ? 404 : 500;
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

function createTenantRow(
  id: string,
  overrides: Partial<TenantRow> = {}
): TenantRow {
  return {
    id,
    tenant_code: id,
    name: id,
    description: null,
    is_active: 1,
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
    is_active: Number(params[5]),
    created_at: Number(params[7]),
    updated_at: Number(params[8]),
  });
}

function createContext(
  body: Record<string, unknown>,
  envOverrides: Partial<Env> = {},
  routeParams: Record<string, string> = {}
) {
  const responseHeaders = new Headers();
  return {
    req: {
      json: vi.fn(async () => body),
      param: vi.fn((name: string) => routeParams[name]),
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
        return { adminId: 'platform-admin', roles: ['system_admin'] };
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
      if (op === 'queryOne' && sql.includes('FROM tenant_database_slots') && sql.includes('LIMIT 1')) {
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
      if (op === 'execute' && sql.includes('UPDATE tenants SET is_active = 1')) {
        if (controlTenant) {
          controlTenant = { ...controlTenant, is_active: 1, updated_at: Number(params[0]) };
        }
        return { rowsAffected: 1 };
      }
      if (
        op === 'queryOne' &&
        sql.includes(
          'SELECT id, tenant_code, name, description, is_active, is_default, created_at, updated_at FROM tenants WHERE id = ?'
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
      is_active: boolean;
      provisioning: { mode: string; slot_id: string; smoke_test: string };
    };

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      id: 'second',
      is_active: true,
      provisioning: {
        mode: 'tenant-d1-preallocated-pool',
        slot_id: 'slot-0001',
        smoke_test: 'passed',
      },
    });
    expect(tenantDbRow).toMatchObject({ id: 'second', is_active: 1 });
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
      if (op === 'execute' && sql.includes('UPDATE tenants SET is_active = 0')) {
        if (controlTenant) {
          controlTenant = {
            ...controlTenant,
            is_active: 0,
            updated_at: Number(params[0]),
          };
        }
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes('DELETE FROM tenants')) {
        controlTenant = null;
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
        return slotState === 'available' ? { ...slot, state: slotState, assigned_tenant_id: null } : null;
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
    expect(controlTenant).toMatchObject({ id: 'second', is_active: 0 });
  });

  it('cleans up a failed provisioning draft without releasing the reset-required slot', async () => {
    const slot = createSlot({
      state: 'reset_required',
      assigned_tenant_id: 'second',
    });
    let controlTenant: TenantRow | null = createTenantRow('second', { is_active: 0 });
    let cleanupAuditWritten = false;

    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return controlTenant;
      }
      if (op === 'execute' && sql.includes('DELETE FROM tenants')) {
        controlTenant = null;
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
    expect(controlTenant).toBeNull();
    expect(cleanupAuditWritten).toBe(true);
  });

  it('rejects provisioning retry while the failed slot still requires reset', async () => {
    const slot = createSlot({
      state: 'reset_required',
      assigned_tenant_id: 'second',
    });

    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return createTenantRow('second', { is_active: 0 });
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
      if (op === 'queryOne' && sql.includes('SELECT * FROM tenant_database_slots WHERE slot_id = ?')) {
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
    let controlTenant: TenantRow | null = createTenantRow('second', { is_active: 0 });
    let tenantDbRow: TenantRow | null = null;

    adapters.defaultAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return controlTenant;
      }
      if (op === 'execute' && sql.includes('INSERT INTO tenants')) {
        controlTenant = createTenantRowFromInsertParams(params);
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes('UPDATE tenants SET is_active = 1')) {
        if (controlTenant) {
          controlTenant = {
            ...controlTenant,
            is_active: 1,
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
      if (op === 'queryOne' && sql.includes('SELECT slot_id, state, updated_at FROM tenant_database_slots')) {
        return { slot_id: slot.slot_id, state: slotState, updated_at: 1_700_000_010 };
      }
      if (op === 'queryOne' && sql.includes('SELECT * FROM tenant_database_slots WHERE slot_id = ?')) {
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
      is_active: boolean;
      provisioning: { retry: string; slot_id: string };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id: 'second',
      is_active: true,
      provisioning: { retry: 'succeeded', slot_id: 'slot-0001' },
    });
    expect(slotState).toBe('assigned');
    expect(controlTenant).toMatchObject({ id: 'second', is_active: 1 });
    expect(tenantDbRow).toMatchObject({ id: 'second', is_active: 1 });
  });

  it('rejects provisioning retry when the failed slot has already been reused', async () => {
    const reusedSlot = createSlot({
      state: 'assigned',
      assigned_tenant_id: 'third',
    });
    let retryAuditWritten = false;

    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return createTenantRow('second', { is_active: 0 });
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
    let controlTenant: TenantRow | null = createTenantRow('second', { is_active: 0 });

    adapters.defaultAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenants WHERE id = ?')) {
        return controlTenant;
      }
      if (op === 'execute' && sql.includes('DELETE FROM tenants')) {
        controlTenant = null;
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
    expect(controlTenant).toBeNull();
  });
});
