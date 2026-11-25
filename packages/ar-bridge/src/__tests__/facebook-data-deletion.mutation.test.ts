import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginMethodRemovalInProgressError, type Env } from '@authrim/ar-lib-core';
import { argRec, callArg, rec } from './helpers/mock-args';
import { anyOf, containing, matching } from './helpers/matchers';
import { hmacB64url, signFacebookRequest } from './helpers/facebook-signed-request';

const SECRET = 'facebook-app-secret';
const FB_USER = '10200000000000001';
const CODE = 'AbCdEfGhIjKlMnOpQrStUv';
const MAX_AGE = 600;

const m = vi.hoisted(() => ({
  moduleNames: [] as string[],
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getProvider: vi.fn(),
  unlink: vi.fn(),
  createRequest: vi.fn(),
  readState: vi.fn(),
  activity: vi.fn(),
  audit: vi.fn(),
  isRecorded: vi.fn(),
  record: vi.fn(),
  key: vi.fn(),
  decrypt: vi.fn(),
  recorded: new Set<string>(),
}));

vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => ({
      module: (name: string) => {
        m.moduleNames.push(name);
        return m.log;
      },
    }),
    getTenantIdFromContext: () => 'tenant-a',
    buildIssuerUrl: (_env: unknown, tenantId: string) => `https://${tenantId}.example.com`,
    createAuditLog: m.audit,
    isReplayJtiRecorded: m.isRecorded,
    recordReplayJti: m.record,
  };
});
vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug: m.getProvider }));
vi.mock('../services/link-intent', () => ({ recordSocialAccountActivity: m.activity }));
vi.mock('../utils/crypto', () => ({
  getEncryptionKeyOrUndefined: m.key,
  decrypt: m.decrypt,
}));
vi.mock('../services/provider-data-deletion', async (original) => {
  const actual = await original<typeof import('../services/provider-data-deletion')>();
  return {
    ...actual,
    resolveSignedRequestMaxAgeSeconds: async () => MAX_AGE,
    unlinkProviderSubject: m.unlink,
    createDataDeletionRequest: m.createRequest,
    readDataDeletionRequestState: m.readState,
  };
});

import {
  handleFacebookDataDeletion,
  handleFacebookDataDeletionStatus,
  handleFacebookDeauthorize,
  publicDataDeletionStatus,
} from '../handlers/facebook-data-deletion';

const app = new Hono<{ Bindings: Env }>();
app.post('/auth/external/:provider/data-deletion', handleFacebookDataDeletion);
app.post('/auth/external/:provider/deauthorize', handleFacebookDeauthorize);
app.post('/auth/external/data-deletion', handleFacebookDataDeletion);
app.get('/auth/external/:provider/data-deletion/:code', handleFacebookDataDeletionStatus);

const provider = {
  id: 'provider-facebook',
  slug: 'facebook',
  providerType: 'oauth2',
  clientSecretEncrypted: 'encrypted-secret',
  authorizationEndpoint: 'https://www.facebook.com/v20.0/dialog/oauth',
  tokenEndpoint: 'https://graph.facebook.com/v20.0/oauth/access_token',
};
const now = () => Math.floor(Date.now() / 1000);
const payload = () => ({ algorithm: 'HMAC-SHA256', issued_at: now(), user_id: FB_USER });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function formRequest(path: string, signed: string, contentType?: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': contentType ?? 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ signed_request: signed }),
      },
      {}
    )
  );
}

function post(path = '/auth/external/facebook/data-deletion', body = payload()) {
  return formRequest(path, signFacebookRequest(body, SECRET));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.moduleNames.length = 0;
  m.recorded.clear();
  m.getProvider.mockReset().mockResolvedValue(provider);
  m.key.mockReset().mockReturnValue('k'.repeat(64));
  m.decrypt.mockReset().mockResolvedValue(SECRET);
  m.isRecorded
    .mockReset()
    .mockImplementation(async (_e: unknown, i: { jti: string }) => m.recorded.has(i.jti));
  m.record.mockReset().mockImplementation(async (_e: unknown, i: { jti: string }) => {
    m.recorded.add(i.jti);
    return 'recorded';
  });
  m.unlink.mockReset().mockResolvedValue({
    outcome: 'unlink_pending',
    userId: 'user-a',
    linkedIdentityId: 'link-a',
    unlinkOperationId: 'op-1',
  });
  m.createRequest.mockReset().mockResolvedValue({ confirmationCode: CODE, state: 'pending' });
  m.readState.mockReset().mockResolvedValue('pending');
  m.audit.mockReset().mockResolvedValue(undefined);
  m.activity.mockReset().mockResolvedValue(undefined);
});

