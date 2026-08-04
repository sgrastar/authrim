import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  createRuntimeProfileRegistryFromEnv,
  loadEnvironmentProfileDefaultsFromEnv,
  loadTenantProfileOverridesFromEnv,
  resolveTenantRuntimeProfilesFromEnv,
} from '../runtime-profile-resolver';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
} from '../../types/runtime-profile';

function createMockKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      keys: Array.from(store.keys())
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    })),
  } as unknown as KVNamespace;
}

function createMockAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  };
}

describe('runtime-profile-resolver', () => {
  it('reads environment defaults from env-backed infrastructure settings', async () => {
    const defaults = await loadEnvironmentProfileDefaultsFromEnv({
      DB: createMockAdapter(),
      DEFAULT_AUDIT_PROFILE_ID: DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID: 'builtin:residency:eu',
    });

    expect(defaults).toEqual({
      auditProfileId: DEFAULT_AUDIT_PROFILE_ID,
      residencyProfileId: 'builtin:residency:eu',
    });
  });

  it('reads tenant overrides from AUTHRIM_CONFIG first', async () => {
    const overrides = await loadTenantProfileOverridesFromEnv(
      {
        DB: createMockAdapter(),
        AUTHRIM_CONFIG: createMockKV({
          'settings:tenant:tenant-a:tenant': JSON.stringify({
            'tenant.audit_profile_id': '',
            'tenant.residency_profile_id': 'builtin:residency:eu',
          }),
        }),
      },
      'tenant-a'
    );

    expect(overrides).toEqual({
      auditProfileId: null,
      residencyProfileId: 'builtin:residency:eu',
    });
  });

  it('builds a database-backed registry when PROFILE_REGISTRY_BACKEND=database', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValue(null);

    const registry = createRuntimeProfileRegistryFromEnv({
      DB: adapter,
      PROFILE_REGISTRY_BACKEND: 'database',
    });

    const builtin = await registry.get('audit', DEFAULT_AUDIT_PROFILE_ID);
    expect(builtin?.id).toBe(DEFAULT_AUDIT_PROFILE_ID);
  });

  it('falls back to built-in profiles when no kv registry backend is configured', async () => {
    const registry = createRuntimeProfileRegistryFromEnv({
      DB: createMockAdapter(),
    });

    const builtin = await registry.get('audit', DEFAULT_AUDIT_PROFILE_ID);
    const listed = await registry.list('audit');

    expect(builtin?.id).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(listed.some((profile) => profile.id === DEFAULT_AUDIT_PROFILE_ID)).toBe(true);
  });

  it('resolves effective audit and residency profiles with a tenant residency override', async () => {
    const authrimConfig = createMockKV({
      'settings:tenant:tenant-a:tenant': JSON.stringify({
        'tenant.residency_profile_id': 'builtin:residency:eu',
      }),
    });

    const resolved = await resolveTenantRuntimeProfilesFromEnv(
      {
        DB: createMockAdapter(),
        AUTHRIM_CONFIG: authrimConfig,
        DEFAULT_AUDIT_PROFILE_ID,
        DEFAULT_RESIDENCY_PROFILE_ID,
      },
      'tenant-a'
    );

    expect(resolved.refs.auditProfileId).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(resolved.auditProfile.id).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(resolved.residencyProfile.id).toBe('builtin:residency:eu');
  });
});
