import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
const state = vi.hoisted(() => ({
  prior: false,
  pending: true,
  matches: [] as unknown[],
  events: [] as string[],
  write: vi.fn(),
  publish: vi.fn(),
  lookup: vi.fn(),
  persist: vi.fn(),
  sync: vi.fn(),
}));
vi.mock('../account-creation-operation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../account-creation-operation')>()),
  AccountCreationOperationRepository: class {
    async findForActor() {
      return state.prior ? { status: 'directory_pending' } : null;
    }
  },
}));
vi.mock('../cross-shard-account-list', () => ({
  CrossShardAccountExactSearchService: class {
    find(input: unknown) {
      state.lookup(input);
      return Promise.resolve(state.matches);
    }
  },
}));
vi.mock('../account-authoritative-write', () => ({
  writeCanonicalAccountAuthoritative: async (input: unknown) => {
    state.events.push('canonical');
    state.write(input);
    return { userId: 'csv-user' };
  },
}));
vi.mock('../account-directory-producer', () => ({
  executeDurableInitialAccountDirectoryWrite: (...args: unknown[]) => state.publish(...args),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    generateUserIdFromSettings: async () => 'csv-user',
    validateCustomClaimWrite: async () => ({
      ok: true,
      nonPiiValues: {},
      piiValues: {},
      nonPiiKeysToDelete: [],
      piiKeysToDelete: [],
    }),
    persistCustomClaimWrite: async (input: unknown) => {
      state.events.push('custom');
      state.persist(input);
    },
    syncUserLifecycleState: async () => {
      state.events.push('lifecycle');
    },
    invalidateUserCache: async () => {},
    transitionAccountAuthenticationState: async () => {
      state.events.push('auth-state');
    },
    CanonicalRuntimeUserStore: class {
      async findById() {
        return { id: 'existing', registration_state: 'registered', active: 1, email_verified: 1 };
      }
      async syncUser(input: unknown) {
        state.events.push('update');
        state.sync(input);
      }
    },
  };
});
import { parseUserImportCsv, processImportedRow } from '../user-import-jobs';
function adapter(): DatabaseAdapter {
  return {
    getType: () => 'mock',
    query: async () => [],
    queryOne: async () => null,
    batch: async () => [],
    transaction: async (fn: (db: DatabaseAdapter) => Promise<unknown>) => fn(adapter()),
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'mock' }),
    close: async () => {},
    execute: async (sql: string) => {
      state.events.push(sql.startsWith('INSERT') ? 'boundary-open' : 'boundary-close');
      return { success: true, rowsAffected: 1 };
    },
  } as DatabaseAdapter;
}
const metadata = adapter(),
  accountCore = adapter(),
  accountPii = adapter();
const runtime = {
  tenantId: 'tenant-a',
  jobId: 'job-a',
  env: { ACCOUNT_CORE: accountCore, ACCOUNT_PII: accountPii } as unknown as Env,
  metadata,
};
const options = { skip_header: true, on_duplicate: 'update' as const, validate_only: false };
beforeEach(() => {
  vi.clearAllMocks();
  state.prior = false;
  state.pending = true;
  state.matches = [];
  state.events = [];
  state.publish.mockImplementation(async (_env, input, dependencies) => {
    if (!state.prior) {
      await dependencies.writeAuthoritative({
        publication: {
          accountId: 'account:csv-user',
          tenantId: 'tenant-a',
          operationId: input.candidateOperationId,
        },
        tenantCoreUsers: accountCore,
        tenantPii: accountPii,
      });
      state.events.push('publish');
    }
    return { delivery: { status: state.pending ? 202 : 201 }, operation: { userId: 'csv-user' } };
  });
});
describe('CSV account publication and grouping input boundary', () => {
  it('normalizes columns and types before writing, and publishes only after all saved inputs settle', async () => {
    const { records } = parseUserImportCsv(
      'Email,Name,email_verified\nperson@example.com,Alice,true',
      { skip_header: true }
    );
    const result = await processImportedRow(runtime, records[0], 2, options);
    expect(result.outcome).toBe('pending');
    expect(state.write.mock.calls[0][0].runtimeUser).toMatchObject({
      emailVerified: true,
      sensitiveValues: { email: 'person@example.com', name: 'Alice' },
    });
    expect(state.persist.mock.calls[0][0]).toMatchObject({
      db: accountCore,
      dbPii: accountPii,
      schemaDb: metadata,
    });
    expect(state.events).toEqual([
      'boundary-open',
      'canonical',
      'custom',
      'lifecycle',
      'boundary-close',
      'publish',
    ]);
  });
  it('resumes the same pinned row before duplicate handling and does not recreate the account', async () => {
    const record = { email: 'person@example.com' };
    await processImportedRow(runtime, record, 2, options);
    const first = state.publish.mock.calls[0][1];
    state.prior = true;
    state.pending = false;
    state.lookup.mockClear();
    expect(
      (await processImportedRow(runtime, record, 2, { ...options, on_duplicate: 'error' })).outcome
    ).toBe('created');
    expect(state.lookup).not.toHaveBeenCalled();
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.publish.mock.calls[1][1]).toMatchObject({
      candidateOperationId: first.candidateOperationId,
      idempotencyKey: first.idempotencyKey,
      requestHash: first.requestHash,
    });
  });
  it('uses the existing account shard for updates instead of the tenant metadata database', async () => {
    state.matches = [
      { legacyUserId: 'existing', coreBindingRef: 'ACCOUNT_CORE', piiBindingRef: 'ACCOUNT_PII' },
    ];
    const result = await processImportedRow(
      runtime,
      { email: 'person@example.com', name: 'Updated' },
      2,
      options
    );
    expect(result.outcome).toBe('updated');
    expect(state.sync).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'existing', name: 'Updated' })
    );
    expect(state.events).toEqual(['boundary-open', 'update', 'boundary-close']);
    expect(state.publish).not.toHaveBeenCalled();
  });
  it('does not publish during validation and rejects ambiguous accounts', async () => {
    expect(
      (
        await processImportedRow(runtime, { email: 'person@example.com' }, 2, {
          ...options,
          validate_only: true,
        })
      ).outcome
    ).toBe('validated');
    expect(state.publish).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
    state.matches = [{}, {}];
    await expect(
      processImportedRow(runtime, { email: 'person@example.com' }, 2, options)
    ).rejects.toThrow('ambiguous');
  });
});
