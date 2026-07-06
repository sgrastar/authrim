import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { DatabaseAdapter } from '../../db';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
  DEFAULT_STORAGE_PROFILE_ID,
} from '../../types/runtime-profile';
import {
  getCachedAuthCorePersistenceContextFromEnv,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveAuthCorePersistenceContextFromEnv,
  resolveAuthCorePersistenceSourceFromContext,
  resolveAuthCorePersistenceSourceFromEnv,
} from '../auth-core-persistence-context';

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

describe('auth-core-persistence-context', () => {
  const sharedD1TransientAuth = {
    sessionColdPersistence: 'enabled',
    sessionClientMirror: 'async',
    deviceCibaColdPersistence: 'enabled',
    externalDurableMirror: 'disabled',
  };

  it('resolves the auth core target from the environment default storage profile', async () => {
    const db = { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database;
    const env = {
      DB: db,
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const context = await resolveAuthCorePersistenceContextFromEnv(env);
    const source = resolveAuthCorePersistenceSourceFromContext(env, context);

    expect(context).toMatchObject({
      storageProfileId: DEFAULT_STORAGE_PROFILE_ID,
      coreTarget: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'core',
      },
      transientAuth: sharedD1TransientAuth,
    });
    expect(source).toBe(db);
  });

  it('pins a custom auth core binding from the default storage profile', async () => {
    const db = { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database;
    const extraCore = createMockAdapter('extra-core');
    const env = {
      DB: db,
      EXTRA_CORE_DB: extraCore,
      AUTHRIM_CONFIG: createMockKV({
        'profile-registry:storage:custom-auth-core': JSON.stringify({
          id: 'custom-auth-core',
          kind: 'storage',
          label: 'Custom Auth Core',
          slices: {
            identity_core: {
              driver: 'postgres',
              bindingRef: 'EXTRA_CORE_DB',
              role: 'core',
            },
          },
        }),
      }),
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID: 'custom-auth-core',
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const context = await resolveAuthCorePersistenceContextFromEnv(env);
    const source = resolveAuthCorePersistenceSourceFromContext(env, context);

    expect(context).toMatchObject({
      storageProfileId: 'custom-auth-core',
      coreTarget: {
        driver: 'postgres',
        bindingRef: 'EXTRA_CORE_DB',
        role: 'core',
      },
      transientAuth: {
        sessionColdPersistence: 'enabled',
        sessionClientMirror: 'sync',
        deviceCibaColdPersistence: 'enabled',
        externalDurableMirror: 'disabled',
      },
    });
    expect(source).toBe(extraCore);
  });

  it('resolves the auth core source directly from env defaults', async () => {
    const db = { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database;
    const env = {
      DB: db,
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    await expect(resolveAuthCorePersistenceSourceFromEnv(env)).resolves.toBe(db);
  });

  it('returns a database adapter for the resolved auth core source', async () => {
    const extraCore = createMockAdapter('extra-core');
    const env = {
      DB: { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database,
      EXTRA_CORE_DB: extraCore,
      AUTHRIM_CONFIG: createMockKV({
        'profile-registry:storage:custom-auth-core': JSON.stringify({
          id: 'custom-auth-core',
          kind: 'storage',
          label: 'Custom Auth Core',
          slices: {
            identity_core: {
              driver: 'postgres',
              bindingRef: 'EXTRA_CORE_DB',
              role: 'core',
            },
          },
        }),
      }),
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID: 'custom-auth-core',
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    await expect(resolveAuthCorePersistenceAdapterFromEnv(env)).resolves.toBe(extraCore);
  });

  it('caches auth core context resolution per env object', async () => {
    const db = { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database;
    const env = {
      DB: db,
      DEFAULT_STORAGE_PROFILE_ID,
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const first = await getCachedAuthCorePersistenceContextFromEnv(env);
    const second = await getCachedAuthCorePersistenceContextFromEnv(env);

    expect(first).toBe(second);
    expect(first).toMatchObject({
      storageProfileId: DEFAULT_STORAGE_PROFILE_ID,
      coreTarget: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'core',
      },
      transientAuth: sharedD1TransientAuth,
    });
  });

  it('does not share a never-settling auth core context promise across calls', async () => {
    const db = { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database;
    const storageProfileKey = 'profile-registry:storage:custom-auth-core';
    const storageProfile = JSON.stringify({
      id: 'custom-auth-core',
      kind: 'storage',
      label: 'Custom Auth Core',
      slices: {
        identity_core: {
          driver: 'd1',
          bindingRef: 'DB',
          role: 'core',
        },
      },
    });
    let profileGetCount = 0;
    let resolveFirstGetStarted: (() => void) | undefined;
    let resolveFirstGet: ((value: string | null) => void) | undefined;
    const firstGetStarted = new Promise<void>((resolve) => {
      resolveFirstGetStarted = resolve;
    });
    const kv = {
      get: vi.fn((key: string) => {
        if (key !== storageProfileKey) {
          return Promise.resolve(null);
        }
        profileGetCount += 1;
        if (profileGetCount === 1) {
          resolveFirstGetStarted?.();
          return new Promise<string | null>((resolve) => {
            resolveFirstGet = resolve;
          });
        }
        return Promise.resolve(storageProfile);
      }),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
    } as unknown as KVNamespace;
    const env = {
      DB: db,
      AUTHRIM_CONFIG: kv,
      PROFILE_REGISTRY_BACKEND: 'kv',
      DEFAULT_STORAGE_PROFILE_ID: 'custom-auth-core',
      DEFAULT_AUDIT_PROFILE_ID,
      DEFAULT_RESIDENCY_PROFILE_ID,
    };

    const first = getCachedAuthCorePersistenceContextFromEnv(env);
    await firstGetStarted;

    const second = getCachedAuthCorePersistenceContextFromEnv(env);
    const secondResult = await Promise.race([
      second,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    resolveFirstGet?.(storageProfile);
    await first;

    if (secondResult === 'timeout') {
      await second;
      throw new Error('second call waited on the first pending auth core context resolution');
    }

    expect(secondResult.storageProfileId).toBe('custom-auth-core');
    expect(profileGetCount).toBe(2);
  });
});
