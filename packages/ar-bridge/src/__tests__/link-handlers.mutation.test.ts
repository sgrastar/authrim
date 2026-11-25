/**
 * The account page's linked-accounts endpoints: session checks, listing and starting a link.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { ACCOUNT_REAUTH_REQUIRED_ERROR, type Env } from '@authrim/ar-lib-core';
import { callArg, rec } from './helpers/mock-args';

const mocks = vi.hoisted(() => ({
  readSession: vi.fn(),
  resolveAccount: vi.fn(),
  reauthTtl: vi.fn(),
  listIdentities: vi.fn(),
  getIdentityForProvider: vi.fn(),
  getProvider: vi.fn(),
  getProviderByIdOrSlug: vi.fn(),
  createIntent: vi.fn(),
  error: vi.fn(),
  moduleNames: [] as string[],
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    // a missing field is answered with the field it names, so that the answer can be checked
    createErrorResponse: (
      c: Parameters<typeof actual.createErrorResponse>[0],
      code: Parameters<typeof actual.createErrorResponse>[1],
      options?: Parameters<typeof actual.createErrorResponse>[2]
    ) =>
      code === actual.AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD
        ? c.json({ error: 'required_field', variables: options?.variables }, 400)
        : actual.createErrorResponse(c, code, options),
    readAccountSession: mocks.readSession,
    resolveAccountDataContext: mocks.resolveAccount,
    resolveAccountReauthTtlSeconds: mocks.reauthTtl,
    getTenantIdFromContext: () => 'tenant-a',
    buildIssuerUrl: () => 'https://tenant-a.example.com',
    getLogger: () => ({
      module: (name: string) => {
        mocks.moduleNames.push(name);
        return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: mocks.error };
      },
    }),
  };
});
vi.mock('../services/linked-identity-store', () => ({
  getLinkedIdentityById: vi.fn(),
  listLinkedIdentities: mocks.listIdentities,
  getLinkedIdentityForUserAndProvider: mocks.getIdentityForProvider,
}));
vi.mock('../services/token-revocation', () => ({ revokeLinkedIdentityTokens: vi.fn() }));
vi.mock('../services/provider-store', () => ({
  getProvider: mocks.getProvider,
  getProviderByIdOrSlug: mocks.getProviderByIdOrSlug,
}));
vi.mock('../services/link-intent', () => ({
  createLinkIntent: mocks.createIntent,
  recordSocialAccountActivity: vi.fn(),
}));

import { handleLinkIdentity, handleListLinkedIdentities } from '../handlers/link';

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
const NOW_S = Math.floor(T0 / 1000);
const ENV = {} as unknown as Env;

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.get('/links', handleListLinkedIdentities);
  instance.post('/links', handleLinkIdentity);
  return instance;
}

const get = (headers: Record<string, string> = { Cookie: 'authrim_session=sess-1' }) =>
  Promise.resolve(app().request('https://tenant-a.example.com/links', { headers }, ENV));
const post = (
  body: unknown,
  headers: Record<string, string> = { Cookie: 'authrim_session=sess-1' }
) =>
  Promise.resolve(
    app().request(
      'https://tenant-a.example.com/links',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      ENV
    )
  );

const session = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'sess-1',
  userId: 'user-a',
  createdAt: T0 - 60_000,
  expiresAt: T0 + 3_600_000,
  authTime: NOW_S - 60,
  ...overrides,
});

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  mocks.readSession.mockResolvedValue(session());
  mocks.reauthTtl.mockResolvedValue(300);
  mocks.resolveAccount.mockResolvedValue({
    accountId: 'account:user-a',
    legacyUserId: 'user-a',
    piiDb: { binding: 'pii-a' },
    coreDb: { binding: 'core-a' },
  });
  mocks.listIdentities.mockResolvedValue([]);
  mocks.getIdentityForProvider.mockResolvedValue(null);
  mocks.getProviderByIdOrSlug.mockResolvedValue({ id: 'prov-1', slug: 'corp', enabled: true });
  mocks.createIntent.mockResolvedValue('intent-token');
});

describe('details of the answers', () => {
  it('names the field a link request lacks', async () => {
    for (const body of [{}, { provider_id: '' }, { provider_id: 5 }, 'not json']) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'required_field',
        variables: { field: 'provider_id' },
      });
    }
  });

  it('logs under the EXTERNAL-IDP module and accepts a cookie list without spaces', async () => {
    mocks.moduleNames.length = 0;
    expect((await get({ Cookie: 'a=b;authrim_session=sess-1' })).status).toBe(200);
    expect(mocks.readSession).toHaveBeenLastCalledWith(ENV, 'tenant-a', 'sess-1');
    await post({ provider_id: 'corp' });
    mocks.readSession.mockRejectedValue(new Error('down'));
    await get();
    expect(mocks.moduleNames.length).toBeGreaterThanOrEqual(3);
    expect(new Set(mocks.moduleNames)).toEqual(new Set(['EXTERNAL-IDP']));
  });
});

describe('the session cookie', () => {
  it('reads the session named by the cookie among others, decoding it', async () => {
    const response = await get({ Cookie: 'a=b; authrim_session=sess%2F1; c=d' });
    expect(response.status).toBe(200);
    expect(mocks.readSession).toHaveBeenCalledWith(ENV, 'tenant-a', 'sess/1');
  });

  it('asks for no session when the cookie is absent or only a lookalike', async () => {
    mocks.readSession.mockResolvedValue(null);
    expect((await get({})).status).toBe(401);
    expect(mocks.readSession).toHaveBeenLastCalledWith(ENV, 'tenant-a', null);
    await get({ Cookie: 'xauthrim_session=sess-1' });
    expect(mocks.readSession).toHaveBeenLastCalledWith(ENV, 'tenant-a', null);
  });

  it('answers 401 for no session, and never caches', async () => {
    mocks.readSession.mockResolvedValue(null);
    const response = await get();
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.listIdentities).not.toHaveBeenCalled();
  });

  it('answers a server error, not signed-out, when the session store fails', async () => {
    mocks.readSession.mockRejectedValue(new Error('store down'));
    const response = await get();
    expect(response.status).toBe(500);
    expect(mocks.error).toHaveBeenCalledWith(
      'Failed to read the account session',
      {},
      expect.objectContaining({ message: 'store down' })
    );
  });

  it('requires a full, recently authenticated session to start a link', async () => {
    mocks.readSession.mockResolvedValue(session({ isGuestSession: true }));
    const guest = await post({ provider_id: 'corp' });
    expect(guest.status).toBe(403);
    expect(await guest.json()).toEqual({ error: 'guest_registration_required' });

    mocks.readSession.mockResolvedValue(session({ authTime: NOW_S - 300 }));
    const stale = await post({ provider_id: 'corp' });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual(ACCOUNT_REAUTH_REQUIRED_ERROR);
    expect(mocks.reauthTtl).toHaveBeenCalledWith(ENV, 'tenant-a');

    mocks.readSession.mockResolvedValue(session({ authTime: NOW_S - 299 }));
    expect((await post({ provider_id: 'corp' })).status).toBe(200);
    mocks.readSession.mockResolvedValue(null);
    expect((await post({ provider_id: 'corp' })).status).toBe(401);
    expect(mocks.createIntent).toHaveBeenCalledTimes(1);
  });
});

describe('listing linked identities', () => {
  it('lists each identity with the provider name and slug', async () => {
    mocks.listIdentities.mockResolvedValue([
      {
        id: 'li-1',
        providerId: 'prov-1',
        providerEmail: 'a@example.com',
        linkedAt: 1000,
        lastLoginAt: 2000,
        accessTokenEncrypted: 'secret',
      },
      { id: 'li-2', providerId: 'prov-gone', linkedAt: 3000 },
      { id: 'li-3', providerId: 'prov-2', linkedAt: 4000 },
    ]);
    mocks.getProvider.mockImplementation(async (_env: unknown, _tenant: string, id: string) => {
      if (id === 'prov-1') return { id, name: 'Corp', slug: 'corp' };
      if (id === 'prov-2') return { id, name: 'Other' };
      return null;
    });
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      identities: [
        {
          id: 'li-1',
          providerId: 'prov-1',
          providerName: 'Corp',
          providerSlug: 'corp',
          providerEmail: 'a@example.com',
          linkedAt: 1000,
          lastLoginAt: 2000,
        },
        { id: 'li-2', providerId: 'prov-gone', providerName: 'Unknown', linkedAt: 3000 },
        { id: 'li-3', providerId: 'prov-2', providerName: 'Other', linkedAt: 4000 },
      ],
    });
    expect(mocks.listIdentities).toHaveBeenCalledWith(ENV, 'tenant-a', 'user-a', {
      binding: 'pii-a',
    });
    expect(mocks.resolveAccount).toHaveBeenCalledWith(ENV, {
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
    });
    expect(mocks.getProvider).toHaveBeenCalledWith(ENV, 'tenant-a', 'prov-1');
  });

  it('lists nothing for an account without links', async () => {
    const response = await get();
    expect(await response.json()).toEqual({ identities: [] });
  });

  it('answers 500 when the account is not the session user, or a store fails', async () => {
    mocks.resolveAccount.mockResolvedValue({ legacyUserId: 'someone-else', piiDb: {} });
    expect((await get()).status).toBe(500);
    expect(mocks.error).toHaveBeenCalledWith(
      'Failed to list linked identities',
      {},
      expect.objectContaining({ message: 'external_idp_link_account_mismatch' })
    );
    expect(mocks.listIdentities).not.toHaveBeenCalled();
    mocks.resolveAccount.mockRejectedValue(new Error('directory down'));
    expect((await get()).status).toBe(500);
  });
});

describe('starting a link', () => {
  it('returns the start URL carrying a one-use intent', async () => {
    const response = await post({ provider_id: 'corp' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      authorization_url:
        'https://tenant-a.example.com/auth/external/corp/start?link_intent=intent-token',
    });
    expect(mocks.getProviderByIdOrSlug).toHaveBeenCalledWith(ENV, 'corp', 'tenant-a');
    expect(mocks.getIdentityForProvider).toHaveBeenCalledWith(ENV, 'tenant-a', 'user-a', 'prov-1', {
      binding: 'pii-a',
    });
    expect(callArg(mocks.createIntent, 0, 0)).toBe(ENV);
    expect(callArg(mocks.createIntent, 0, 1)).toBe('tenant-a');
    expect(rec(callArg(mocks.createIntent, 0, 2))).toEqual({
      userId: 'user-a',
      sessionId: 'sess-1',
      providerId: 'prov-1',
    });
  });

  it('names a provider without a slug by its id, encoded', async () => {
    mocks.getProviderByIdOrSlug.mockResolvedValue({ id: 'id/with space', enabled: true });
    const response = await post({ provider_id: 'x' });
    expect(rec(await response.json()).authorization_url).toBe(
      'https://tenant-a.example.com/auth/external/id%2Fwith%20space/start?link_intent=intent-token'
    );
  });

  it.each([
    ['unparseable JSON', '{nope'],
    ['no body fields', {}],
    ['a null body', 'null'],
    ['an empty provider_id', { provider_id: '' }],
    ['a numeric provider_id', { provider_id: 5 }],
  ])('rejects %s with 400 before looking anything up', async (_label, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(mocks.getProviderByIdOrSlug).not.toHaveBeenCalled();
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown or disabled provider', async () => {
    mocks.getProviderByIdOrSlug.mockResolvedValue(null);
    expect((await post({ provider_id: 'corp' })).status).toBe(404);
    mocks.getProviderByIdOrSlug.mockResolvedValue({ id: 'prov-1', enabled: false });
    expect((await post({ provider_id: 'corp' })).status).toBe(404);
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it('answers 409 when the provider is already linked', async () => {
    mocks.getIdentityForProvider.mockResolvedValue({ id: 'li-1' });
    const response = await post({ provider_id: 'corp' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'already_linked',
      error_description: 'An account from this provider is already linked.',
    });
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it('answers 500 when the intent cannot be created', async () => {
    mocks.createIntent.mockRejectedValue(new Error('challenge store down'));
    expect((await post({ provider_id: 'corp' })).status).toBe(500);
    expect(mocks.error).toHaveBeenCalledWith(
      'Failed to start linking',
      {},
      expect.objectContaining({ message: 'challenge store down' })
    );
  });
});
