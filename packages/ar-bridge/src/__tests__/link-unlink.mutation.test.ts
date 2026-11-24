/**
 * Unlinking an external account from the account page: ownership, the removal lease, the
 * provisioner's answers and the provider token revocation.
 */
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { LoginMethodRemovalInProgressError, type Env } from '@authrim/ar-lib-core';
import { argRec, callArg, rec } from './helpers/mock-args';

const mocks = vi.hoisted(() => ({
  readSession: vi.fn(),
  resolveAccount: vi.fn(),
  reauthTtl: vi.fn(),
  getIdentityById: vi.fn(),
  revoke: vi.fn(),
  recordActivity: vi.fn(),
  withLock: vi.fn(),
  removalSafe: vi.fn(),
  assertHeld: vi.fn(),
  ensure: vi.fn(),
  removeRoute: vi.fn(),
  removalStatus: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  readAccountSession: mocks.readSession,
  resolveAccountDataContext: mocks.resolveAccount,
  resolveAccountReauthTtlSeconds: mocks.reauthTtl,
  isLoginMethodRemovalSafe: mocks.removalSafe,
  withLoginMethodRemovalLock: mocks.withLock,
  ensureDatabaseAdapter: mocks.ensure,
  getTenantIdFromContext: () => 'tenant-a',
  getLogger: () => ({
    module: () => ({ info: vi.fn(), debug: vi.fn(), warn: mocks.warn, error: mocks.error }),
  }),
}));
vi.mock('../services/linked-identity-store', () => ({
  getLinkedIdentityById: mocks.getIdentityById,
  listLinkedIdentities: vi.fn(),
  getLinkedIdentityForUserAndProvider: vi.fn(),
}));
vi.mock('../services/token-revocation', () => ({ revokeLinkedIdentityTokens: mocks.revoke }));
vi.mock('../services/provider-store', () => ({
  getProvider: vi.fn(),
  getProviderByIdOrSlug: vi.fn(),
}));
vi.mock('../services/link-intent', () => ({
  createLinkIntent: vi.fn(),
  recordSocialAccountActivity: mocks.recordActivity,
}));

import { handleUnlinkIdentity } from '../handlers/link';

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
const NOW_S = Math.floor(T0 / 1000);
const OPERATION = `external-idp-route-remove-${createHash('sha256')
  .update('tenant-a\u0000account:user-a\u0000link-1')
  .digest('hex')
  .slice(0, 32)}`;
const DIGEST = createHash('sha256')
  .update('tenant-a\u0000account:user-a\u0000link-1')
  .digest('hex');

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.delete('/links/:id', handleUnlinkIdentity);
  instance.delete('/links', handleUnlinkIdentity);
  return instance;
}
const unlink = (path = '/links/link-1', env: Record<string, unknown> | null = null) =>
  Promise.resolve(
    app().request(
      `https://tenant-a.example.com${path}`,
      { method: 'DELETE', headers: { Cookie: 'authrim_session=sess-1' } },
      (env ?? {
        EXTERNAL_IDP_ACCOUNT_PROVISIONER: {
          removeExternalIdpRoute: mocks.removeRoute,
          getExternalIdpRouteRemovalStatus: mocks.removalStatus,
        },
      }) as unknown as Env
    )
  );

const identity = (overrides: Record<string, unknown> = {}) => ({
  id: 'link-1',
  userId: 'user-a',
  providerId: 'prov-1',
  providerUserId: 'sub-1',
  ...overrides,
});

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  mocks.readSession.mockResolvedValue({
    sessionId: 'sess-1',
    userId: 'user-a',
    authTime: NOW_S - 60,
  });
  mocks.reauthTtl.mockResolvedValue(300);
  mocks.resolveAccount.mockResolvedValue({
    accountId: 'account:user-a',
    legacyUserId: 'user-a',
    coreDb: { db: 'core' },
    piiDb: { db: 'pii' },
  });
  mocks.getIdentityById.mockResolvedValue(identity());
  mocks.ensure.mockImplementation((source: unknown, partition: string) => ({ source, partition }));
  mocks.removalSafe.mockResolvedValue(true);
  mocks.assertHeld.mockResolvedValue(undefined);
  mocks.withLock.mockImplementation(
    async (
      _env: unknown,
      _tenant: string,
      _user: string,
      run: (lease: { owner: string; assertHeld: () => Promise<void> }) => Promise<unknown>
    ) => run({ owner: 'lease-1', assertHeld: mocks.assertHeld })
  );
  mocks.removeRoute.mockImplementation(async (request: Record<string, unknown>) => ({
    status: 201,
    operationId: request.operationId,
    accountId: request.accountId,
  }));
  mocks.revoke.mockResolvedValue({
    success: true,
    accessTokenRevoked: true,
    refreshTokenRevoked: true,
    errors: [],
  });
});