describe('provider resolution and request reading', () => {
  it('logs under the EXTERNAL-IDP module', async () => {
    await post();
    await app.request(`/auth/external/facebook/data-deletion/${CODE}`, {}, {});
    expect(m.moduleNames).toEqual(['EXTERNAL-IDP', 'EXTERNAL-IDP']);
  });

  it('refuses a request that has no content type at all', async () => {
    const res = await app.request('/auth/external/facebook/data-deletion', { method: 'POST' }, {});
    expect(res.status).toBe(400);
    expect(m.key).not.toHaveBeenCalled();
  });

  it('answers 500 when the provider lookup fails', async () => {
    m.getProvider.mockRejectedValue(new Error('db'));
    const res = await post();
    expect(res.status).toBe(500);
    expect(m.log.error).toHaveBeenCalledWith(
      'Facebook callback: provider lookup failed',
      { kind: 'data_deletion' },
      expect.any(Error)
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(m.unlink).not.toHaveBeenCalled();
  });

  it('labels the deauthorize callback in the same log', async () => {
    m.getProvider.mockRejectedValue(new Error('db'));
    await post('/auth/external/facebook/deauthorize');
    expect(m.log.error).toHaveBeenCalledWith(
      'Facebook callback: provider lookup failed',
      { kind: 'deauthorize' },
      expect.any(Error)
    );
  });

  it('answers 404 for a missing, unknown or non-Facebook provider', async () => {
    expect((await post('/auth/external/data-deletion')).status).toBe(404);
    expect(m.getProvider).not.toHaveBeenCalled();
    m.getProvider.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(m.getProvider).toHaveBeenCalledWith(expect.anything(), 'facebook', 'tenant-a');
    m.getProvider.mockResolvedValue({ ...provider, providerType: 'oidc' });
    expect((await post()).status).toBe(404);
    m.getProvider.mockResolvedValue({ ...provider, enabled: false });
    expect((await post()).status).toBe(200);
  });

  it('accepts a multipart form but nothing else', async () => {
    const signed = signFacebookRequest(payload(), SECRET);
    const form = new FormData();
    form.set('signed_request', signed);
    const ok = await app.request(
      '/auth/external/facebook/data-deletion',
      { method: 'POST', body: form },
      {}
    );
    expect(ok.status).toBe(200);
    m.unlink.mockClear();
    for (const type of ['application/json', 'text/plain']) {
      const res = await formRequest('/auth/external/facebook/data-deletion', signed, type);
      expect(res.status).toBe(400);
    }
    expect(m.unlink).not.toHaveBeenCalled();
  });

  it('treats the form content type case-insensitively', async () => {
    const res = await formRequest(
      '/auth/external/facebook/data-deletion',
      signFacebookRequest(payload(), SECRET),
      'Application/X-WWW-Form-Urlencoded; charset=utf-8'
    );
    expect(res.status).toBe(200);
  });

  it('refuses a missing, empty or unreadable signed_request', async () => {
    const bodies: Array<[string, BodyInit | null, string]> = [
      ['absent field', new URLSearchParams({ other: 'x' }), 'application/x-www-form-urlencoded'],
      [
        'empty field',
        new URLSearchParams({ signed_request: '' }),
        'application/x-www-form-urlencoded',
      ],
      ['no body', null, 'application/x-www-form-urlencoded'],
      ['broken multipart', 'not multipart', 'multipart/form-data; boundary=x'],
    ];
    for (const [, body, type] of bodies) {
      const res = await app.request(
        '/auth/external/facebook/data-deletion',
        { method: 'POST', headers: { 'Content-Type': type }, body },
        {}
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'The signed request could not be verified.',
      });
    }
    expect(m.key).not.toHaveBeenCalled();
  });
});

