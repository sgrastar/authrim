/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
/**
 * Shared fakes for the tenant mutation tests: the ar-lib-core override used with `vi.mock`, a
 * SQL-routing adapter, a KV namespace, a key manager and a Hono-like context. In-memory only.
 */
import { vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

export type QueryOp = 'query' | 'queryOne' | 'execute';

export interface MockAdapter {
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

export interface TenantRow {
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

export const adapters = {
  defaultAdapter: null as MockAdapter | null,
  tenantAdapters: new Map<string, MockAdapter>(),
  adminAdapter: null as MockAdapter | null,
  /** DB_ADMIN, where tenant lifecycle validation jobs are kept. */
  lifecycleJobsAdapter: null as MockAdapter | null,
};

export const seedBuiltinProfileClaimSchemas = vi.fn(async () => 8);
export const ensureTenantRegionShardConfig = vi.fn(async () => ({}));

export function buildCoreMock() {
  return {
    ADMIN_ROLE_GROUPS: {
      platform: ['ar_super_admin'],
      tenantAdmin: ['ar_tenant_admin', 'ar_super_admin'],
    },
    ADMIN_PERMISSIONS: {
      SETTINGS_READ: 'admin:settings:read',
      TENANT_LIFECYCLE_BREAK_GLASS: 'admin:tenants:lifecycle:break_glass',
      TENANT_PROVISION: 'admin:tenants:provision',
      TENANT_DELETE: 'admin:tenants:delete',
    },
    hasAdminPermission: vi.fn((permissions: string[], required: string) =>
      permissions.includes(required)
    ),
    hasGlobalAdminPermission: vi.fn(
      (
        auth: { tenantScope?: string[]; globalPermissions?: string[] } | undefined,
        required: string
      ) =>
        (auth?.tenantScope ?? []).includes('*') &&
        (auth?.globalPermissions ?? []).some(
          (permission) => permission === '*' || permission === required
        )
    ),
    hasGlobalMachinePermission: vi.fn(
      (
        auth:
          | { authMethod?: string; tenantScope?: string[]; globalPermissions?: string[] }
          | undefined,
        required: string
      ) =>
        auth?.authMethod === 'machine_access_token' &&
        (auth?.tenantScope ?? []).includes('*') &&
        (auth?.globalPermissions ?? []).some(
          (permission) => permission === '*' || permission === 'admin:*' || permission === required
        )
    ),
    hasGlobalAdminRole: vi.fn(
      (
        auth: { tenantScope?: string[]; globalRoles?: string[] } | undefined,
        roles: readonly string[]
      ) =>
        (auth?.tenantScope ?? []).includes('*') &&
        (auth?.globalRoles ?? []).some((role) => roles.includes(role))
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
    getDefaultTenantId: vi.fn(
      (env: { DEFAULT_TENANT_ID?: string }) => env?.DEFAULT_TENANT_ID || 'default'
    ),
    isReservedPlatformTenantId: vi.fn((id: string) => id.trim().toLowerCase() === 'platform'),
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
    seedBuiltinProfileClaimSchemas,
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
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => {
      if (!adapters.lifecycleJobsAdapter) {
        throw new Error('lifecycle jobs adapter not configured');
      }
      return adapters.lifecycleJobsAdapter;
    }),
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
  };
}

export function createAdapter(
  handler: (sql: string, params: unknown[], op: QueryOp, adapter: MockAdapter) => unknown = () =>
    null
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
    // The default answer is a batch whose statements each matched one row.
    batch: vi.fn(async () => [
      { rowsAffected: 1, success: true },
      { rowsAffected: 1, success: true },
    ]),
    isHealthy: vi.fn(async () => ({ healthy: true, latency: 0 })),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => {}),
  } as MockAdapter;
  return adapter;
}

export function createKVNamespace() {
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

export function createKeyManager() {
  const durableObject = {
    getStatusRpc: vi.fn(async () => ({ activeKeyId: null })),
    rotateKeysRpc: vi.fn(async () => {}),
  };
  return {
    idFromName: vi.fn((name: string) => ({ name })),
    get: vi.fn(() => durableObject),
  } as unknown as Env['KEY_MANAGER'];
}

export function createTenantRow(id: string, overrides: Partial<TenantRow> = {}): TenantRow {
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

export function createTenantRowFromInsertParams(params: unknown[]): TenantRow {
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

export function createContext(
  body: Record<string, unknown>,
  envOverrides: Partial<Env> = {},
  routeParams: Record<string, string> = {},
  adminAuth: Record<string, unknown> = {
    userId: 'platform-admin',
    roles: ['ar_super_admin'],
    // The role comes from a global assignment.
    globalRoles: ['ar_super_admin'],
    tenantScope: ['*'],
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
