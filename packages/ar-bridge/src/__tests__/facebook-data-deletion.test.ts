import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { signFacebookRequest } from './helpers/facebook-signed-request';

const SECRET = 'facebook-app-secret';
const FACEBOOK_USER = '10200000000000001';
const CODE = 'AbCdEfGhIjKlMnOpQrStUv';

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  unlink:
    vi.fn<
      (
        env: unknown,
        input: { mayRemoveLink?: boolean } & Record<string, unknown>
      ) => Promise<unknown>
    >(),
  createRequest: vi.fn(),
  readState: vi.fn(),
  recordActivity: vi.fn(),
  replays: new Set<string>(),
  replayStoreDown: false,
  audit:
    vi.fn<(env: unknown, entry: { metadata: string } & Record<string, unknown>) => Promise<void>>(),
}));

vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    buildIssuerUrl: vi.fn(() => 'https://tenant-a.example.com'),
    createAuditLog: mocks.audit,
    isReplayJtiRecorded: vi.fn(async (_env: unknown, input: { jti: string }) => {
      if (mocks.replayStoreDown) throw new Error('jti_replay_store_unavailable:503');
      return mocks.replays.has(input.jti);
    }),
    recordReplayJti: vi.fn(async (_env: unknown, input: { jti: string }) => {
      if (mocks.replays.has(input.jti)) return 'replayed';
      mocks.replays.add(input.jti);
      return 'recorded';
    }),
  };
});

vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug: mocks.getProvider }));
vi.mock('../services/link-intent', () => ({ recordSocialAccountActivity: mocks.recordActivity }));
vi.mock('../utils/crypto', () => ({
  getEncryptionKeyOrUndefined: () => 'a'.repeat(64),
  decrypt: async (value: string) => (value === 'encrypted-secret' ? SECRET : 'other'),
}));
vi.mock('../services/provider-data-deletion', async (original) => {
  const actual = await original<typeof import('../services/provider-data-deletion')>();
  return {
    ...actual,
    resolveSignedRequestMaxAgeSeconds: vi.fn(async () => 600),
    unlinkProviderSubject: mocks.unlink,
    createDataDeletionRequest: mocks.createRequest,
    readDataDeletionRequestState: mocks.readState,
  };
});

import {
  handleFacebookDataDeletion,
  handleFacebookDataDeletionStatus,
  handleFacebookDeauthorize,
} from '../handlers/facebook-data-deletion';

const app = new Hono<{ Bindings: Env }>();
app.post('/auth/external/:provider/data-deletion', handleFacebookDataDeletion);
app.get('/auth/external/:provider/data-deletion/:code', handleFacebookDataDeletionStatus);
app.post('/auth/external/:provider/deauthorize', handleFacebookDeauthorize);

const facebookProvider = {
  id: 'provider-facebook',
  slug: 'facebook',
  name: 'Facebook',
  providerType: 'oauth2',
  enabled: true,
  clientId: 'app-id',
  clientSecretEncrypted: 'encrypted-secret',
  authorizationEndpoint: 'https://www.facebook.com/v20.0/dialog/oauth',
  tokenEndpoint: 'https://graph.facebook.com/v20.0/oauth/access_token',
};

const now = () => Math.floor(Date.now() / 1000);

async function post(
  path: string,
  payload: Record<string, unknown> = {
    algorithm: 'HMAC-SHA256',
    issued_at: now(),
    user_id: FACEBOOK_USER,
  },
  secret = SECRET
): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ signed_request: signFacebookRequest(payload, secret) }),
    },
    {}
  );
}

