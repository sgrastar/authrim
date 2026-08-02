import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  existing: null as { id: string } | null,
  reflectedPayload: null as string | null,
  createFromRuntimeUser: vi.fn(),
  syncFromRuntimeUser: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  accountDirectoryOutboxId: (operationId: string) => `account-directory:${operationId}`,
  CanonicalIdentityRepository: class {
    async findAccountByLegacyUserId() {
      return state.existing;
    }
  },
  CanonicalRuntimeUserWriter: class {
    createFromRuntimeUser = state.createFromRuntimeUser;
    syncFromRuntimeUser = state.syncFromRuntimeUser;
  },
}));

import type {
  AccountDirectoryPublication,
  CanonicalRuntimeUserWriteInput,
  DatabaseAdapter,
} from '@authrim/ar-lib-core';
import { writeCanonicalAccountAuthoritative } from '../account-authoritative-write';

const publication: AccountDirectoryPublication = {
  operationId: 'operation-a',
  tenantId: 'tenant-a',
  accountId: 'account:user-a',
  idempotencyKey: 'account-create:a'.padEnd(79, '0'),
  routeProjection: {
    schemaVersion: 1,
    accountRouteGeneration: 1,
    residencyPolicyId: 'builtin:residency:default',
    targets: [
      {
        dataRole: 'tenant_core/users',
        residencyPartition: 'default',
        shardId: 'users-a',
        bindingRef: 'TENANT_CORE_USERS_A',
        requiredBindingRouteGeneration: 1,
      },
      {
        dataRole: 'tenant_pii',
        residencyPartition: 'default',
        shardId: 'pii-a',
        bindingRef: 'TENANT_PII_A',
        requiredBindingRouteGeneration: 1,
      },
    ],
  },
  indexes: [],
};

const runtimeUser: Omit<CanonicalRuntimeUserWriteInput, 'userId' | 'tenantId'> = {
  active: true,
  emailVerified: false,
  sourceRef: 'scim:/Users',
  sensitiveValues: { email: 'person@example.com' },
};

function adapter(): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(async () =>
      state.reflectedPayload === null ? null : { payload_json: state.reflectedPayload }
    ),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(() => 'test'),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

describe('writeCanonicalAccountAuthoritative', () => {
  beforeEach(() => {
    state.existing = null;
    state.reflectedPayload = null;
    state.createFromRuntimeUser.mockReset().mockResolvedValue({ created: true });
    state.syncFromRuntimeUser.mockReset().mockResolvedValue({ created: false });
  });

  it('creates the canonical account and prepared directory outbox atomically on the first write', async () => {
    const core = adapter();
    const pii = adapter();

    await expect(
      writeCanonicalAccountAuthoritative({
        publication,
        tenantCoreUsers: core,
        tenantPii: pii,
        runtimeUser,
      })
    ).resolves.toEqual({ userId: 'user-a' });

    expect(state.createFromRuntimeUser).toHaveBeenCalledWith(
      { ...runtimeUser, userId: 'user-a', tenantId: 'tenant-a' },
      publication
    );
    expect(state.syncFromRuntimeUser).not.toHaveBeenCalled();
  });

  it('resumes an exact response-loss retry without creating another account', async () => {
    state.existing = { id: publication.accountId };
    state.reflectedPayload = JSON.stringify(publication);

    await writeCanonicalAccountAuthoritative({
      publication,
      tenantCoreUsers: adapter(),
      tenantPii: adapter(),
      runtimeUser,
    });

    expect(state.createFromRuntimeUser).not.toHaveBeenCalled();
    expect(state.syncFromRuntimeUser).toHaveBeenCalledWith({
      ...runtimeUser,
      userId: 'user-a',
      tenantId: 'tenant-a',
    });
  });

  it.each([
    ['missing outbox', null],
    ['mismatched outbox', JSON.stringify({ ...publication, tenantId: 'tenant-b' })],
  ])('fails closed when an existing account has a %s', async (_label, reflectedPayload) => {
    state.existing = { id: publication.accountId };
    state.reflectedPayload = reflectedPayload;

    await expect(
      writeCanonicalAccountAuthoritative({
        publication,
        tenantCoreUsers: adapter(),
        tenantPii: adapter(),
        runtimeUser,
      })
    ).rejects.toThrow('account_creation_authoritative_state_conflict');

    expect(state.createFromRuntimeUser).not.toHaveBeenCalled();
    expect(state.syncFromRuntimeUser).not.toHaveBeenCalled();
  });
});
