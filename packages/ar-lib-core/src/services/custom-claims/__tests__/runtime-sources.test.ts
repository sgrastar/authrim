import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { DatabaseAdapter } from '../../../db';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
  DEFAULT_STORAGE_PROFILE_ID,
} from '../../../types/runtime-profile';
import { resolveCustomClaimRuntimeSourcesFromEnv } from '../runtime-sources';

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
    list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
      keys: Array.from(store.keys())
        .filter((key) => !prefix || key.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    })),
  } as unknown as KVNamespace;
}

function createMockAdapter(name: string): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue(name),
    close: vi.fn(),
  };
}

describe('resolveCustomClaimRuntimeSourcesFromEnv', () => {
  it('resolves builtin D1 split bindings for custom claims by default', async () => {
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_PII: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      AUTHRIM_CONFIG: createMockKV(),
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveCustomClaimRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.storageProfile.id).toBe(DEFAULT_STORAGE_PROFILE_ID);
    expect(resolved.schemaDb).toBe(env.DB);
    expect(resolved.nonPiiDb).toBe(env.DB);
    expect(resolved.piiDb).toBe(env.DB_PII);
  });

  it('applies tenant override profiles and resolves arbitrary binding refs', async () => {
    const extraCore = createMockAdapter('extra-core');
    const extraPii = createMockAdapter('extra-pii');
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      DB_PII: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      EXTRA_CORE_DB: extraCore,
      EXTRA_PII_DB: extraPii,
      AUTHRIM_CONFIG: createMockKV({
        'profile-registry:storage:tenant-a-storage': JSON.stringify({
          id: 'tenant-a-storage',
          kind: 'storage',
          label: 'Tenant A Storage',
          slices: {
            custom_claims: {
              driver: 'postgres',
              bindingRef: 'EXTRA_CORE_DB',
              role: 'core',
            },
            registration_fields: {
              driver: 'postgres',
              bindingRef: 'EXTRA_CORE_DB',
              role: 'core',
            },
            custom_pii: {
              driver: 'postgres',
              bindingRef: 'EXTRA_PII_DB',
              role: 'pii',
            },
          },
        }),
        'settings:tenant:tenant-a:tenant': JSON.stringify({
          'tenant.storage_profile_id': 'tenant-a-storage',
        }),
      }),
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveCustomClaimRuntimeSourcesFromEnv(env, 'tenant-a');

    expect(resolved.storageProfile.id).toBe('tenant-a-storage');
    expect(resolved.schemaDb).toBe(extraCore);
    expect(resolved.nonPiiDb).toBe(extraCore);
    expect(resolved.piiDb).toBe(extraPii);
  });

  it('fails when a profile points at an unresolved external connection', async () => {
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      AUTHRIM_CONFIG: createMockKV({
        'profile-registry:storage:tenant-a-storage': JSON.stringify({
          id: 'tenant-a-storage',
          kind: 'storage',
          label: 'Tenant A Storage',
          slices: {
            custom_claims: {
              driver: 'postgres',
              connectionRef: 'core-primary',
              role: 'core',
            },
          },
        }),
        'settings:tenant:tenant-a:tenant': JSON.stringify({
          'tenant.storage_profile_id': 'tenant-a-storage',
        }),
      }),
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    await expect(resolveCustomClaimRuntimeSourcesFromEnv(env, 'tenant-a')).rejects.toThrow(
      'storage_profile_connection_not_resolved:core-primary'
    );
  });

  it('resolves storage connectionRef through Hyperdrive bindings', async () => {
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      AUTHRIM_CONFIG: createMockKV({
        'profile-registry:storage:tenant-a-storage': JSON.stringify({
          id: 'tenant-a-storage',
          kind: 'storage',
          label: 'Tenant A Storage',
          slices: {
            custom_claims: {
              driver: 'postgres',
              connectionRef: 'core-primary',
              role: 'core',
            },
            registration_fields: {
              driver: 'postgres',
              connectionRef: 'core-primary',
              role: 'core',
            },
            custom_pii: {
              driver: 'postgres',
              connectionRef: 'pii-primary',
              role: 'pii',
            },
          },
        }),
        'settings:tenant:tenant-a:tenant': JSON.stringify({
          'tenant.storage_profile_id': 'tenant-a-storage',
        }),
      }),
      HYPERDRIVE_CORE_PRIMARY: {
        connectionString: 'postgres://core-primary',
      } as Hyperdrive,
      HYPERDRIVE_PII_PRIMARY: {
        connectionString: 'postgres://pii-primary',
      } as Hyperdrive,
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const resolved = await resolveCustomClaimRuntimeSourcesFromEnv(env, 'tenant-a');

    expect((resolved.schemaDb as DatabaseAdapter).getType()).toBe('postgres');
    expect((resolved.nonPiiDb as DatabaseAdapter).getType()).toBe('postgres');
    expect((resolved.piiDb as DatabaseAdapter)?.getType()).toBe('postgres');
  });
});