describe('verification', () => {
  it('answers 500 and never acts when the app secret is unavailable', async () => {
    const cases: Array<[string, () => void, string]> = [
      ['no key', () => m.key.mockReturnValue(undefined), 'Error'],
      [
        'no encrypted secret',
        () => m.getProvider.mockResolvedValue({ ...provider, clientSecretEncrypted: '' }),
        'Error',
      ],
      ['decrypt failure', () => m.decrypt.mockRejectedValue(new TypeError('bad')), 'TypeError'],
      ['decrypt text failure', () => m.decrypt.mockRejectedValue('bad'), 'UnknownError'],
    ];
    for (const [, arrange, errorName] of cases) {
      m.log.error.mockClear();
      arrange();
      const res = await post();
      expect(res.status).toBe(500);
      expect(m.log.error).toHaveBeenCalledWith('Facebook callback: app secret unavailable', {
        kind: 'data_deletion',
        providerId: 'provider-facebook',
        errorName,
      });
      expect(m.unlink).not.toHaveBeenCalled();
      m.key.mockReturnValue('k'.repeat(64));
      m.getProvider.mockResolvedValue(provider);
      m.decrypt.mockResolvedValue(SECRET);
    }
  });

  it('decrypts the app secret with the encryption key', async () => {
    await post();
    expect(m.decrypt).toHaveBeenCalledWith('encrypted-secret', 'k'.repeat(64));
  });

  it('logs why a signed request was rejected', async () => {
    const res = await formRequest(
      '/auth/external/facebook/deauthorize',
      signFacebookRequest(payload(), 'wrong-secret')
    );
    expect(res.status).toBe(400);
    expect(m.log.warn).toHaveBeenCalledWith('Facebook callback: signed request rejected', {
      kind: 'deauthorize',
      providerId: 'provider-facebook',
      reason: anyOf(String),
    });
  });

  describe('the tenant maximum age', () => {
    const FIXED_NOW_MS = Date.UTC(2026, 5, 1, 12, 0, 0);
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(FIXED_NOW_MS);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('accepts a request exactly at its maximum age and refuses one a second older', async () => {
      const issuedAt = FIXED_NOW_MS / 1000 - MAX_AGE;
      const exact = { algorithm: 'HMAC-SHA256', issued_at: issuedAt, user_id: FB_USER };
      expect((await post(undefined, exact)).status).toBe(200);
      m.recorded.clear();
      const older = { ...exact, issued_at: issuedAt - 1 };
      expect((await post(undefined, older)).status).toBe(400);
    });
  });
});