describe('Facebook data deletion and deauthorize callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replays.clear();
    mocks.replayStoreDown = false;
    mocks.getProvider.mockResolvedValue(facebookProvider);
    mocks.unlink.mockResolvedValue({
      outcome: 'unlink_pending',
      userId: 'user-a',
      accountId: 'account:user-a',
      linkedIdentityId: 'link-a',
      unlinkOperationId: 'external-idp-route-remove-x',
    });
    mocks.createRequest.mockResolvedValue({ confirmationCode: CODE, state: 'pending' });
    mocks.audit.mockResolvedValue(undefined);
  });

  it('unlinks the subject and answers the status URL and confirmation code', async () => {
    const response = await post('/auth/external/facebook/data-deletion');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      url: `https://tenant-a.example.com/auth/external/facebook/data-deletion/${CODE}`,
      confirmation_code: CODE,
    });
    expect(mocks.unlink).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      providerId: 'provider-facebook',
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: expect.any(Number) as number,
      mayRemoveLink: true,
      payloadGuard: expect.anything() as unknown,
    });
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
    expect(mocks.recordActivity).toHaveBeenCalledWith(
      expect.anything(),
      'user-a',
      'account.social_account.unlinked',
      {
        linkedIdentityId: 'link-a',
        providerId: 'provider-facebook',
        reason: 'provider_data_deletion',
      }
    );
    const entry = mocks.audit.mock.calls[0]?.[1];
    expect(entry).toMatchObject({
      tenantId: 'tenant-a',
      userId: 'system',
      action: 'external_idp.data_deletion_requested',
      severity: 'info',
    });
    expect(JSON.parse(entry.metadata)).toMatchObject({
      outcome: 'unlink_pending',
      user_id: 'user-a',
      confirmation_code: CODE,
    });
    // Never the Facebook id in clear.
    expect(entry.metadata).not.toContain(FACEBOOK_USER);
  });

  it('answers the same whether or not the person had a link', async () => {
    mocks.unlink.mockResolvedValue({ outcome: 'no_link' });
    mocks.createRequest.mockResolvedValue({ confirmationCode: CODE, state: 'completed' });

    const response = await post('/auth/external/facebook/data-deletion');

    expect(response.status).toBe(200);
    expect(Object.keys(await response.json()).sort()).toEqual(['confirmation_code', 'url']);
    expect(mocks.recordActivity).not.toHaveBeenCalled();
  });

  it('records a request kept by a legal hold as a warning, with no unlinked event', async () => {
    mocks.unlink.mockResolvedValue({
      outcome: 'retained',
      userId: 'user-a',
      accountId: 'account:user-a',
      linkedIdentityId: 'link-a',
    });
    mocks.createRequest.mockResolvedValue({ confirmationCode: CODE, state: 'retained' });

    const response = await post('/auth/external/facebook/data-deletion');

    expect(response.status).toBe(200);
    expect(mocks.recordActivity).not.toHaveBeenCalled();
    expect(mocks.audit.mock.calls[0]?.[1]).toMatchObject({ severity: 'warning' });
  });

  it.each([
    ['another secret', { algorithm: 'HMAC-SHA256', issued_at: now(), user_id: FACEBOOK_USER }, 'x'],
    ['another algorithm', { algorithm: 'HMAC-SHA1', issued_at: now(), user_id: FACEBOOK_USER }],
    [
      'a stale request',
      { algorithm: 'HMAC-SHA256', issued_at: now() - 601, user_id: FACEBOOK_USER },
    ],
  ] as Array<[string, Record<string, unknown>, string?]>)(
    'refuses %s without unlinking anything',
    async (_case, payload, secret) => {
      const response = await post(
        '/auth/external/facebook/data-deletion',
        payload,
        secret ?? SECRET
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
      expect(mocks.unlink).not.toHaveBeenCalled();
      expect(mocks.createRequest).not.toHaveBeenCalled();
    }
  );

  it('acts on a signed request once, but lets one answered "retry" be sent again', async () => {
    const payload = { algorithm: 'HMAC-SHA256', issued_at: now(), user_id: FACEBOOK_USER };
    const { LoginMethodRemovalInProgressError } = await import('@authrim/ar-lib-core');
    mocks.unlink.mockRejectedValueOnce(new LoginMethodRemovalInProgressError());
    expect((await post('/auth/external/facebook/data-deletion', payload)).status).toBe(503);
    expect((await post('/auth/external/facebook/data-deletion', payload)).status).toBe(200);
    const replayed = await post('/auth/external/facebook/data-deletion', payload);
    expect(replayed.status).toBe(400);
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
  });

  it('treats a copy with the signature re-encoded (padding) as the same request', async () => {
    const payload = { algorithm: 'HMAC-SHA256', issued_at: now(), user_id: FACEBOOK_USER };
    const signed = signFacebookRequest(payload, SECRET);
    const [signature, encodedPayload] = signed.split('.');
    const send = (signedRequest: string) =>
      app.request(
        '/auth/external/facebook/data-deletion',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ signed_request: signedRequest }),
        },
        {}
      );
    expect((await send(signed)).status).toBe(200);
    expect((await send(`${signature}=.${encodedPayload}`)).status).toBe(400);
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(mocks.unlink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestIssuedAt: payload.issued_at })
    );
  });

  it('removes a link once per signed payload, whichever callback receives it', async () => {
    const payload = { algorithm: 'HMAC-SHA256', issued_at: now(), user_id: FACEBOOK_USER };
    expect((await post('/auth/external/facebook/deauthorize', payload)).status).toBe(200);
    // The same payload to the other callback is answered (with a code), but removes no link.
    expect((await post('/auth/external/facebook/data-deletion', payload)).status).toBe(200);
    expect(mocks.unlink.mock.calls.map((call) => call[1].mayRemoveLink)).toEqual([true, false]);
  });

  it('lets a copy remove the link after a legal hold kept it', async () => {
    const payload = { algorithm: 'HMAC-SHA256', issued_at: now(), user_id: FACEBOOK_USER };
    mocks.unlink.mockResolvedValueOnce({ outcome: 'retained', userId: 'user-a' });
    expect((await post('/auth/external/facebook/deauthorize', payload)).status).toBe(200);
    expect((await post('/auth/external/facebook/data-deletion', payload)).status).toBe(200);
    expect(mocks.unlink.mock.calls.map((call) => call[1].mayRemoveLink)).toEqual([true, true]);
  });

  it('refuses when the replay store cannot answer', async () => {
    mocks.replayStoreDown = true;
    expect((await post('/auth/external/facebook/data-deletion')).status).toBe(500);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it('refuses a login-flow signed request (with a code) signed by the same app', async () => {
    const response = await post('/auth/external/facebook/deauthorize', {
      algorithm: 'HMAC-SHA256',
      issued_at: now(),
      user_id: FACEBOOK_USER,
      code: 'login-code',
    });
    expect(response.status).toBe(400);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it('refuses a request without a form-encoded signed_request', async () => {
    const response = await app.request(
      '/auth/external/facebook/data-deletion',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signed_request: 'x.y' }),
      },
      {}
    );
    expect(response.status).toBe(400);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it('takes the callbacks only for a Facebook Login provider', async () => {
    mocks.getProvider.mockResolvedValue({
      ...facebookProvider,
      providerType: 'oidc',
      name: 'Facebook (named only)',
      authorizationEndpoint: 'https://accounts.example.com/authorize',
      tokenEndpoint: 'https://accounts.example.com/token',
    });
    const response = await post('/auth/external/facebook/data-deletion');
    expect(response.status).toBe(404);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it('asks Meta to retry while another change to the account runs', async () => {
    const { LoginMethodRemovalInProgressError } = await import('@authrim/ar-lib-core');
    mocks.unlink.mockRejectedValue(new LoginMethodRemovalInProgressError());
    const response = await post('/auth/external/facebook/data-deletion');
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it('does nothing and asks for a retry for an account that is not active', async () => {
    mocks.unlink.mockResolvedValue({ outcome: 'account_inactive' });
    for (const path of [
      '/auth/external/facebook/data-deletion',
      '/auth/external/facebook/deauthorize',
    ]) {
      const response = await post(path);
      expect(response.status).toBe(503);
      // A retry must arrive while the signed request is still accepted (60 s at the least).
      expect(Number(response.headers.get('Retry-After'))).toBeLessThan(60);
      expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
    }
    expect(mocks.createRequest).not.toHaveBeenCalled();
    expect(mocks.recordActivity).not.toHaveBeenCalled();
    expect(mocks.audit.mock.calls[0]?.[1]).toMatchObject({ severity: 'warning' });
  });

  it('flags a hold placed during the unlink for the administrator', async () => {
    mocks.unlink.mockResolvedValue({
      outcome: 'unlink_pending',
      userId: 'user-a',
      accountId: 'account:user-a',
      linkedIdentityId: 'link-a',
      unlinkOperationId: 'external-idp-route-remove-x',
      attention: 'hold_placed_during_unlink',
    });
    const response = await post('/auth/external/facebook/data-deletion');
    expect(response.status).toBe(200);
    const entry = mocks.audit.mock.calls[0]?.[1];
    expect(entry).toMatchObject({ severity: 'warning' });
    expect(JSON.parse(entry?.metadata ?? '{}')).toMatchObject({
      attention: 'hold_placed_during_unlink',
    });
  });

  it('unlinks on deauthorize without keeping a status record', async () => {
    const response = await post('/auth/external/facebook/deauthorize');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(mocks.createRequest).not.toHaveBeenCalled();
    expect(mocks.audit.mock.calls[0]?.[1]).toMatchObject({ action: 'external_idp.deauthorized' });
    expect(mocks.recordActivity).toHaveBeenCalledWith(
      expect.anything(),
      'user-a',
      'account.social_account.unlinked',
      expect.objectContaining({ reason: 'provider_deauthorize' })
    );
  });

  it('refuses a deauthorize request that does not verify', async () => {
    const response = await post(
      '/auth/external/facebook/deauthorize',
      { algorithm: 'HMAC-SHA256', issued_at: now(), user_id: FACEBOOK_USER },
      'wrong-secret'
    );
    expect(response.status).toBe(400);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
});

describe('Facebook data deletion status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProvider.mockResolvedValue(facebookProvider);
  });

  const get = (code: string, accept?: string) =>
    app.request(
      `/auth/external/facebook/data-deletion/${code}`,
      { headers: accept ? { Accept: accept } : {} },
      {}
    );

  it('shows only the state, as JSON when asked for', async () => {
    mocks.readState.mockResolvedValue('completed');
    const response = await get(CODE, 'application/json');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ confirmation_code: CODE, status: 'completed' });
    expect(mocks.readState).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      providerId: 'provider-facebook',
      confirmationCode: CODE,
    });
  });

  it('shows a page to a browser', async () => {
    mocks.readState.mockResolvedValue('pending');
    const response = await get(CODE, 'text/html,application/xhtml+xml');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain(CODE);
    expect(html).toContain('pending');
    expect(html).not.toContain('<script');
  });

  it('finds nothing for an unknown or malformed code', async () => {
    mocks.readState.mockResolvedValue(null);
    expect((await get(CODE)).status).toBe(404);
    expect((await get('not-a-code')).status).toBe(404);
    expect(mocks.readState).toHaveBeenCalledTimes(1);
  });
});
