import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  runtime: vi.fn(),
  current: vi.fn(),
  canonical: vi.fn(),
  limits: vi.fn(),
  rate: vi.fn(),
  kind: vi.fn(),
  kindChecked: vi.fn(),
  reauthUser: vi.fn(),
  accountSession: vi.fn(),
  verify: vi.fn(),
  host: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  readLiteRuntimeState: m.runtime,
  readCurrentLitePolicySnapshot: m.current,
  buildCanonicalTenantIssuerUrl: m.canonical,
  readLiteTxnLimits: m.limits,
  checkRateLimit: m.rate,
  readAuthorizationChallengeKind: m.kind,
  readAuthorizationChallengeKindChecked: m.kindChecked,
  readReauthChallengeUser: m.reauthUser,
  readAccountSession: m.accountSession,
  verifyHumanVerificationWithRunner: m.verify,
  getTenantIdFromHost: m.host,
  resolveTenantFromVanityHost: vi.fn(async () => null),
}));

import { LITE_TXN_AUDIENCE, LiteTxnEntrypoint, checkedReturnTo } from '../lite-txn-entrypoint';

type Rec = Record<string, unknown>;
const argOf = (fn: { mock: { calls: unknown[][] } }, call: number, index: number) =>
  fn.mock.calls[call][index] as Rec;

const ORIGIN = 'https://id.example';
const BINDING = 'b'.repeat(43);
const store = {
  createTxnRpc: vi.fn(),
  getTxnRpc: vi.fn(),
  completeOperationRpc: vi.fn(),
  issueStartGrantRpc: vi.fn(),
};

function entry(env: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  return new LiteTxnEntrypoint(
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {
        caller: 'ar-login-ui',
        audience: LITE_TXN_AUDIENCE,
        environmentId: 'test',
        ...props,
      },
    } as never,
    {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      ISSUER_URL: ORIGIN,
      LITE_TXN_STORE: { idFromName: (n: string) => n, get: () => store },
      ...env,
    } as never
  );
}

const call = { publicOrigin: ORIGIN, binding: BINDING };
const create = (extra: Record<string, unknown> = {}) =>
  entry().create({ ...call, clientIp: '203.0.113.1', purpose: 'login', ...extra } as never);

beforeEach(() => {
  vi.clearAllMocks();
  m.host.mockImplementation((host: string) =>
    host === 'id.example' ? { success: true, tenantId: 'default' } : { success: false }
  );
  m.runtime.mockResolvedValue({ policyRevision: 'rev-cache' });
  m.current.mockResolvedValue({ liteMode: 'always', policyRevision: 'rev-now' });
  m.canonical.mockResolvedValue(`${ORIGIN}/`);
  m.limits.mockResolvedValue({ perIpPerMinute: 5, perTenantPerMinute: 50, perBrowser: 3 });
  m.rate.mockResolvedValue({ allowed: true });
  m.kindChecked.mockResolvedValue('login');
  m.kind.mockResolvedValue('login');
  m.verify.mockResolvedValue({ verified: true });
  store.createTxnRpc.mockResolvedValue({ ok: true });
  store.getTxnRpc.mockResolvedValue({
    ok: true,
    txn: { bound: { purpose: 'login', challengeId: null }, data: { invite: null } },
  });
  store.completeOperationRpc.mockResolvedValue({ ok: true });
  store.issueStartGrantRpc.mockResolvedValue({ ok: true, grantId: 'g' });
});