describe('replay protection', () => {
  it('keys the replay records on the payload digest, per callback kind and provider', async () => {
    const body = payload();
    const signed = signFacebookRequest(body, SECRET);
    const encodedPayload = signed.slice(signed.indexOf('.') + 1);
    const digest = sha(encodedPayload);
    const res = await formRequest('/auth/external/facebook/data-deletion', signed);
    expect(res.status).toBe(200);
    expect(m.isRecorded.mock.calls.map((c): unknown => c[1])).toEqual([
      {
        tenantId: 'tenant-a',
        shardKey: 'provider-facebook',
        jti: `facebook-data_deletion:provider-facebook:${digest}`,
      },
      {
        tenantId: 'tenant-a',
        shardKey: 'provider-facebook',
        jti: `facebook-unlink:provider-facebook:${digest}`,
      },
    ]);
    const ttl = { issuedAt: body.issued_at, ttlSeconds: MAX_AGE + 60 };
    expect(m.record.mock.calls.map((c): unknown => c[1])).toEqual([
      {
        tenantId: 'tenant-a',
        shardKey: 'provider-facebook',
        jti: `facebook-unlink:provider-facebook:${digest}`,
        ...ttl,
      },
      {
        tenantId: 'tenant-a',
        shardKey: 'provider-facebook',
        jti: `facebook-data_deletion:provider-facebook:${digest}`,
        ...ttl,
      },
    ]);
  });

  it('uses the deauthorize kind in its own replay key', async () => {
    await post('/auth/external/facebook/deauthorize');
    const jtis = m.record.mock.calls.map((c) => rec(c[1]).jti as string);
    expect(jtis[1]).toMatch(/^facebook-deauthorize:provider-facebook:[0-9a-f]{64}$/);
  });

  it('refuses a replayed request without unlinking, and logs it', async () => {
    const signed = signFacebookRequest(payload(), SECRET);
    expect((await formRequest('/auth/external/facebook/data-deletion', signed)).status).toBe(200);
    m.unlink.mockClear();
    const res = await formRequest('/auth/external/facebook/data-deletion', signed);
    expect(res.status).toBe(400);
    expect(m.log.warn).toHaveBeenCalledWith('Facebook callback: signed request replayed', {
      kind: 'data_deletion',
      providerId: 'provider-facebook',
    });
    expect(m.unlink).not.toHaveBeenCalled();
  });

  it('does not remove a link again when another callback already did', async () => {
    const signed = signFacebookRequest(payload(), SECRET);
    await formRequest('/auth/external/facebook/data-deletion', signed);
    await formRequest('/auth/external/facebook/deauthorize', signed);
    expect(argRec(m.unlink, 1, 1).mayRemoveLink).toBe(false);
    expect(argRec(m.unlink, 0, 1).mayRemoveLink).toBe(true);
  });

  it('answers 500 and logs when the replay store is unavailable', async () => {
    m.isRecorded.mockRejectedValue(new Error('store down'));
    const res = await post();
    expect(res.status).toBe(500);
    expect(m.log.error).toHaveBeenCalledWith(
      'Facebook callback: replay store unavailable',
      { kind: 'data_deletion' },
      expect.any(Error)
    );
    expect(m.unlink).not.toHaveBeenCalled();
  });

  it('passes the unlink the verified subject, issue time and a working payload guard', async () => {
    const body = payload();
    await post(undefined, body);
    const input = argRec(m.unlink, 0, 1);
    expect(input).toMatchObject({
      tenantId: 'tenant-a',
      providerId: 'provider-facebook',
      providerUserId: FB_USER,
      requestIssuedAt: body.issued_at,
      mayRemoveLink: true,
    });
    const guard = rec(input.payloadGuard) as {
      alreadyRemoved: () => Promise<boolean>;
      markRemoved: () => Promise<void>;
    };
    m.record.mockClear();
    expect(await guard.alreadyRemoved()).toBe(true);
    m.recorded.clear();
    expect(await guard.alreadyRemoved()).toBe(false);
    await guard.markRemoved();
    expect(m.record).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      shardKey: 'provider-facebook',
      jti: matching(/^facebook-unlink:provider-facebook:/),
      issuedAt: body.issued_at,
      ttlSeconds: MAX_AGE + 60,
    });
  });

  it('keeps the answer when the guard cannot record the unlink', async () => {
    await post();
    const guard = rec(argRec(m.unlink, 0, 1).payloadGuard) as { markRemoved: () => Promise<void> };
    m.record.mockRejectedValue(new Error('rec down'));
    await expect(guard.markRemoved()).resolves.toBeUndefined();
    expect(m.log.error).toHaveBeenCalledWith(
      'Facebook callback: unlink record failed',
      { kind: 'data_deletion' },
      expect.any(Error)
    );
  });

  it('still answers when the replay record cannot be written', async () => {
    m.record.mockRejectedValue(new Error('rec down'));
    const res = await post();
    expect(res.status).toBe(200);
    expect(m.log.error).toHaveBeenCalledWith(
      'Facebook callback: replay record failed',
      { kind: 'data_deletion' },
      expect.any(Error)
    );
  });

  it('records only the request, not the unlink, when a hold retained the link', async () => {
    m.unlink.mockResolvedValue({
      outcome: 'retained',
      userId: 'user-a',
      linkedIdentityId: 'link-a',
    });
    await post();
    const jtis = m.record.mock.calls.map((c) => rec(c[1]).jti as string);
    expect(jtis).toHaveLength(1);
    expect(jtis[0]).toMatch(/^facebook-data_deletion:/);
  });
});

describe('padding of the signed payload', () => {
  it('treats a payload re-encoded with padding of any length as the same request', async () => {
    const body = payload();
    const plain = signFacebookRequest(body, SECRET);
    const encodedPayload = plain.slice(plain.indexOf('.') + 1);
    const padded = `${hmacB64url(`${encodedPayload}==`, SECRET)}.${encodedPayload}==`;
    expect((await formRequest('/auth/external/facebook/data-deletion', plain)).status).toBe(200);
    m.unlink.mockClear();
    const res = await formRequest('/auth/external/facebook/data-deletion', padded);
    // refused as a replay (or as unverifiable): either way nothing is unlinked twice
    expect(res.status).toBe(400);
    expect(m.unlink).not.toHaveBeenCalled();
    expect(m.log.warn).toHaveBeenCalledWith('Facebook callback: signed request replayed', {
      kind: 'data_deletion',
      providerId: 'provider-facebook',
    });
  });
});

