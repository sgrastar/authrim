import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  adminTenantCreateHandler,
  adminTenantDeleteHandler,
  adminTenantGetHandler,
  adminTenantProvisioningCleanupHandler,
  adminTenantProvisioningRetryHandler,
  adminTenantProvisioningStatusHandler,
  adminTenantUpdateHandler,
  adminTenantSuspendHandler,
  adminTenantResumeHandler,
  adminTenantLifecycleJobRetryHandler,
  adminTenantsListHandler,
  activateProvisionedTenantLifecycle,
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
  isolation_policy: 'shared_pool' | 'tenant_exclusive';
  lifecycle_state: string;
  is_default: number;
  created_at: number;
  updated_at: number;
}

const adapters = vi.hoisted(() => ({
  defaultAdapter: null as MockAdapter | null,
  tenantAdapters: new Map<string, MockAdapter>(),
  adminAdapter: null as MockAdapter | null,
}));

const ensureTenantRegionShardConfig = vi.hoisted(() => vi.fn(async () => ({})));

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
  createD1Adapter: vi.fn(() => adapters.defaultAdapter),
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

vi.mock('../tenant-region-shard-policy', () => ({
  ensureTenantRegionShardConfig,
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
    isolation_policy: 'tenant_exclusive',
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
    isolation_policy: String(params[5]) as TenantRow['isolation_policy'],
    lifecycle_state: String(params[6]),
    created_at: Number(params[8]),
    updated_at: Number(params[9]),
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
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      AUTHRIM_CONFIG: createKVNamespace(),
      SETTINGS: createKVNamespace(),
      TENANT_RUNTIME_REGISTRY: createKVNamespace(),
      KEY_MANAGER: createKeyManager(),
      PLUGIN_RUNNER: {
        resolveNotificationProviderOrder: vi.fn(async () => {
          throw new Error('plugin_notification_provider_order_unavailable');
        }),
        replaceNotificationProviderOrder: vi.fn(async (input) => ({
          tenantId: input.tenantId,
          channel: input.channel,
          configVersion: 1,
          state: 'disabled' as const,
          installationIds: [],
        })),
      } as unknown as Env['PLUGIN_RUNNER'],
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

describe('Control Plane tenant management', () => {
  beforeEach(() => {
    adapters.defaultAdapter = null;
    adapters.tenantAdapters.clear();
    adapters.adminAdapter = null;
    vi.clearAllMocks();
  });

  it('lists tenants without reading the retired preallocated slot inventory', async () => {
    adapters.defaultAdapter = createAdapter((sql) => {
      if (sql.includes('FROM tenants')) {
        return [createTenantRow('first', { name: 'First' })];
      }
      return null;
    });
    adapters.adminAdapter = createAdapter(() => {
      throw new Error('legacy slot inventory must not be queried');
    });

    const response = await adminTenantsListHandler(createContext({}));
    const body = (await response.json()) as { tenants: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.tenants).toEqual([expect.objectContaining({ id: 'first' })]);
    expect(adapters.adminAdapter.calls).toEqual([]);
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

  it('accepts Control provisioning without reading a preallocated slot', async () => {
    let tenant: TenantRow | null = null;
    let operation: Record<string, unknown> | null = null;
    const steps: Array<Record<string, unknown>> = [];
    adapters.defaultAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE id = ?') return null;
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE tenant_code = ?') return null;
      if (op === 'execute' && sql.includes('INSERT INTO tenants')) {
        tenant = createTenantRowFromInsertParams(params);
        return { rowsAffected: 1 };
      }
      if (op === 'queryOne' && sql.includes('SELECT id, tenant_code, name')) return tenant;
      throw new Error(`unexpected platform adapter SQL: ${sql}`);
    });
    adapters.adminAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql.includes('WHERE tenant_id = ?')) return null;
      if (op === 'execute' && sql.includes('INSERT INTO tenant_provisioning_operations')) {
        operation = {
          operation_id: params[0],
          environment_id: params[1],
          tenant_id: params[2],
          tenant_code: params[3],
          tenant_name: params[4],
          tenant_description: params[5],
          operation_kind: params[6],
          source_tenant_id: params[7],
          preparation_payload_json: params[8],
          preparation_result_json: null,
          residency_policy_id: params[9],
          residency_partition: params[10],
          isolation_policy: params[11],
          request_hash: params[12],
          idempotency_key: params[13],
          status: 'queued',
          current_step: 'request_accepted',
          capacity_operation_ids_json: '{}',
          default_route_allocation_json: null,
          attempt_count: 0,
          retry_budget_started_at: params[14],
          next_attempt_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          fencing_token: 0,
          created_by: params[15],
          created_at: params[16],
          started_at: null,
          completed_at: null,
          updated_at: params[17],
        };
        return { rowsAffected: 1 };
      }
      if (op === 'execute' && sql.includes('INSERT INTO tenant_provisioning_operation_steps')) {
        steps.push({
          step_key: params[1],
          display_order: params[2],
          status: params[3],
          attempt_count: 0,
          retry_budget_started_at: params[10],
          next_attempt_at: null,
          last_error_code: null,
          observed_resource_id: null,
          started_at: null,
          completed_at: params[4],
          updated_at: params[5],
        });
        return { rowsAffected: 1 };
      }
      if (op === 'queryOne' && sql.includes('WHERE operation_id = ?')) return operation;
      if (op === 'query' && sql.includes('tenant_provisioning_operation_steps')) return steps;
      throw new Error(`unexpected admin adapter SQL: ${sql}`);
    });

    const response = await adminTenantCreateHandler(
      createContext({ id: 'second', name: 'Second Tenant' })
    );
    const body = (await response.json()) as {
      lifecycle_state: string;
      provisioning: {
        mode: string;
        status: string;
        isolation_policy: string;
        steps: unknown[];
      };
    };

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      lifecycle_state: 'provisioning',
      provisioning: {
        mode: 'control-plane',
        status: 'queued',
        isolation_policy: 'tenant_exclusive',
      },
    });
    expect(operation).toMatchObject({ isolation_policy: 'tenant_exclusive' });
    expect(body.provisioning.steps).toHaveLength(9);
    expect(
      adapters.adminAdapter.calls.some((call) => call.sql.includes('tenant_database_slots'))
    ).toBe(false);
  });

  it('adopts a concurrent matching operation without deleting its platform draft', async () => {
    let tenant: TenantRow | null = null;
    let operation: Record<string, unknown> | null = null;
    let tenantOperationReads = 0;
    adapters.defaultAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE id = ?') return null;
      if (op === 'queryOne' && sql === 'SELECT id FROM tenants WHERE tenant_code = ?') return null;
      if (op === 'execute' && sql.includes('INSERT INTO tenants')) {
        tenant = createTenantRowFromInsertParams(params);
        return { rowsAffected: 1 };
      }
      if (op === 'queryOne' && sql.includes('SELECT id, tenant_code, name')) return tenant;
      throw new Error(`unexpected platform adapter SQL: ${sql}`);
    });
    adapters.adminAdapter = createAdapter((sql, params, op) => {
      if (op === 'queryOne' && sql.includes('WHERE tenant_id = ?')) {
        tenantOperationReads += 1;
        return tenantOperationReads === 1 ? null : operation;
      }
      if (op === 'execute' && sql.includes('INSERT INTO tenant_provisioning_operations')) {
        operation = {
          operation_id: params[0],
          environment_id: params[1],
          tenant_id: params[2],
          tenant_code: params[3],
          tenant_name: params[4],
          tenant_description: params[5],
          operation_kind: params[6],
          source_tenant_id: params[7],
          preparation_payload_json: params[8],
          preparation_result_json: null,
          residency_policy_id: params[9],
          residency_partition: params[10],
          isolation_policy: params[11],
          request_hash: params[12],
          idempotency_key: params[13],
          status: 'queued',
          current_step: 'request_accepted',
          capacity_operation_ids_json: '{}',
          default_route_allocation_json: null,
          attempt_count: 0,
          next_attempt_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          fencing_token: 0,
          retry_budget_started_at: params[14],
          created_by: params[15],
          created_at: params[16],
          started_at: null,
          completed_at: null,
          updated_at: params[17],
        };
        throw new Error('UNIQUE constraint failed');
      }
      if (op === 'query' && sql.includes('tenant_provisioning_operation_steps')) return [];
      throw new Error(`unexpected admin adapter SQL: ${sql}`);
    });

    const response = await adminTenantCreateHandler(
      createContext({ id: 'concurrent', name: 'Concurrent Tenant' })
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      id: 'concurrent',
      lifecycle_state: 'provisioning',
      provisioning: { mode: 'control-plane', status: 'queued' },
    });
    expect(
      adapters.defaultAdapter.calls.some(
        (call) => call.op === 'execute' && call.sql.includes('DELETE FROM tenants')
      )
    ).toBe(false);
  });

  it('activates the runtime destination only after the platform row', async () => {
    const order: string[] = [];
    let platformState = 'provisioning';
    let tenantState = 'provisioning';
    const platformAdapter = createAdapter((sql, _params, op) => {
      if (op === 'execute' && sql.includes("lifecycle_state = 'active'")) {
        order.push('platform');
        platformState = 'active';
        return { rowsAffected: 1 };
      }
      if (op === 'queryOne') return { lifecycle_state: platformState };
      throw new Error(`unexpected platform activation SQL: ${sql}`);
    });
    const tenantAdapter = createAdapter((sql, _params, op) => {
      if (op === 'execute' && sql.includes("lifecycle_state = 'active'")) {
        order.push('tenant');
        tenantState = 'active';
        return { rowsAffected: 1 };
      }
      if (op === 'queryOne') return { lifecycle_state: tenantState };
      throw new Error(`unexpected tenant activation SQL: ${sql}`);
    });

    await activateProvisionedTenantLifecycle({
      platformAdapter: platformAdapter as unknown as DatabaseAdapter,
      tenantAdapter: tenantAdapter as unknown as DatabaseAdapter,
      tenantId: 'second',
      now: 100,
    });

    expect(order).toEqual(['platform', 'tenant']);
  });

  it('leaves the runtime destination provisioning when platform activation fails', async () => {
    const platformAdapter = createAdapter((sql, _params, op) => {
      if (op === 'execute' && sql.includes("lifecycle_state = 'active'")) {
        throw new Error('platform write failed');
      }
      throw new Error(`unexpected platform activation SQL: ${sql}`);
    });
    const tenantAdapter = createAdapter();

    await expect(
      activateProvisionedTenantLifecycle({
        platformAdapter: platformAdapter as unknown as DatabaseAdapter,
        tenantAdapter: tenantAdapter as unknown as DatabaseAdapter,
        tenantId: 'second',
        now: 100,
      })
    ).rejects.toThrow('platform write failed');

    expect(tenantAdapter.execute).not.toHaveBeenCalled();
  });

  it('returns the persisted Control provisioning status without mutating it', async () => {
    const operation = {
      operation_id: 'tenant-create-second',
      environment_id: 'test',
      tenant_id: 'second',
      tenant_code: 'second',
      tenant_name: 'Second Tenant',
      tenant_description: null,
      residency_policy_id: 'builtin:residency:default',
      residency_partition: 'default',
      request_hash: 'a'.repeat(64),
      idempotency_key: 'tenant-create-second',
      status: 'waiting_retry',
      current_step: 'capacity_check',
      capacity_operation_ids_json: '{"tenant_core/default":"control-op-default"}',
      default_route_allocation_json: null,
      attempt_count: 2,
      retry_budget_started_at: 100,
      next_attempt_at: 200,
      last_error_code: null,
      lease_owner: null,
      lease_expires_at: null,
      fencing_token: 1,
      created_by: 'platform-admin',
      created_at: 100,
      started_at: 101,
      completed_at: null,
      updated_at: 102,
    };
    adapters.adminAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('WHERE tenant_id = ?')) return operation;
      if (op === 'query' && sql.includes('tenant_provisioning_operation_steps')) {
        return [
          {
            step_key: 'request_accepted',
            display_order: 0,
            status: 'succeeded',
            attempt_count: 0,
            next_attempt_at: null,
            last_error_code: null,
            observed_resource_id: null,
            started_at: 100,
            completed_at: 100,
            updated_at: 100,
          },
          {
            step_key: 'capacity_check',
            display_order: 10,
            status: 'waiting_retry',
            attempt_count: 2,
            next_attempt_at: 200,
            last_error_code: null,
            observed_resource_id: null,
            started_at: 101,
            completed_at: null,
            updated_at: 102,
          },
        ];
      }
      throw new Error(`unexpected status adapter SQL: ${sql}`);
    });

    const response = await adminTenantProvisioningStatusHandler(
      createContext({}, {}, { id: 'second' })
    );
    const body = (await response.json()) as {
      status: string;
      current_step: string;
      capacity_operation_ids: Record<string, string>;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'waiting_retry',
      current_step: 'capacity_check',
      capacity_operation_ids: { 'tenant_core/default': 'control-op-default' },
    });
    expect(adapters.adminAdapter.execute).not.toHaveBeenCalled();
  });

  it('fails closed without querying retired slots when no Control operation exists', async () => {
    adapters.adminAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('FROM tenant_provisioning_operations')) return null;
      throw new Error(`unexpected admin adapter SQL: ${sql}`);
    });

    const retryResponse = await adminTenantProvisioningRetryHandler(
      createContext({}, {}, { id: 'missing-tenant' })
    );
    const cleanupResponse = await adminTenantProvisioningCleanupHandler(
      createContext({}, {}, { id: 'missing-tenant' })
    );

    expect(retryResponse.status).toBe(404);
    expect(cleanupResponse.status).toBe(404);
    expect(
      adapters.adminAdapter.calls.some((call) => call.sql.includes('tenant_database_slots'))
    ).toBe(false);
  });

  it('rejects cleanup after Lookup activation may have started', async () => {
    const operation = {
      operation_id: 'tenant-create-second',
      environment_id: 'test',
      tenant_id: 'second',
      tenant_code: 'second',
      tenant_name: 'Second Tenant',
      tenant_description: null,
      residency_policy_id: 'builtin:residency:default',
      residency_partition: 'default',
      request_hash: 'a'.repeat(64),
      idempotency_key: 'tenant-create-second',
      status: 'waiting_retry',
      current_step: 'lookup_activate',
      capacity_operation_ids_json: '{}',
      default_route_allocation_json: null,
      attempt_count: 3,
      retry_budget_started_at: 100,
      next_attempt_at: 200,
      last_error_code: 'tenant_alias_activation_failed',
      lease_owner: null,
      lease_expires_at: null,
      fencing_token: 2,
      created_by: 'platform-admin',
      created_at: 100,
      started_at: 101,
      completed_at: null,
      updated_at: 102,
    };
    adapters.adminAdapter = createAdapter((sql, _params, op) => {
      if (op === 'queryOne' && sql.includes('WHERE tenant_id = ?')) return operation;
      if (op === 'query' && sql.includes('tenant_provisioning_operation_steps')) return [];
      throw new Error(`unexpected cleanup adapter SQL: ${sql}`);
    });
    const releaseTenantDefaultRoute = vi.fn();

    const response = await adminTenantProvisioningCleanupHandler(
      createContext(
        {},
        { CONTROL: { releaseTenantDefaultRoute } as unknown as Env['CONTROL'] },
        { id: 'second' }
      )
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'tenant_provisioning_cleanup_conflict',
      provisioning: { current_step: 'lookup_activate' },
    });
    expect(adapters.adminAdapter.execute).not.toHaveBeenCalled();
    expect(releaseTenantDefaultRoute).not.toHaveBeenCalled();
  });

  // Preallocated-slot provisioning was retired in favor of Control Worker operations.

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
});
