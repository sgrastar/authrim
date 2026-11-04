import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import {
  createRuntimeProfileRegistryFromEnv,
  loadEnvironmentProfileDefaultsFromEnv,
  loadTenantProfileOverridesFromEnv,
  resolveTenantAuditProfileFromEnv,
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

  it('resolves the audit profile on its own: a missing residency profile does not change it', async () => {
    const audit = {
      id: 'tenant-audit',
      kind: 'audit',
      label: 'Tenant audit',
      builtin: false,
      primary: null,
      archive: null,
      sinks: [{ type: 'http', url: 'https://logs.example.com/in' }],
      retention: { eventLogRetentionDays: 400, piiLogRetentionDays: 400 },
    };
    const env = {
      DB: createMockAdapter(),
      AUTHRIM_CONFIG: createMockKV({
        'profile-registry:audit:tenant-audit': JSON.stringify(audit),
        'settings:tenant:tenant-a:tenant': JSON.stringify({
          'tenant.audit_profile_id': 'tenant-audit',
          // An id nobody registered (or a profile deleted while in use).
          'tenant.residency_profile_id': 'residency-gone',
        }),
      }),
    };

    // The set cannot be resolved (this is what made the audit service use the built-in profile).
    await expect(resolveTenantRuntimeProfilesFromEnv(env, 'tenant-a')).rejects.toThrow(
      'residency_profile_not_found:residency-gone'
    );
    // The audit profile is still the tenant's own.
    expect(await resolveTenantAuditProfileFromEnv(env, 'tenant-a')).toMatchObject({
      id: 'tenant-audit',
      sinks: audit.sinks,
      retention: audit.retention,
    });
    // A missing audit profile still throws (the audit service then falls back, as before).
    await expect(
      resolveTenantAuditProfileFromEnv(
        {
          ...env,
          AUTHRIM_CONFIG: createMockKV({
            'settings:tenant:tenant-a:tenant': JSON.stringify({
              'tenant.audit_profile_id': 'audit-gone',
            }),
          }),
        },
        'tenant-a'
      )
    ).rejects.toThrow('audit_profile_not_found:audit-gone');
  });
});
