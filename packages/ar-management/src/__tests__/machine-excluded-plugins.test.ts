import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, scheduleAuditLogFromContext: vi.fn() };
});
vi.mock('../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-shared')>();
  return { ...actual, writeAdminAuditLog: vi.fn(async () => 'audit') };
});
vi.mock('@authrim/ar-lib-plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-plugin')>();
  return {
    ...actual,
    getPluginEncryptionKey: vi.fn(async () =>
      crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ])
    ),
    needsBuiltinRegistration: vi.fn().mockResolvedValue(false),
    registerBuiltinPlugins: vi.fn().mockResolvedValue({ registered: 0, skipped: 0, errors: [] }),
  };
});

import {
  enablePluginHandler,
  getPluginConfigHandler,
  listPluginsHandler,
  updatePluginConfigHandler,
} from '../routes/settings/plugins';

/**
 * The REAL platform plugin handlers (list, read and update the configuration, enable), with the
 * REAL shared check. Real: the handlers, their tenant resolution from body, query and header, the
 * settings reader (the exclusion comes from the environment variable), and the check. Stand-ins:
 * the KV (in memory), the Hono context (a small object with `get`, `set`, `json`, `req`) and the
 * encryption key. A machine of a non-platform principal with every tenant and `admin:*` is the
 * caller. "Not named" is a platform-wide operation; "named" is judged.
 */

const PROTECTED = 'default';

function kv(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
    list: vi.fn(async () => ({ keys: [] })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as KVNamespace;
}

const MACHINE = {
  userId: 'amp_auto',
  actorId: 'amp_auto',
  actorType: 'machine',
  authMethod: 'machine_access_token',
  principalType: 'automation',
  clientId: 'auto-client',
  roles: [],
  permissions: ['admin:*'],
  globalPermissions: ['admin:*'],
  tenantScope: ['*'],
  tenantScopeExplicit: [] as string[],
};

function context(options: {
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  exclude?: string;
}) {
  const registry = {
    'test-plugin': {
      id: 'test-plugin',
      version: '1.0.0',
      capabilities: ['notifier.email'],
      official: true,
      meta: { name: 'Test', description: 'd', category: 'notification' },
      source: { type: 'builtin', identifier: 'x' },
      trustLevel: 'official',
      registeredAt: 1,
    },
  };
  const store = new Map<string, unknown>([
    ['tenantId', 'tenant-a'],
    ['adminAuth', { ...MACHINE, ...options.auth }],
    ['pluginTenantScope', 'platform'],
  ]);
  return {
    req: {
      method: options.method ?? 'GET',
      path: '/api/admin/platform/plugins/test-plugin',
      param: (name: string) => (name === 'id' ? 'test-plugin' : undefined),
      query: (name: string) => options.query?.[name],
      header: (name: string) => options.headers?.[name] ?? null,
      json: async () => options.body ?? {},
    },
    env: {
      SETTINGS: kv({ 'plugins:registry': JSON.stringify(registry) }),
      ISSUER_URL: 'https://op.example.com',
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      ...(options.exclude === undefined
        ? {}
        : { MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: options.exclude }),
    } as unknown as Env,
    json: vi.fn(
      (body: unknown, status: number = 200) => new Response(JSON.stringify(body), { status })
    ),
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => void store.set(key, value),
  } as never;
}

const status = async (response: Response | void) => (response ? response.status : 200);
const refusedBody = async (response: Response | void) =>
  response ? await response.json<{ error?: string }>() : {};

beforeEach(() => vi.clearAllMocks());

describe('platform plugin handlers for a non-platform all-tenants machine, a tenant in the list', () => {
  const exclude = PROTECTED;

  it('serves the platform-wide operations that name no tenant', async () => {
    const list = context({ exclude });
    expect(await status(await listPluginsHandler(list))).toBe(200);
    const read = context({ exclude });
    expect(await status(await getPluginConfigHandler(read))).toBe(200);
    const write = context({
      exclude,
      method: 'PUT',
      body: { config: { endpoint: 'https://x.test' } },
    });
    expect(await status(await updatePluginConfigHandler(write))).toBe(200);
    const enable = context({ exclude, method: 'PUT', body: {} });
    expect(await status(await enablePluginHandler(enable))).toBe(200);
  });

  it.each([
    ['query tenant_id', { query: { tenant_id: PROTECTED } }],
    ['the X-Tenant-Id header', { headers: { 'X-Tenant-Id': PROTECTED } }],
  ])('refuses the protected tenant named in %s: list and configuration read', async (_n, named) => {
    for (const handler of [listPluginsHandler, getPluginConfigHandler]) {
      const response = await handler(context({ exclude, ...named }));
      expect(await status(response)).toBe(403);
      expect(await refusedBody(response)).toMatchObject({ error: 'access_denied' });
    }
  });

  it('refuses the protected tenant named in the body: configuration update and enable', async () => {
    const write = context({
      exclude,
      method: 'PUT',
      body: { config: { endpoint: 'https://x.test' }, tenant_id: PROTECTED },
    });
    expect(await status(await updatePluginConfigHandler(write))).toBe(403);
    const enable = context({ exclude, method: 'PUT', body: { tenant_id: PROTECTED } });
    expect(await status(await enablePluginHandler(enable))).toBe(403);
    // Nothing was written.
    expect(
      (write as unknown as { env: { SETTINGS: { put: ReturnType<typeof vi.fn> } } }).env.SETTINGS
        .put
    ).not.toHaveBeenCalled();
  });

  it('serves an unprotected tenant, the setup principal, a human and a named tenant', async () => {
    const other = context({ exclude, query: { tenant_id: 'acme' } });
    expect(await status(await listPluginsHandler(other))).toBe(200);
    for (const auth of [
      { principalType: 'setup_tool', actorId: 'amp_authrim_setup', userId: 'amp_authrim_setup' },
      { authMethod: 'session', actorType: 'human', principalType: undefined, actorId: undefined },
      { tenantScopeExplicit: [PROTECTED] },
    ]) {
      const response = await listPluginsHandler(
        context({ exclude, auth, query: { tenant_id: PROTECTED } })
      );
      expect(await status(response)).toBe(200);
    }
  });

  it('serves everything while the list is empty', async () => {
    for (const named of [{}, { query: { tenant_id: PROTECTED } }]) {
      expect(await status(await listPluginsHandler(context({ exclude: '', ...named })))).toBe(200);
    }
  });
});