describe('removing a link', () => {
  it('removes the route under the lease, records it and revokes the provider tokens', async () => {
    const response = await unlink();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      success: true,
      cleanup_pending: false,
      operation_id: OPERATION,
      token_revocation: {
        attempted: true,
        access_token_revoked: true,
        refresh_token_revoked: true,
      },
    });
    expect(argRec(mocks.removeRoute)).toEqual({
      schemaVersion: 1,
      operationId: OPERATION,
      idempotencyKey: `auth-external-idp-route-remove:${DIGEST}`,
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      userId: 'user-a',
      linkedIdentityId: 'link-1',
      providerId: 'prov-1',
      providerUserId: 'sub-1',
      removalLeaseOwner: 'lease-1',
    });
    expect(callArg(mocks.withLock, 0, 1)).toBe('tenant-a');
    expect(callArg(mocks.withLock, 0, 2)).toBe('user-a');
    expect(callArg(mocks.getIdentityById, 0, 1)).toBe('tenant-a');
    expect(callArg(mocks.getIdentityById, 0, 2)).toBe('link-1');
    expect(callArg(mocks.getIdentityById, 0, 3)).toEqual({ db: 'pii' });
    expect(mocks.recordActivity).toHaveBeenCalledWith(
      expect.anything(),
      'user-a',
      'account.social_account.unlinked',
      { linkedIdentityId: 'link-1', providerId: 'prov-1' }
    );
    expect(callArg(mocks.revoke, 0, 1)).toEqual(identity());
  });

  it('checks the lease is still held before removing, and that another sign-in method remains', async () => {
    const order: string[] = [];
    mocks.removalSafe.mockImplementation(async () => {
      order.push('safe');
      return true;
    });
    mocks.assertHeld.mockImplementation(async () => {
      order.push('held');
    });
    mocks.removeRoute.mockImplementation(async (request: Record<string, unknown>) => {
      order.push('remove');
      return { status: 201, operationId: request.operationId, accountId: request.accountId };
    });
    await unlink();
    expect(order).toEqual(['safe', 'held', 'remove']);
    expect(argRec(mocks.removalSafe, 0, 1)).toEqual({
      tenantId: 'tenant-a',
      userId: 'user-a',
      coreAdapter: { source: { db: 'core' }, partition: 'external-idp-unlink-core' },
      piiAdapter: { source: { db: 'pii' }, partition: 'external-idp-unlink-pii' },
      removing: { kind: 'linked_identity', id: 'link-1' },
    });
  });

  it('reports pending cleanup for a 202 and the revocation warnings', async () => {
    mocks.removeRoute.mockImplementation(async (request: Record<string, unknown>) => ({
      status: 202,
      operationId: request.operationId,
      accountId: request.accountId,
    }));
    mocks.revoke.mockResolvedValue({
      success: false,
      accessTokenRevoked: false,
      refreshTokenRevoked: true,
      errors: ['Access token: HTTP 500'],
    });
    const body = rec(await (await unlink()).json());
    expect(body.cleanup_pending).toBe(true);
    expect(body.token_revocation).toEqual({
      attempted: true,
      access_token_revoked: false,
      refresh_token_revoked: true,
      warnings: ['Access token: HTTP 500'],
    });
    expect(mocks.warn).toHaveBeenCalledWith('Token revocation failed for identity', {
      errorCount: 1,
    });
  });

  it('does not warn when revocation succeeds, or fails without any error text', async () => {
    mocks.revoke.mockResolvedValue({
      success: false,
      accessTokenRevoked: false,
      refreshTokenRevoked: false,
      errors: [],
    });
    const body = rec(await (await unlink()).json());
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(rec(body.token_revocation)).not.toHaveProperty('warnings', []);
    expect(rec(body.token_revocation).warnings).toBeUndefined();
  });

  it('still answers success when the revocation itself throws', async () => {
    mocks.revoke.mockRejectedValue(new Error('provider down'));
    const response = await unlink();
    expect(response.status).toBe(200);
    expect(rec(rec(await response.json()).token_revocation)).toEqual({
      attempted: true,
      access_token_revoked: false,
      refresh_token_revoked: false,
      warnings: ['provider down'],
    });
    mocks.revoke.mockRejectedValue('text');
    expect(rec(rec(await (await unlink()).json()).token_revocation).warnings).toEqual([
      'revocation_failed',
    ]);
  });

  it('keeps the last way to sign in', async () => {
    mocks.removalSafe.mockResolvedValue(false);
    const response = await unlink();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'remaining_login_method_required',
      error_description: 'Cannot remove the last available login method.',
    });
    expect(mocks.removeRoute).not.toHaveBeenCalled();
    expect(mocks.assertHeld).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('refuses a removal answer for another operation or account, or with another status', async () => {
    for (const answer of [
      { status: 201, operationId: 'other', accountId: 'account:user-a' },
      { status: 201, operationId: OPERATION, accountId: 'account:other' },
      { status: 200, operationId: OPERATION, accountId: 'account:user-a' },
      { status: 500, operationId: OPERATION, accountId: 'account:user-a' },
    ]) {
      mocks.removeRoute.mockResolvedValue(answer);
      mocks.revoke.mockClear();
      const response = await unlink();
      expect(response.status).toBe(500);
      // The removal was asked for and may have happened: the provider tokens are revoked anyway.
      expect(mocks.revoke).toHaveBeenCalledTimes(1);
      expect(callArg(mocks.revoke, 0, 1)).toEqual(identity());
    }
    expect(mocks.recordActivity).not.toHaveBeenCalled();
  });

  it('revokes the tokens after a removal that was asked for even if it failed, but not before', async () => {
    mocks.removeRoute.mockRejectedValue(new Error('removal failed'));
    expect((await unlink()).status).toBe(500);
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith('Failed to unlink identity', {}, expect.any(Error));
    mocks.revoke.mockClear();
    mocks.assertHeld.mockRejectedValue(new Error('lease lost'));
    expect((await unlink()).status).toBe(500);
    expect(mocks.removeRoute).toHaveBeenCalledTimes(1);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('answers 409 while another login-method change runs', async () => {
    for (const failure of [
      new LoginMethodRemovalInProgressError(),
      new Error('login_method_removal_in_progress'),
    ]) {
      mocks.withLock.mockRejectedValue(failure);
      const response = await unlink();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'operation_in_progress',
        error_description: 'Another change to how this account signs in is in progress.',
      });
    }
  });
});

