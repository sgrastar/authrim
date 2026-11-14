import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The scheduled scanner also scans the platform database (`env.DB`), where the delete route queues
 * its job, before the tenant stores. The per-store processing is observed through the claim
 * statement each store receives.
 */
interface State {
  tenantStores: Array<{ tenantId: string; source: unknown }>;
  pending: Map<unknown, number>;
  claims: unknown[];
  failPlatformQuery: boolean;
}
const state = vi.hoisted(
  (): State => ({ tenantStores: [], pending: new Map(), claims: [], failPlatformQuery: false })
);

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ensureDatabaseAdapter: (source: unknown, label: string) => ({
      query: async () => {
        if (state.failPlatformQuery && label.endsWith(':platform')) throw new Error('boom');
        const count = state.pending.get(source) ?? 0;
        return Array.from({ length: count }, (_, i) => ({
          id: `job-${i}`,
          tenant_id: 'operator-tenant',
          config: 'not-json',
          attempt_count: 0,
          max_attempts: 1,
          created_at: 1,
        }));
      },
      queryOne: async () => null,
      // Every statement is a claim attempt or a failure write; only claims are recorded, and a
      // claimed job is not offered again.
      execute: async (sql: string) => {
        if (sql.includes("SET status = 'processing'")) {
          state.claims.push(source);
          return { success: true, rowsAffected: 1 };
        }
        return { success: true, rowsAffected: 1 };
      },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(undefined),
    }),
    listEnvironmentTenantDefaultStores: async () =>
      state.tenantStores.map(({ tenantId, source }) => ({
        tenantId,
        store: { source, bindingRef: `ref-${tenantId}` },
      })),
  };
});

import { processPendingTenantDeletionJobs } from '../tenant-deletion-jobs';

const platformDb = { name: 'platform' };
const storeA = { name: 'store-a' };
const storeB = { name: 'store-b' };
const logger = { info: vi.fn(), error: vi.fn() };

function makeEnv(options: { db?: unknown; cursor?: string } = {}) {
  const puts: string[] = [];
  const env = {
    ...('db' in options ? { DB: options.db } : { DB: platformDb }),
    AUTHRIM_CONFIG: {
      get: async () => options.cursor ?? null,
      put: async (_key: string, value: string) => {
        puts.push(value);
      },
    },
  } as never;
  return { env, puts };
}

describe('tenant deletion scanner and the platform database', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.tenantStores = [
      { tenantId: 't-a', source: storeA },
      { tenantId: 't-b', source: storeB },
    ];
    state.pending = new Map();
    state.claims = [];
    state.failPlatformQuery = false;
  });

  it('claims a job that exists only in the platform database', async () => {
    state.pending.set(platformDb, 1);
    const { env } = makeEnv();
    await processPendingTenantDeletionJobs(env, logger);
    expect(state.claims).toEqual([platformDb]);
  });

  it('processes a job once when the platform database is also a tenant store', async () => {
    state.pending.set(platformDb, 1);
    state.tenantStores = [{ tenantId: 't-a', source: platformDb }, ...state.tenantStores.slice(1)];
    const { env } = makeEnv();
    await processPendingTenantDeletionJobs(env, logger);
    expect(state.claims).toEqual([platformDb]);
  });

  it('still scans the tenant stores, and logs, when the platform scan throws', async () => {
    state.failPlatformQuery = true;
    state.pending.set(storeB, 1);
    const { env } = makeEnv();
    await processPendingTenantDeletionJobs(env, logger);
    expect(logger.error).toHaveBeenCalledWith(
      'Tenant deletion platform job scan failed',
      {},
      expect.any(Error)
    );
    expect(state.claims).toEqual([storeB]);
  });

  it('scans the tenant stores without throwing when env.DB is missing', async () => {
    state.pending.set(storeA, 1);
    const { env } = makeEnv({ db: undefined });
    await expect(processPendingTenantDeletionJobs(env, logger)).resolves.toBeUndefined();
    expect(state.claims).toEqual([storeA]);
  });

  it('keeps the cursor and skips the tenant stores when the platform scan spends the budget', async () => {
    state.pending.set(platformDb, 5);
    state.pending.set(storeA, 1);
    const { env, puts } = makeEnv({ cursor: 't-prev' });
    await processPendingTenantDeletionJobs(env, logger);
    expect(state.claims).toHaveLength(5);
    expect(state.claims.every((source) => source === platformDb)).toBe(true);
    expect(puts).toEqual([]);
  });

  it('keeps the tenant cursor semantics when the platform scan stays under budget', async () => {
    state.pending.set(platformDb, 1);
    const { env, puts } = makeEnv({ cursor: 't-prev' });
    await processPendingTenantDeletionJobs(env, logger);
    expect(puts).toEqual(['']);
  });
});
