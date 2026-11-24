import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { argRec } from './helpers/mock-args';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  getChallengeStoreByChallengeId: vi.fn(),
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
  createAuditLog: vi.fn(),
  getUIConfig: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getChallengeStoreByChallengeId: mocks.getChallengeStoreByChallengeId,
  createAuditLog: mocks.createAuditLog,
  getUIConfig: mocks.getUIConfig,
  getTenantIdFromContext: () => 'tenant-1',
  getLogger: () => ({ module: () => ({ warn: mocks.warn }) }),
}));

import {
  LINK_INTENT_TTL_SECONDS,
  accountPageLinkResultUrl,
  consumeLinkIntent,
  createLinkIntent,
  recordSocialAccountActivity,
} from '../services/link-intent';

const ENV = {
  ISSUER_URL: 'https://issuer.example',
  DEFAULT_TENANT_ID: 'default',
} as unknown as Env;
const TOKEN = 'A'.repeat(43);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getChallengeStoreByChallengeId.mockResolvedValue({
    storeChallengeRpc: mocks.storeChallengeRpc,
    consumeChallengeRpc: mocks.consumeChallengeRpc,
  });
  mocks.getUIConfig.mockResolvedValue(null);
});

describe('createLinkIntent', () => {
  it('stores a one-use challenge naming user, session and provider', async () => {
    const token = await createLinkIntent(ENV, 'tenant-1', {
      userId: 'user-1',
      sessionId: 'sess-1',
      providerId: 'prov-1',
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(LINK_INTENT_TTL_SECONDS).toBe(300);
    expect(mocks.getChallengeStoreByChallengeId).toHaveBeenCalledWith(ENV, token, 'tenant-1');
    expect(mocks.storeChallengeRpc).toHaveBeenCalledTimes(1);
    expect(mocks.storeChallengeRpc).toHaveBeenCalledWith({
      id: token,
      tenantId: 'tenant-1',
      type: 'external_idp_link_intent',
      userId: 'user-1',
      challenge: token,
      ttl: 300,
      metadata: { sessionId: 'sess-1', providerId: 'prov-1' },
    });
  });

  it('issues a distinct token every time', async () => {
    const intent = { userId: 'u', sessionId: 's', providerId: 'p' };
    const a = await createLinkIntent(ENV, 't', intent);
    const b = await createLinkIntent(ENV, 't', intent);
    expect(a).not.toBe(b);
  });
});

describe('consumeLinkIntent', () => {
  it('returns the intent and consumes with the matching request', async () => {
    mocks.consumeChallengeRpc.mockResolvedValue({
      userId: 'user-1',
      metadata: { sessionId: 'sess-1', providerId: 'prov-1' },
    });
    expect(await consumeLinkIntent(ENV, 'tenant-1', TOKEN)).toEqual({
      userId: 'user-1',
      sessionId: 'sess-1',
      providerId: 'prov-1',
    });
    expect(mocks.getChallengeStoreByChallengeId).toHaveBeenCalledWith(ENV, TOKEN, 'tenant-1');
    expect(mocks.consumeChallengeRpc).toHaveBeenCalledWith({
      id: TOKEN,
      tenantId: 'tenant-1',
      type: 'external_idp_link_intent',
      challenge: TOKEN,
    });
  });

  it.each([
    '',
    'A'.repeat(42),
    'A'.repeat(44),
    `${'A'.repeat(42)}+`,
    `${'A'.repeat(42)}=`,
    `x${'A'.repeat(42)}\n`,
  ])('rejects a malformed token without touching the store: %j', async (token) => {
    expect(await consumeLinkIntent(ENV, 'tenant-1', token)).toBeNull();
    expect(mocks.getChallengeStoreByChallengeId).not.toHaveBeenCalled();
  });

  it('accepts every character of the base64url alphabet', async () => {
    mocks.consumeChallengeRpc.mockResolvedValue({
      userId: 'u',
      metadata: { sessionId: 's', providerId: 'p' },
    });
    const token = `${'aZ09_-'.repeat(7)}x`;
    expect(await consumeLinkIntent(ENV, 'tenant-1', token)).not.toBeNull();
  });

  it.each([
    ['no user', { metadata: { sessionId: 's', providerId: 'p' } }],
    ['empty user', { userId: '', metadata: { sessionId: 's', providerId: 'p' } }],
    ['no metadata', { userId: 'u' }],
    ['no session', { userId: 'u', metadata: { providerId: 'p' } }],
    ['numeric session', { userId: 'u', metadata: { sessionId: 1, providerId: 'p' } }],
    ['no provider', { userId: 'u', metadata: { sessionId: 's' } }],
    ['numeric provider', { userId: 'u', metadata: { sessionId: 's', providerId: 2 } }],
  ])('returns null for an incomplete consume result (%s)', async (_name, consumed) => {
    mocks.consumeChallengeRpc.mockResolvedValue(consumed);
    expect(await consumeLinkIntent(ENV, 'tenant-1', TOKEN)).toBeNull();
  });

  it('returns null when the store rejects (unknown, expired or used)', async () => {
    mocks.consumeChallengeRpc.mockRejectedValue(new Error('gone'));
    expect(await consumeLinkIntent(ENV, 'tenant-1', TOKEN)).toBeNull();
    mocks.getChallengeStoreByChallengeId.mockRejectedValue(new Error('no store'));
    expect(await consumeLinkIntent(ENV, 'tenant-1', TOKEN)).toBeNull();
  });
});

describe('accountPageLinkResultUrl', () => {
  it('reports a successful link on the configured UI base URL', async () => {
    mocks.getUIConfig.mockResolvedValue({ baseUrl: 'https://ui.example/base' });
    const url = await accountPageLinkResultUrl(ENV, 'default', { linked: true });
    expect(url).toBe('https://ui.example/account?social_link=linked');
    expect(mocks.getUIConfig).toHaveBeenCalledWith(ENV, 'default');
  });

  it('reports a failure with its reason and falls back to the issuer URL', async () => {
    mocks.getUIConfig.mockResolvedValue({ baseUrl: '' });
    expect(
      await accountPageLinkResultUrl(ENV, 'default', { linked: false, reason: 'already_linked' })
    ).toBe('https://issuer.example/account?social_link=error&reason=already_linked');
    mocks.getUIConfig.mockResolvedValue(null);
    expect(
      await accountPageLinkResultUrl(ENV, 'default', { linked: false, reason: 'cancelled' })
    ).toBe('https://issuer.example/account?social_link=error&reason=cancelled');
  });

  it('adds a tenant hint only for non-default tenants', async () => {
    const other = await accountPageLinkResultUrl(ENV, 'acme', { linked: true });
    expect(other).toBe('https://issuer.example/account?social_link=linked&tenant_hint=acme');
    const same = await accountPageLinkResultUrl(ENV, 'default', { linked: true });
    expect(same).not.toContain('tenant_hint');
  });
});

describe('recordSocialAccountActivity', () => {
  const run = async (
    headers: Record<string, string>,
    extra: { reason?: 'provider_deauthorize' } = {}
  ) => {
    const instance = new Hono<{ Bindings: Env }>();
    instance.get('/x', async (c) => {
      await recordSocialAccountActivity(c, 'user-1', 'account.social_account.linked', {
        linkedIdentityId: 'li-1',
        providerId: 'prov-1',
        ...extra,
      });
      return c.text('ok');
    });
    return instance.request('https://rp.example/x', { headers }, ENV);
  };

  it('writes an audit log with the client address and user agent', async () => {
    mocks.createAuditLog.mockResolvedValue(undefined);
    await run({
      'CF-Connecting-IP': '203.0.113.5',
      'X-Forwarded-For': '1.1.1.1',
      'User-Agent': 'UA/1',
    });
    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(ENV, {
      tenantId: 'tenant-1',
      userId: 'user-1',
      action: 'account.social_account.linked',
      resource: 'linked_identity',
      resourceId: 'li-1',
      ipAddress: '203.0.113.5',
      userAgent: 'UA/1',
      metadata: JSON.stringify({ linkedIdentityId: 'li-1', providerId: 'prov-1' }),
      severity: 'info',
    });
  });

  it('falls back to the first X-Forwarded-For entry, trimmed, then to unknown', async () => {
    await run(
      { 'X-Forwarded-For': ' 198.51.100.7 , 10.0.0.1' },
      { reason: 'provider_deauthorize' }
    );
    const first = argRec(mocks.createAuditLog, 0, 1);
    expect(first.ipAddress).toBe('198.51.100.7');
    expect(first.metadata).toBe(
      JSON.stringify({
        linkedIdentityId: 'li-1',
        providerId: 'prov-1',
        reason: 'provider_deauthorize',
      })
    );
    await run({});
    const second = argRec(mocks.createAuditLog, 1, 1);
    expect(second.ipAddress).toBe('unknown');
    expect(second.userAgent).toBe('unknown');
  });

  it('never fails the request when the audit write fails, and logs only the error name', async () => {
    mocks.createAuditLog.mockRejectedValue(new TypeError('secret detail'));
    const response = await run({});
    expect(response.status).toBe(200);
    expect(mocks.warn).toHaveBeenCalledWith('Failed to record the account activity', {
      action: 'account.social_account.linked',
      errorName: 'TypeError',
    });
    mocks.createAuditLog.mockRejectedValue('plain string');
    await run({});
    expect(mocks.warn).toHaveBeenLastCalledWith('Failed to record the account activity', {
      action: 'account.social_account.linked',
      errorName: 'Unknown',
    });
  });
});