describe('what may be unlinked', () => {
  it('requires a recent session, an id, and an identity of the signed-in user', async () => {
    mocks.readSession.mockResolvedValue(null);
    expect((await unlink()).status).toBe(401);
    mocks.readSession.mockResolvedValue({
      sessionId: 's',
      userId: 'user-a',
      authTime: NOW_S - 400,
    });
    expect((await unlink()).status).toBe(403);
    mocks.readSession.mockResolvedValue({ sessionId: 's', userId: 'user-a', authTime: NOW_S - 60 });
    expect((await unlink('/links')).status).toBe(404);
    mocks.getIdentityById.mockResolvedValue(identity({ userId: 'user-b' }));
    expect((await unlink()).status).toBe(404);
    expect(mocks.removeRoute).not.toHaveBeenCalled();
    expect(mocks.removalStatus).not.toHaveBeenCalled();
  });

  it('answers 500 for an account that is not the session user', async () => {
    mocks.resolveAccount.mockResolvedValue({
      accountId: 'account:user-a',
      legacyUserId: 'other',
      coreDb: {},
      piiDb: {},
    });
    expect((await unlink()).status).toBe(500);
  });

  it('answers 500 without a provisioner', async () => {
    expect((await unlink('/links/link-1', {})).status).toBe(500);
    mocks.getIdentityById.mockResolvedValue(null);
    expect((await unlink('/links/link-1', {})).status).toBe(500);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});

describe('a link that is already gone', () => {
  beforeEach(() => mocks.getIdentityById.mockResolvedValue(null));
  const status = (overrides: Record<string, unknown> = {}) =>
    mocks.removalStatus.mockImplementation(async (request: Record<string, unknown>) => ({
      status: 201,
      operationId: request.operationId,
      accountId: request.accountId,
      ...overrides,
    }));

  it('asks the provisioner and reports the finished or pending removal', async () => {
    status();
    let response = await unlink();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      cleanup_pending: false,
      operation_id: OPERATION,
      token_revocation: {
        attempted: false,
        access_token_revoked: false,
        refresh_token_revoked: false,
      },
    });
    expect(argRec(mocks.removalStatus)).toEqual({
      schemaVersion: 1,
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      userId: 'user-a',
      operationId: OPERATION,
    });
    status({ status: 202 });
    response = await unlink();
    expect(rec(await response.json()).cleanup_pending).toBe(true);
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.removeRoute).not.toHaveBeenCalled();
  });

  it('answers 404 when no removal was ever recorded', async () => {
    mocks.removalStatus.mockRejectedValue(new Error('external_idp_route_removal_status_not_found'));
    expect((await unlink()).status).toBe(404);
  });

  it.each([
    ['another operation', { operationId: 'other' }],
    ['another account', { accountId: 'account:other' }],
    ['another status', { status: 500 }],
  ])('answers 500 for %s', async (_name, change) => {
    status(change);
    expect((await unlink()).status).toBe(500);
  });

  it('answers 500 for any other status failure', async () => {
    mocks.removalStatus.mockRejectedValue(new Error('boom'));
    expect((await unlink()).status).toBe(500);
    mocks.removalStatus.mockRejectedValue('text');
    expect((await unlink()).status).toBe(500);
  });
});
