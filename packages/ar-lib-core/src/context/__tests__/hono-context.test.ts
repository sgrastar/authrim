import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { DatabaseAdapter } from '../../db';
import {
  createAuthContextFromHono,
  createPIIContextFromHono,
  hasPIIDatabase,
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
          };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof createAuthContextFromHono>[0];

    const authCtx = createAuthContextFromHono(c);

    expect(authCtx.tenantId).toBe('tenant-a');
    expect(authCtx.coreAdapter).toBe(coreAdapter);
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
          };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof createPIIContextFromHono>[0];

    const piiCtx = createPIIContextFromHono(c);

    expect(piiCtx.coreAdapter).toBe(sharedAdapter);
    expect(piiCtx.defaultPiiAdapter).toBe(sharedAdapter);
    expect(hasPIIDatabase(c)).toBe(true);
  });
});