describe('unlink failures', () => {
  it.each([
    ['the in-progress error', () => new LoginMethodRemovalInProgressError()],
    ['an error with its message', () => new Error('login_method_removal_in_progress')],
  ])('asks Meta to retry on %s', async (_n, make) => {
    m.unlink.mockRejectedValue(make());
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Another change to the account is in progress; retry shortly.',
    });
    expect(m.record).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('answers 500 for any other failure and logs it', async () => {
    for (const error of [new Error('boom'), 'login_method_removal_in_progress']) {
      m.log.error.mockClear();
      m.unlink.mockRejectedValue(error);
      const res = await post();
      expect(res.status).toBe(500);
      expect(res.headers.get('Retry-After')).toBeNull();
      expect(m.log.error).toHaveBeenCalledWith(
        'Facebook callback: unlink failed',
        { kind: 'data_deletion', providerId: 'provider-facebook' },
        error
      );
    }
  });

  it('never answers an inactive account as done', async () => {
    m.unlink.mockResolvedValue({ outcome: 'account_inactive', userId: 'user-a' });
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'The request cannot be processed now; retry later.',
    });
    expect(m.createRequest).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
    expect(m.activity).not.toHaveBeenCalled();
    expect(argRec(m.audit, 0, 1)).toMatchObject({ severity: 'warning' });
  });

  it('answers 500 when the status record cannot be created, keeping the request unrecorded', async () => {
    m.createRequest.mockRejectedValue(new Error('no table'));
    const res = await post();
    expect(res.status).toBe(500);
    expect(m.log.error).toHaveBeenCalledWith(
      'Facebook callback: status record failed',
      { providerId: 'provider-facebook' },
      expect.any(Error)
    );
    expect(m.record).not.toHaveBeenCalled();
  });
});

describe('answers, audit and activity', () => {
  it('builds the status URL from the slug, falling back to the id, percent-encoded', async () => {
    let res = await post();
    expect(rec(await res.json()).url).toBe(
      `https://tenant-a.example.com/auth/external/facebook/data-deletion/${CODE}`
    );
    m.recorded.clear();
    m.getProvider.mockResolvedValue({ ...provider, slug: '' });
    res = await post();
    expect(rec(await res.json()).url).toBe(
      `https://tenant-a.example.com/auth/external/provider-facebook/data-deletion/${CODE}`
    );
    m.recorded.clear();
    m.getProvider.mockResolvedValue({ ...provider, slug: 'a b/c' });
    res = await post();
    expect(rec(await res.json()).url).toBe(
      `https://tenant-a.example.com/auth/external/a%20b%2Fc/data-deletion/${CODE}`
    );
  });

  it('asks for the status record with the unlink result', async () => {
    await post();
    expect(m.createRequest).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      providerId: 'provider-facebook',
      result: containing({ outcome: 'unlink_pending' }),
    });
  });

  it('answers deauthorize with an empty 200 and no status record', async () => {
    const res = await post('/auth/external/facebook/deauthorize');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(m.createRequest).not.toHaveBeenCalled();
    expect(argRec(m.audit, 0, 1)).toMatchObject({
      action: 'external_idp.deauthorized',
      resource: 'upstream_provider',
      resourceId: 'provider-facebook',
      userId: 'system',
      ipAddress: '',
      userAgent: '',
      severity: 'info',
    });
    expect(callArg(m.activity, 0, 2)).toBe('account.social_account.unlinked');
    expect(callArg(m.activity, 0, 3)).toEqual({
      linkedIdentityId: 'link-a',
      providerId: 'provider-facebook',
      reason: 'provider_deauthorize',
    });
    expect(m.log.info).toHaveBeenCalledWith('Facebook callback processed', {
      kind: 'deauthorize',
      providerId: 'provider-facebook',
      outcome: 'unlink_pending',
    });
  });

  it('puts the unlink details and a hash of the code in the audit metadata', async () => {
    m.unlink.mockResolvedValue({
      outcome: 'unlink_pending',
      userId: 'user-a',
      linkedIdentityId: 'link-a',
      unlinkOperationId: 'op-1',
      attention: 'hold_placed',
    });
    await post();
    const entry = argRec(m.audit, 0, 1);
    expect(entry.action).toBe('external_idp.data_deletion_requested');
    expect(entry.severity).toBe('warning');
    expect(JSON.parse(String(entry.metadata))).toEqual({
      provider_id: 'provider-facebook',
      outcome: 'unlink_pending',
      user_id: 'user-a',
      linked_identity_id: 'link-a',
      unlink_operation_id: 'op-1',
      attention: 'hold_placed',
      confirmation_code_sha256: sha(CODE),
      status: 'pending',
    });
  });

  it('leaves out what the result does not carry', async () => {
    m.unlink.mockResolvedValue({ outcome: 'no_link' });
    await post('/auth/external/facebook/deauthorize');
    expect(JSON.parse(String(argRec(m.audit, 0, 1).metadata))).toEqual({
      provider_id: 'provider-facebook',
      outcome: 'no_link',
    });
    expect(m.activity).not.toHaveBeenCalled();
  });

  it.each([
    ['no user', { outcome: 'unlink_pending', linkedIdentityId: 'l' }],
    ['no linked identity', { outcome: 'unlink_pending', userId: 'u' }],
    ['a retained link', { outcome: 'retained', userId: 'u', linkedIdentityId: 'l' }],
  ])('records no unlink activity for %s', async (_n, result) => {
    m.unlink.mockResolvedValue(result);
    await post();
    expect(m.activity).not.toHaveBeenCalled();
  });

  it('records the data-deletion reason in the activity', async () => {
    await post();
    expect(callArg(m.activity, 0, 1)).toBe('user-a');
    expect(rec(callArg(m.activity, 0, 3)).reason).toBe('provider_data_deletion');
  });

  it.each([
    ['unlink_pending', undefined, 'info'],
    ['retained', undefined, 'warning'],
    ['account_inactive', undefined, 'warning'],
    ['unlink_pending', 'x', 'warning'],
  ])('audits outcome %s with attention %s as %s', async (outcome, attention, severity) => {
    m.unlink.mockResolvedValue({ outcome, attention, userId: 'u', linkedIdentityId: 'l' });
    await post();
    expect(argRec(m.audit, 0, 1).severity).toBe(severity);
  });

  it('still answers when the audit log cannot be written', async () => {
    m.audit.mockRejectedValue(new Error('audit down'));
    const res = await post();
    expect(res.status).toBe(200);
    expect(m.log.error).toHaveBeenCalledWith(
      'Facebook callback: audit log failed',
      { kind: 'data_deletion', outcome: 'unlink_pending' },
      expect.any(Error)
    );
  });
});

