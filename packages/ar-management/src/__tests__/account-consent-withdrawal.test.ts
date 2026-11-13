import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  record: vi.fn(),
  withdrawOAuth: vi.fn(),
  withdrawStatement: vi.fn(),
  invalidate: vi.fn(),
  publish: vi.fn(),
  accountQuery: vi.fn(),
}));

vi.mock('../account-page', () => ({ requireAccountSession: mocks.session }));
vi.mock('../account-operation-log', () => ({ recordAccountOperation: mocks.record }));
vi.mock('../oauth-client-consent-withdrawal', () => ({
  withdrawOAuthClientConsent: mocks.withdrawOAuth,
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'default',
  createAuthContextFromHono: () => ({ coreAdapter: { name: 'metadata' } }),
  createAccountAuthContextFromHono: () => ({
    coreAdapter: { name: 'account', query: mocks.accountQuery },
  }),
  withdrawStatementConsent: mocks.withdrawStatement,
  invalidateConsentCache: mocks.invalidate,
  publishEvent: mocks.publish,
  getLogger: () => ({ module: () => ({ error: vi.fn() }) }),
}));

import {
  withdrawAccountOAuthClientConsentHandler,
  withdrawAccountStatementConsentHandler,
} from '../account-consents';

function context(input: { query?: Record<string, string>; params?: Record<string, string> }) {
  return {
    env: {} as Env,
    req: {
      query: (name: string) => input.query?.[name],
      param: (name: string) => input.params?.[name],
      header: () => undefined,
    },
    header: vi.fn(),
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context<{ Bindings: Env }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ userId: 'user-1' });
  mocks.publish.mockResolvedValue(undefined);
});

describe('withdrawing an OIDC service consent on the account page', () => {
  it('ends the tokens, clears the cache, and records the operation', async () => {
    mocks.accountQuery.mockResolvedValue([{ scope: 'openid profile' }]);
    mocks.withdrawOAuth.mockResolvedValue({ revokedAt: 1, refreshTokenFamilies: 2 });

    const response = await withdrawAccountOAuthClientConsentHandler(
      context({ query: { client_id: 'rp-1' } })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ withdrawn: true });
    // Only the signed-in person's consent is read and withdrawn.
    expect(mocks.accountQuery).toHaveBeenCalledWith(
      expect.stringContaining('oauth_client_consents'),
      ['default', 'user-1', 'rp-1']
    );
    expect(mocks.withdrawOAuth.mock.calls[0][2]).toEqual({
      tenantId: 'default',
      userId: 'user-1',
      clientId: 'rp-1',
      previousScopes: ['openid', 'profile'],
    });
    expect(mocks.invalidate).toHaveBeenCalledWith({}, 'user-1', 'default', 'rp-1');
    expect(mocks.record.mock.calls[0][1]).toMatchObject({
      userId: 'user-1',
      action: 'account.consent.withdrawn',
      resourceType: 'oauth_client',
      resourceId: 'rp-1',
    });
  });

  it('answers 404 for a service the person has no consent for, and 400 without a client', async () => {
    mocks.accountQuery.mockResolvedValue([]);
    const missing = await withdrawAccountOAuthClientConsentHandler(
      context({ query: { client_id: 'rp-x' } })
    );
    expect(missing.status).toBe(404);
    expect((await withdrawAccountOAuthClientConsentHandler(context({}))).status).toBe(400);
    expect(mocks.withdrawOAuth).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('needs an account session', async () => {
    mocks.session.mockResolvedValue(Response.json({ error: 'login_required' }, { status: 401 }));
    const response = await withdrawAccountOAuthClientConsentHandler(
      context({ query: { client_id: 'rp-1' } })
    );
    expect(response.status).toBe(401);
    expect(mocks.accountQuery).not.toHaveBeenCalled();
  });
});

describe('withdrawing an agreement to a consent statement on the account page', () => {
  it('withdraws it as the person and records the operation', async () => {
    mocks.withdrawStatement.mockResolvedValue('withdrawn');
    const response = await withdrawAccountStatementConsentHandler(
      context({ params: { statementId: 'news' } })
    );
    expect(response.status).toBe(200);
    expect(mocks.withdrawStatement.mock.calls[0].slice(1)).toEqual([
      'default',
      'user-1',
      'news',
      { env: {}, actor: { id: 'user-1', type: 'user' } },
    ]);
    expect(mocks.record.mock.calls[0][1]).toMatchObject({
      action: 'account.consent.withdrawn',
      resourceType: 'statement',
      resourceId: 'news',
    });
  });

  it.each([
    ['missing', 404],
    ['not_granted', 400],
    ['withdrawal_forbidden', 400],
  ])('answers %s with %i and records nothing', async (result, status) => {
    mocks.withdrawStatement.mockResolvedValue(result);
    const response = await withdrawAccountStatementConsentHandler(
      context({ params: { statementId: 'tos' } })
    );
    expect(response.status).toBe(status);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('answers 503 where the database cannot write it atomically', async () => {
    mocks.withdrawStatement.mockRejectedValue(
      new Error('statement_consent_atomic_backend_unsupported')
    );
    const response = await withdrawAccountStatementConsentHandler(
      context({ params: { statementId: 'tos' } })
    );
    expect(response.status).toBe(503);
  });
});