describe('checkedReturnTo', () => {
  it('accepts a local path or a URL of the public origin', () => {
    expect(checkedReturnTo(null, ORIGIN)).toBeNull();
    expect(checkedReturnTo(undefined, ORIGIN)).toBeNull();
    expect(checkedReturnTo('/account', ORIGIN)).toBe('/account');
    expect(checkedReturnTo(`${ORIGIN}/x?y=1`, ORIGIN)).toBe(`${ORIGIN}/x?y=1`);
    expect(checkedReturnTo('http://local.test/x', 'http://local.test')).toBe('http://local.test/x');
    expect(checkedReturnTo(`/${'a'.repeat(2047)}`, ORIGIN)).toHaveLength(2048);
  });

  it.each([
    ['a number', 42],
    ['a long value', `/${'a'.repeat(2048)}`],
    ['a backslash', '/a\\b'],
    ['a control character', '/a\u0001'],
    ['a DEL character', '/a\u007f'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['another origin', 'https://evil.example/x'],
    ['user info', 'https://user:pw@id.example/x'],
    ['a username only', 'https://user@id.example/x'],
    ['not a URL', 'not a url'],
  ])('refuses %s', (_name, value) => {
    expect(checkedReturnTo(value, ORIGIN)).toBeUndefined();
  });
});

describe('LiteTxnEntrypoint context', () => {
  it('is unavailable without the transaction store', async () => {
    expect(await entry({ LITE_TXN_STORE: undefined }).get({ ...call, txnId: 't' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it.each([
    ['an origin with a path', `${ORIGIN}/`],
    ['a non-http origin', 'ftp://id.example'],
    ['not a URL', 'nope'],
    ['an unknown host', 'https://other.example'],
  ])('does not know the tenant of %s', async (_name, publicOrigin) => {
    expect(await entry().get({ ...call, publicOrigin, txnId: 't' })).toEqual({
      ok: false,
      reason: 'tenant_unknown',
    });
  });

  it('refuses when the policy cannot be told or the tenant is not lite', async () => {
    m.runtime.mockResolvedValueOnce('unknown');
    expect(await entry().get({ ...call, txnId: 't' })).toEqual({
      ok: false,
      reason: 'policy_unknown',
    });
    m.runtime.mockResolvedValueOnce('off');
    expect(await entry().get({ ...call, txnId: 't' })).toEqual({ ok: false, reason: 'not_lite' });
    m.current.mockRejectedValueOnce(new Error('do'));
    expect(await entry().get({ ...call, txnId: 't', current: true })).toEqual({
      ok: false,
      reason: 'policy_unknown',
    });
    m.current.mockResolvedValueOnce({ liteMode: 'off', policyRevision: 'r' });
    expect(await entry().get({ ...call, txnId: 't', current: true })).toEqual({
      ok: false,
      reason: 'not_lite',
    });
    expect(store.getTxnRpc).not.toHaveBeenCalled();
  });

  it('reads with the cached revision to show a page, and the current one before acting', async () => {
    await entry().get({ ...call, txnId: 't' });
    expect(store.getTxnRpc.mock.calls[0][0]).toMatchObject({
      txnId: 't',
      policyRevision: 'rev-cache',
    });
    await entry().get({ ...call, txnId: 't', current: true });
    expect(store.getTxnRpc.mock.calls[1][0]).toMatchObject({ policyRevision: 'rev-now' });
  });

  it('records an operation result with the current revision, or none for a tenant no longer lite', async () => {
    const complete = { ...call, txnId: 't', operationId: 'op', attempt: 1, result: {} };
    await entry().completeOperation(complete);
    expect(argOf(store.completeOperationRpc, 0, 0).policyRevision).toBe('rev-now');
    m.current.mockResolvedValueOnce({ liteMode: 'off', policyRevision: 'r' });
    await entry().completeOperation(complete);
    expect(argOf(store.completeOperationRpc, 1, 0).policyRevision).not.toBe('rev-cache');
    expect(store.completeOperationRpc).toHaveBeenCalledTimes(2);
  });
});

describe('LiteTxnEntrypoint create', () => {
  it('authorizes the caller before refusing an unsupported purpose', async () => {
    await expect(
      entry({}, { caller: 'someone' }).create({
        ...call,
        clientIp: null,
        purpose: 'other',
      } as never)
    ).rejects.toThrow('lite_txn_unauthorized');
    expect(await create({ purpose: 'other' })).toEqual({
      ok: false,
      reason: 'unsupported_purpose',
    });
  });

  it('is unavailable when the canonical issuer cannot be built', async () => {
    m.canonical.mockRejectedValueOnce(new Error('kv'));
    expect(await create()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('refuses a look-up without a reuse key', async () => {
    expect(await create({ reuseOnly: true })).toEqual({ ok: false, reason: 'unavailable' });
    expect(m.rate).not.toHaveBeenCalled();
  });

  it('is unavailable when the limiter fails', async () => {
    m.rate.mockRejectedValueOnce(new Error('do'));
    expect(await create()).toEqual({ ok: false, reason: 'unavailable' });
    expect(store.createTxnRpc).not.toHaveBeenCalled();
  });
});

describe('LiteTxnEntrypoint issueStartGrant', () => {
  const grant = (extra: Record<string, unknown> = {}) =>
    entry().issueStartGrant({ ...call, txnId: 't', provider: 'google', clientId: 'ui', ...extra });

  it('returns the refusal of the transaction read', async () => {
    store.getTxnRpc.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect(await grant()).toEqual({ ok: false, reason: 'not_found' });
  });

  it('starts a sign-in with no challenge without reading a challenge kind', async () => {
    expect(await grant()).toEqual({ ok: true, grantId: 'g' });
    expect(m.kind).not.toHaveBeenCalled();
    expect(m.verify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'login',
        alsoRequiredFor: ['signup'],
      })
    );
    expect(argOf(store.issueStartGrantRpc, 0, 0).start).toEqual({
      clientId: 'ui',
      interactionId: null,
      inviteToken: null,
    });
  });

  it('refuses a sign-in that answers a challenge which is not a login', async () => {
    store.getTxnRpc.mockResolvedValueOnce({
      ok: true,
      txn: { bound: { purpose: 'login', challengeId: 'ch' }, data: {} },
    });
    m.kind.mockResolvedValueOnce('reauth');
    expect(await grant()).toEqual({ ok: false, reason: 'unsupported_purpose' });
  });

  it.each([
    ['a missing client id', { clientId: '' }],
    ['a non-string client id', { clientId: 7 }],
    ['an empty interaction id', { interactionId: '' }],
    ['a non-string interaction id', { interactionId: 3 }],
  ])('refuses %s', async (_name, extra) => {
    expect(await grant(extra)).toEqual({ ok: false, reason: 'invalid_request' });
  });

  it('keeps a given interaction id', async () => {
    await grant({ interactionId: 'ix-1' });
    expect((argOf(store.issueStartGrantRpc, 0, 0).start as Rec).interactionId).toBe('ix-1');
  });

  it('treats a failing verification as not verified', async () => {
    m.verify.mockRejectedValueOnce(new Error('runner'));
    expect(await grant()).toEqual({ ok: false, reason: 'human_verification_failed' });
  });
});