describe('status page', () => {
  const get = (code: string, accept?: string, path = 'facebook') =>
    app.request(
      `/auth/external/${path}/data-deletion/${code}`,
      { headers: accept ? { Accept: accept } : {} },
      {}
    );

  it('sets the privacy headers on both representations', async () => {
    for (const accept of ['application/json', 'text/html']) {
      const res = await get(CODE, accept);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    }
  });

  it('answers 404 for a code of the wrong shape without a lookup', async () => {
    for (const code of ['short', `${CODE}x`, 'AbCdEfGhIjKlMnOpQrSt+/']) {
      expect((await get(code)).status).toBe(404);
    }
    expect(m.getProvider).not.toHaveBeenCalled();
    expect(m.readState).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown provider and does not read a state', async () => {
    m.getProvider.mockResolvedValue(null);
    expect((await get(CODE)).status).toBe(404);
    expect(m.readState).not.toHaveBeenCalled();
  });

  it('answers 500 and logs when the lookup fails', async () => {
    m.readState.mockRejectedValue(new Error('db'));
    expect((await get(CODE)).status).toBe(500);
    expect(m.log.error).toHaveBeenCalledWith(
      'Facebook data deletion status lookup failed',
      {},
      expect.any(Error)
    );
  });

  it('serves JSON only when JSON alone is accepted', async () => {
    expect((await get(CODE, 'application/json')).headers.get('Content-Type')).toContain('json');
    expect((await get(CODE, 'Application/JSON')).headers.get('Content-Type')).toContain('json');
    for (const accept of ['application/json, text/html', 'text/html', '*/*', undefined]) {
      expect((await get(CODE, accept)).headers.get('Content-Type')).toContain('text/html');
    }
  });

  it('renders a complete page with the code, state and message', async () => {
    m.readState.mockResolvedValue('completed');
    const html = await (await get(CODE)).text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain(`<code>${CODE}</code>`);
    expect(html).toContain('<strong>completed</strong>');
    expect(html).toContain('Your request is complete.');
    m.readState.mockResolvedValue('pending');
    expect(await (await get(CODE)).text()).toContain('Your request is being processed.');
  });

  it('maps every state to its public status', () => {
    expect(publicDataDeletionStatus('retained')).toBe('operator_action_required');
    expect(publicDataDeletionStatus('pending')).toBe('pending');
    expect(publicDataDeletionStatus('completed')).toBe('completed');
  });
});
