import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findState: vi.fn(),
  transition: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ensureDatabaseAdapter: vi.fn((database) => database),
    findCanonicalAccountAuthenticationState: mocks.findState,
    transitionAccountAuthenticationState: mocks.transition,
  };
});

import { activatePublishedAccountAuthenticationState } from '../account-authentication-activation';
import type { AccountDirectoryPublication, Env } from '@authrim/ar-lib-core';
import type { D1Database } from '@cloudflare/workers-types';

const publication = {
  operationId: 'account-create-operation-1',
  tenantId: 'default',
  accountId: 'account:user-1',
  idempotencyKey: 'idempotency-1',
  routeProjection: {
    schemaVersion: 1,
    accountRouteGeneration: 1,
    residencyPolicyId: 'builtin:residency:default',
    targets: [],
  },
  indexes: [],
} as AccountDirectoryPublication;

describe('activatePublishedAccountAuthenticationState', () => {
  beforeEach(() => {
    mocks.findState.mockReset();
    mocks.transition.mockReset().mockResolvedValue({ lifecycle: 'active' });
  });

  it('activates the user-scoped DO after directory publication becomes authoritative', async () => {
    mocks.findState.mockResolvedValue({
      userId: 'user-1',
      accountType: 'end_user',
      lifecycle: 'active',
      sourceVersionMs: 1_700_000_000_000,
    });
    const env = { SESSION_REVOCATION_STORE: {} } as Pick<Env, 'SESSION_REVOCATION_STORE'>;
    const tenantCore = {} as D1Database;

    await activatePublishedAccountAuthenticationState(env, tenantCore, publication, 1_700_000_001);

    expect(mocks.findState).toHaveBeenCalledWith(tenantCore, 'default', 'user-1');
    expect(mocks.transition).toHaveBeenCalledWith(env, {
      tenantId: 'default',
      userId: 'user-1',
      lifecycle: 'active',
      sourceVersionMs: 1_700_000_001_000,
      operationId: 'directory.account-create-operation-1',
      revokeSessions: false,
    });
  });

  it('preserves an inactive Core account after directory publication', async () => {
    mocks.findState.mockResolvedValue({
      userId: 'user-1',
      accountType: 'end_user',
      lifecycle: 'inactive',
      sourceVersionMs: 1_700_000_000_000,
    });

    const env = { SESSION_REVOCATION_STORE: {} } as Pick<Env, 'SESSION_REVOCATION_STORE'>;
    await activatePublishedAccountAuthenticationState(
      env,
      {} as D1Database,
      publication,
      1_700_000_001
    );

    expect(mocks.transition).toHaveBeenCalledWith(env, {
      tenantId: 'default',
      userId: 'user-1',
      lifecycle: 'inactive',
      sourceVersionMs: 1_700_000_001_000,
      operationId: 'directory.account-create-operation-1',
      revokeSessions: true,
    });
  });

  it('fails closed when the canonical authentication state is missing', async () => {
    mocks.findState.mockResolvedValue(null);

    await expect(
      activatePublishedAccountAuthenticationState(
        { SESSION_REVOCATION_STORE: {} } as Pick<Env, 'SESSION_REVOCATION_STORE'>,
        {} as D1Database,
        publication,
        1_700_000_001
      )
    ).rejects.toThrow('directory_account_authentication_state_invalid');
    expect(mocks.transition).not.toHaveBeenCalled();
  });
});
