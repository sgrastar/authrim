import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { DatabaseAdapter } from '../../db';
import {
  createAccountAuthContextFromHono,
  createAuthContextFromHono,
  createPIIContextFromHono,
  hasPIIDatabase,
  resolveOptionalCoreAdapterFromHono,
} from '../hono-context';

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

function createMockD1(): D1Database {
  return {
    prepare: vi.fn(),
    batch: vi.fn(),
  } as unknown as D1Database;
}

describe('hono-context runtime user store sources', () => {
  it('uses pre-resolved user store sources for the auth context core adapter', () => {
    const coreAdapter = createMockAdapter('core-profiled');
    const c = {
      env: { DB: createMockD1() },
      get(key: string) {
        if (key === 'tenantId') return 'tenant-a';
        if (key === 'runtimeUserStoreSources') {
          return {
            storageProfile: {
              id: 'tenant-a-storage',
              kind: 'storage',
              label: 'Tenant A Storage',
              slices: {},
            },
            coreDb: coreAdapter,
            piiDb: null,
            userCacheScope: {
              storageProfileId: 'tenant-a-storage',
              sourceGeneration: 'core:1:pii:0',
              schemaVersion: 'core:1:pii:1',
            },
            piiCacheMode: 'no_cross_request_pii',
          };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof createAuthContextFromHono>[0];

    const authCtx = createAuthContextFromHono(c);

    expect(authCtx.tenantId).toBe('tenant-a');
    expect(authCtx.coreAdapter).toBe(coreAdapter);
    expect(authCtx.userCacheScope?.storageProfileId).toBe('tenant-a-storage');
    expect(authCtx.piiCacheMode).toBe('no_cross_request_pii');
  });

  it('rejects auth context creation when tenant context is missing', () => {
    const c = {
      env: { DB: createMockD1() },
      get() {
        return undefined;
      },
    } as unknown as Parameters<typeof createAuthContextFromHono>[0];

    expect(() => createAuthContextFromHono(c)).toThrow('requires tenant context');
  });

  it('resolves an optional core adapter from pre-resolved user store sources', () => {
    const coreAdapter = createMockAdapter('core-profiled');
    const c = {
      env: {},
      get(key: string) {
        if (key === 'runtimeUserStoreSources') {
          return {
            storageProfile: {
              id: 'tenant-a-storage',
              kind: 'storage',
              label: 'Tenant A Storage',
              slices: {},
            },
            coreDb: coreAdapter,
            piiDb: null,
            policyDb: null,
          };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof resolveOptionalCoreAdapterFromHono>[0];

    expect(resolveOptionalCoreAdapterFromHono(c, 'refresh-token-sharding-config')).toBe(
      coreAdapter
    );
  });

  it('resolves policy adapters from the pre-resolved policy source', () => {
    const coreAdapter = createMockAdapter('core-profiled');
    const policyAdapter = createMockAdapter('policy-profiled');
    const c = {
      env: {},
      get(key: string) {
        if (key === 'runtimeUserStoreSources') {
          return {
            storageProfile: {
              id: 'tenant-a-storage',
              kind: 'storage',
              label: 'Tenant A Storage',
              slices: {},
            },
            coreDb: coreAdapter,
            piiDb: null,
            policyDb: policyAdapter,
          };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof resolveOptionalCoreAdapterFromHono>[0];

    expect(resolveOptionalCoreAdapterFromHono(c, 'policy')).toBe(policyAdapter);
    expect(resolveOptionalCoreAdapterFromHono(c, 'rebac')).toBe(policyAdapter);
    expect(resolveOptionalCoreAdapterFromHono(c, 'core')).toBe(coreAdapter);
  });

  it('returns null when no optional core adapter source is available', () => {
    const c = {
      env: {},
      get() {
        return undefined;
      },
    } as unknown as Parameters<typeof resolveOptionalCoreAdapterFromHono>[0];

    expect(resolveOptionalCoreAdapterFromHono(c, 'refresh-token-sharding-config')).toBeNull();
  });

  it('uses pre-resolved user store sources for the pii context, including single-db profiles', () => {
    const sharedAdapter = createMockAdapter('shared-profiled');
    const c = {
      env: { DB: createMockD1(), AUTHRIM_CONFIG: undefined },
      get(key: string) {
        if (key === 'tenantId') return 'tenant-a';
        if (key === 'runtimeUserStoreSources') {
          return {
            storageProfile: {
              id: 'builtin:storage:single-db',
              kind: 'storage',
              label: 'Single Database',
              slices: {},
            },
            coreDb: sharedAdapter,
            piiDb: sharedAdapter,
            userCacheScope: {
              storageProfileId: 'builtin:storage:single-db',
              sourceGeneration: 'core:0:pii:0',
              schemaVersion: 'core:1:pii:1',
            },
            piiCacheMode: 'merged',
          };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof createPIIContextFromHono>[0];

    const piiCtx = createPIIContextFromHono(c);

    expect(piiCtx.coreAdapter).toBe(sharedAdapter);
    expect(piiCtx.defaultPiiAdapter).toBe(sharedAdapter);
    expect(piiCtx.userCacheScope?.storageProfileId).toBe('builtin:storage:single-db');
    expect(piiCtx.piiCacheMode).toBe('merged');
    expect(hasPIIDatabase(c)).toBe(true);
  });

  it('rejects pii context creation when tenant context is missing', () => {
    const sharedAdapter = createMockAdapter('shared-profiled');
    const c = {
      env: { DB: createMockD1(), AUTHRIM_CONFIG: undefined },
      get(key: string) {
        if (key === 'runtimeUserStoreSources') {
          return {
            storageProfile: {
              id: 'builtin:storage:single-db',
              kind: 'storage',
              label: 'Single Database',
              slices: {},
            },
            coreDb: sharedAdapter,
            piiDb: sharedAdapter,
          };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof createPIIContextFromHono>[0];

    expect(() => createPIIContextFromHono(c)).toThrow('requires tenant context');
  });

  it('uses the explicit tenant metadata context instead of a legacy runtime source', () => {
    const metadataAdapter = createMockAdapter('tenant-metadata');
    const legacyAdapter = createMockAdapter('legacy-runtime');
    const c = {
      env: { DB: createMockD1() },
      get(key: string) {
        if (key === 'tenantId') return 'tenant-a';
        if (key === 'tenantMetadataContext') {
          return {
            tenantId: 'tenant-a',
            storageProfileId: 'builtin:storage:tenant-d1',
            coreDb: metadataAdapter,
          };
        }
        if (key === 'runtimeUserStoreSources') return { coreDb: legacyAdapter };
        return undefined;
      },
    } as unknown as Parameters<typeof createAuthContextFromHono>[0];

    expect(createAuthContextFromHono(c).coreAdapter).toBe(metadataAdapter);
  });

  it('fails closed instead of using a fallback PII binding without an account context', () => {
    const c = {
      env: { DB: createMockD1(), DB_PII: createMockD1() },
      get(key: string) {
        if (key === 'tenantId') return 'tenant-a';
        if (key === 'tenantMetadataContext') {
          return {
            tenantId: 'tenant-a',
            storageProfileId: 'builtin:storage:tenant-d1',
            coreDb: createMockAdapter('tenant-metadata'),
          };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof createPIIContextFromHono>[0];

    expect(() => createPIIContextFromHono(c)).toThrow('account_data_context_required');
    expect(hasPIIDatabase(c)).toBe(false);
  });

  it('uses one explicit account route for tenant-D1 core and PII access', () => {
    const accountCore = createMockAdapter('account-core');
    const accountPii = createMockAdapter('account-pii');
    const c = {
      env: { DB: createMockD1(), DB_PII: createMockD1() },
      get(key: string) {
        if (key === 'tenantId') return 'tenant-a';
        if (key === 'tenantMetadataContext') {
          return {
            tenantId: 'tenant-a',
            storageProfileId: 'builtin:storage:tenant-d1',
            coreDb: createMockAdapter('tenant-metadata'),
          };
        }
        if (key === 'accountDataContext') {
          return {
            tenantId: 'tenant-a',
            accountId: 'account:user-a',
            coreDb: accountCore,
            piiDb: accountPii,
            userCacheScope: {
              storageProfileId: 'builtin:storage:tenant-d1',
              sourceGeneration: 'account:3:core:8:pii:9',
              schemaVersion: 'route:1',
            },
            piiCacheMode: 'no_cross_request_pii',
          };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof createPIIContextFromHono>[0];

    const context = createPIIContextFromHono(c);
    expect(context.coreAdapter).toBe(accountCore);
    expect(context.defaultPiiAdapter).toBe(accountPii);
    expect(context.userCacheScope?.sourceGeneration).toBe('account:3:core:8:pii:9');
    expect(context.piiCacheMode).toBe('no_cross_request_pii');
    expect(hasPIIDatabase(c)).toBe(true);
  });

  it('uses the explicit tenant-D1 account core source for account auth context', () => {
    const metadataCore = createMockAdapter('tenant-metadata');
    const accountCore = createMockAdapter('account-core');
    const c = {
      env: { DB: createMockD1() },
      get(key: string) {
        if (key === 'tenantId') return 'tenant-a';
        if (key === 'tenantMetadataContext') {
          return {
            tenantId: 'tenant-a',
            storageProfileId: 'builtin:storage:tenant-d1',
            coreDb: metadataCore,
          };
        }
        if (key === 'accountDataContext') {
          return {
            tenantId: 'tenant-a',
            coreDb: accountCore,
            userCacheScope: { storageProfileId: 'builtin:storage:tenant-d1' },
            piiCacheMode: 'no_cross_request_pii',
          };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof createAccountAuthContextFromHono>[0];

    expect(createAuthContextFromHono(c).coreAdapter).toBe(metadataCore);
    expect(createAccountAuthContextFromHono(c).coreAdapter).toBe(accountCore);
  });

  it('requires an account route for tenant-D1 account auth context', () => {
    const c = {
      env: { DB: createMockD1() },
      get(key: string) {
        if (key === 'tenantId') return 'tenant-a';
        if (key === 'tenantMetadataContext') {
          return {
            tenantId: 'tenant-a',
            storageProfileId: 'builtin:storage:tenant-d1',
            coreDb: createMockAdapter('tenant-metadata'),
          };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof createAccountAuthContextFromHono>[0];

    expect(() => createAccountAuthContextFromHono(c)).toThrow('account_data_context_required');
  });
});
