import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = await vi.hoisted(async () =>
  (await import('./helpers/mut-admin-setup-api-fixture')).createSetupApiFixture()
);

vi.mock('@simplewebauthn/server', () => fx.webauthn);
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  generateId: vi.fn(() => 'generated-id'),
  requireDedicatedAdminDatabaseAdapter: fx.requireAdapter,
  scheduleAdminAuthenticationAudit: fx.audit,
  AdminUserRepository: class {
    findById = fx.users.findById;
  },
  AdminPasskeyRepository: class {
    createPasskey = fx.passkeys.createPasskey;
    findByCredentialId = fx.passkeys.findByCredentialId;
    updateCounter = fx.passkeys.updateCounter;
  },
  AdminSessionRepository: class {
    createSession = fx.sessions.createSession;
    constructor(_adapter: unknown, tenantId: string) {
      fx.sessions.tenantIds.push(tenantId);
    }
  },
}));
vi.mock('../session-ttl', () => ({
  resolveSessionTtl: vi.fn(async () => ({ seconds: 1800, milliseconds: 1_800_000 })),
}));

import { adminSetupApiApp } from '../admin-setup-api';
import type { SetupApiKv } from './helpers/mut-admin-setup-api-fixture';
import { base64 } from './helpers/mut-admin-enrollment-fixture';

const ORIGIN = 'https://admin.example.com';
let kv: SetupApiKv;
const env = (overrides: Record<string, unknown> = {}) => ({
  DB_ADMIN: {},
  AUTHRIM_CONFIG: kv,
  ADMIN_UI_URL: ORIGIN,
  DEFAULT_TENANT_ID: 'tenant-home',
  ...overrides,
});

async function post(path: string, body: unknown, e = env(), headers: Record<string, string> = {}) {
  const response = await adminSetupApiApp.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    e
  );
  return {
    status: response.status,
    cookie: response.headers.get('set-cookie'),
    body: await response.json<Record<string, unknown>>(),
  };
}

const user = { id: 'admin-1', email: 'admin@example.com', name: 'Admin', email_verified: 1 };
const passkeyResponse = { id: 'cred', response: { transports: ['usb', 'smoke-signal', 'hybrid'] } };

beforeEach(() => {
  vi.clearAllMocks();
  fx.sessions.tenantIds.length = 0;
  kv = fx.createKv({
    'admin_setup:challenge:ch-1': JSON.stringify({
      challenge: 'reg-challenge',
      rpID: 'admin.example.com',
      origin: ORIGIN,
      userId: 'admin-1',
      token: 'setup-1',
    }),
    'admin_auth:challenge:ch-2': JSON.stringify({
      challenge: 'auth-challenge',
      rpID: 'admin.example.com',
      origin: ORIGIN,
    }),
  });
  fx.adapter.queryOne.mockResolvedValue({
    id: 'setup-1',
    admin_user_id: 'admin-1',
    status: 'pending',
    expires_at: Date.now() + 60_000,
  });
  fx.users.findById.mockResolvedValue(user);
  fx.webauthn.verifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id: 'ab+/cd==', publicKey: new Uint8Array([7, 8]), counter: 3 },
      aaguid: 'aa-1',
    },
  });
  fx.passkeys.findByCredentialId.mockResolvedValue({
    id: 'pk-1',
    admin_user_id: 'admin-1',
    credential_id: 'cred-stored',
    public_key: base64([1, 2]),
    counter: 5,
  });
  fx.webauthn.verifyAuthenticationResponse.mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 6 },
  });
  fx.webauthn.generateAuthenticationOptions.mockResolvedValue({ challenge: 'auth-challenge' });
});

describe('setup passkey completion', () => {
  const complete = (
    body: Record<string, unknown> = {},
    e = env(),
    headers: Record<string, string> = {}
  ) =>
    post(
      '/api/admin/setup-token/passkey/complete',
      {
        token: 'setup-1',
        challenge_id: 'ch-1',
        passkey_response: passkeyResponse,
        origin: ORIGIN,
        ...body,
      },
      e,
      headers
    );

  it.each([['token'], ['challenge_id'], ['passkey_response'], ['origin']])(
    'requires %s',
    async (field) => {
      expect(await complete({ [field]: undefined })).toMatchObject({
        status: 400,
        body: {
          error: 'invalid_request',
          error_description: 'token, challenge_id, passkey_response, and origin are required',
        },
      });
    }
  );

  it.each([[{ DB_ADMIN: undefined }], [{ AUTHRIM_CONFIG: undefined }]])(
    'requires storage %j',
    async (o) => {
      expect((await complete({}, env(o))).body).toEqual({
        error: 'server_error',
        error_description: 'Configuration not available',
      });
    }
  );

  it('rejects an unknown challenge', async () => {
    expect((await complete({ challenge_id: 'ch-x' })).body).toEqual({
      error: 'invalid_request',
      error_description: 'Challenge expired or not found',
    });
  });

  it('rejects a token other than the one the challenge was issued for', async () => {
    expect(await complete({ token: 'setup-2' })).toMatchObject({
      status: 401,
      body: { error: 'invalid_token', error_description: 'Token mismatch' },
    });
  });

  it.each([['https://evil.example.net'], ['not a url']])('rejects origin %s', async (origin) => {
    expect(await complete({ origin })).toMatchObject({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Origin mismatch' },
    });
  });

  it('rejects a legacy challenge without a stored origin', async () => {
    kv.values.set(
      'admin_setup:challenge:ch-1',
      JSON.stringify({ challenge: 'c', rpID: 'r', userId: 'u', token: 'setup-1' })
    );
    expect((await complete()).body).toMatchObject({ error_description: 'Origin mismatch' });
  });

  it.each([
    [null],
    [{ status: 'used', expires_at: Date.now() + 1000 }],
    [{ status: 'pending', expires_at: 1 }],
  ])('rejects token row %j', async (row) => {
    fx.adapter.queryOne.mockResolvedValue(row);
    expect(await complete()).toMatchObject({
      status: 401,
      body: { error: 'invalid_token', error_description: 'Invalid or expired token' },
    });
    expect(fx.webauthn.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it.each([
    [
      'throws',
      () => fx.webauthn.verifyRegistrationResponse.mockRejectedValue(new Error('x')),
      'Passkey verification failed',
    ],
    [
      'is unverified',
      () => fx.webauthn.verifyRegistrationResponse.mockResolvedValue({ verified: false }),
      'Passkey was not verified',
    ],
    [
      'lacks info',
      () => fx.webauthn.verifyRegistrationResponse.mockResolvedValue({ verified: true }),
      'Passkey was not verified',
    ],
  ])('discards the challenge when verification %s', async (_l, arrange, description) => {
    arrange();
    expect(await complete()).toMatchObject({
      status: 400,
      body: { error: 'verification_failed', error_description: description },
    });
    expect(kv.delete).toHaveBeenCalledWith('admin_setup:challenge:ch-1');
    expect(fx.passkeys.createPasskey).not.toHaveBeenCalled();
  });

  it('fails when credential data is missing', async () => {
    fx.webauthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: { credential: { id: 'x' } },
    });
    expect(await complete()).toMatchObject({
      status: 500,
      body: { error: 'server_error', error_description: 'Missing credential data' },
    });
  });

  it('stores the passkey, consumes the token and completes the admin', async () => {
    const result = await complete({ origin: `${ORIGIN}/setup` }, env(), {
      'x-forwarded-for': '198.51.100.3',
    });
    expect(result).toMatchObject({
      status: 200,
      body: { success: true, user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin' } },
    });
    expect(fx.webauthn.verifyRegistrationResponse.mock.calls[0][0]).toEqual({
      response: passkeyResponse,
      expectedChallenge: 'reg-challenge',
      expectedOrigin: ORIGIN,
      expectedRPID: 'admin.example.com',
      requireUserVerification: true,
    });
    expect(fx.passkeys.createPasskey).toHaveBeenCalledWith({
      admin_user_id: 'admin-1',
      credential_id: 'ab-_cd',
      public_key: base64([7, 8]),
      counter: 3,
      transports: ['usb', 'hybrid'],
      aaguid: 'aa-1',
      device_name: 'Admin UI Setup Passkey',
    });
    const [usedSql, usedParams] = fx.adapter.execute.mock.calls[0];
    expect(usedSql).toContain('UPDATE admin_setup_tokens');
    expect([usedParams![0], usedParams![2], usedParams![3]]).toEqual([
      'used',
      '198.51.100.3',
      'setup-1',
    ]);
    const [doneSql, doneParams] = fx.adapter.execute.mock.calls[1];
    expect(doneSql).toContain('passkey_setup_completed = 1');
    expect(doneParams![1]).toBe('admin-1');
    expect(kv.delete).toHaveBeenCalledWith('admin_setup:challenge:ch-1');
  });

  it('handles the legacy registration shape and binary credential ids', async () => {
    fx.users.findById.mockResolvedValue({ ...user, name: '' });
    fx.webauthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: new Uint8Array([0xfb, 0xff]),
        credentialPublicKey: new Uint8Array([1]),
      },
    });
    const result = await complete({ passkey_response: { id: 'cred', response: {} } }, env(), {
      'cf-connecting-ip': '203.0.113.1',
    });
    expect(result.body).toMatchObject({ user: { name: null } });
    expect(fx.passkeys.createPasskey.mock.calls[0][0]).toMatchObject({
      credential_id: '-_8',
      counter: 0,
      transports: [],
      aaguid: undefined,
    });
    expect(fx.adapter.execute.mock.calls[0][1]![2]).toBe('203.0.113.1');
  });

  it('keeps a non-base64 string credential id and records no IP', async () => {
    fx.webauthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: { credential: { id: 'already_url-safe', publicKey: new Uint8Array([1]) } },
    });
    await complete();
    expect(fx.passkeys.createPasskey.mock.calls[0][0].credential_id).toBe('already_url-safe');
    expect(fx.adapter.execute.mock.calls[0][1]![2]).toBeNull();
  });

  it('hides unexpected storage failures', async () => {
    fx.passkeys.createPasskey.mockRejectedValue(new Error('db'));
    expect(await complete()).toMatchObject({
      status: 500,
      body: { error: 'server_error', error_description: 'Registration failed' },
    });
  });
});

describe('admin passkey login', () => {
  const verify = (
    body: Record<string, unknown> = {},
    e = env(),
    headers: Record<string, string> = {}
  ) =>
    post(
      '/api/admin/auth/passkey/verify',
      { challengeId: 'ch-2', credential: { id: 'cred+/==' }, ...body },
      e,
      headers
    );

  it('requires an allowed origin for options', async () => {
    expect(
      await post('/api/admin/auth/passkey/options', {}, env(), {
        origin: 'https://evil.example.net',
      })
    ).toMatchObject({
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: 'Admin WebAuthn Origin header is missing or not allowed',
      },
    });
  });

  it('issues discoverable options with hints and a five-minute challenge', async () => {
    const result = await post('/api/admin/auth/passkey/options', {}, env(), { origin: ORIGIN });
    expect(result.body).toEqual({
      options: { challenge: 'auth-challenge', hints: ['hybrid', 'client-device', 'security-key'] },
      challengeId: 'generated-id',
    });
    expect(fx.webauthn.generateAuthenticationOptions).toHaveBeenCalledWith({
      rpID: 'admin.example.com',
      userVerification: 'required',
      allowCredentials: [],
    });
    expect(kv.put).toHaveBeenCalledWith(
      'admin_auth:challenge:generated-id',
      JSON.stringify({ challenge: 'auth-challenge', rpID: 'admin.example.com', origin: ORIGIN }),
      { expirationTtl: 300 }
    );
    const noKv = await post(
      '/api/admin/auth/passkey/options',
      {},
      env({ AUTHRIM_CONFIG: undefined }),
      { origin: ORIGIN }
    );
    expect(noKv.status).toBe(200);
    fx.webauthn.generateAuthenticationOptions.mockRejectedValue(new Error('x'));
    expect(
      (await post('/api/admin/auth/passkey/options', {}, env(), { origin: ORIGIN })).body
    ).toEqual({
      error: 'server_error',
      error_description: 'Failed to generate options',
    });
  });

  it.each([[{ challengeId: '' }], [{ credential: null }]])(
    'requires challengeId and credential %j',
    async (body) => {
      expect(await verify(body)).toMatchObject({
        status: 400,
        body: {
          error: 'invalid_request',
          error_description: 'challengeId and credential required',
        },
      });
    }
  );

  it.each([[{ DB_ADMIN: undefined }], [{ AUTHRIM_CONFIG: undefined }]])(
    'requires storage %j',
    async (o) => {
      expect((await verify({}, env(o))).body).toEqual({
        error: 'server_error',
        error_description: 'Configuration not available',
      });
    }
  );

  it('rejects an expired challenge', async () => {
    expect((await verify({ challengeId: 'ch-x' })).body).toEqual({
      error: 'invalid_request',
      error_description: 'Challenge expired',
    });
  });

  it.each([
    [
      'an unknown passkey',
      () => fx.passkeys.findByCredentialId.mockResolvedValue(null),
      'Passkey not found',
    ],
    ['a deleted admin', () => fx.users.findById.mockResolvedValue(null), 'Admin user not found'],
  ])('refuses %s and burns the challenge', async (_l, arrange, description) => {
    arrange();
    expect(await verify()).toMatchObject({
      status: 401,
      body: { error: 'auth_failed', error_description: description },
    });
    expect(kv.delete).toHaveBeenCalledWith('admin_auth:challenge:ch-2');
    expect(fx.audit).not.toHaveBeenCalled();
  });

  it.each([
    [
      'throws',
      () => fx.webauthn.verifyAuthenticationResponse.mockRejectedValue(new Error('x')),
      'Passkey verification failed',
      'passkey_verification_failed',
    ],
    [
      'is unverified',
      () => fx.webauthn.verifyAuthenticationResponse.mockResolvedValue({ verified: false }),
      'Passkey not verified',
      'passkey_not_verified',
    ],
  ])('audits a failed login when verification %s', async (_l, arrange, description, reason) => {
    arrange();
    expect(await verify()).toMatchObject({
      status: 401,
      body: { error: 'auth_failed', error_description: description },
    });
    expect(fx.audit).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-home',
      action: 'admin.login_failed',
      method: 'passkey',
      adminUserId: 'admin-1',
      reason,
    });
    expect(kv.delete).toHaveBeenCalledWith('admin_auth:challenge:ch-2');
    expect(fx.passkeys.updateCounter).not.toHaveBeenCalled();
  });

  it('reports a session write failure without a cookie', async () => {
    fx.sessions.createSession.mockRejectedValueOnce(new Error('db'));
    const result = await verify();
    expect(result).toMatchObject({
      status: 500,
      body: { error: 'server_error', error_description: 'Failed to create session' },
    });
    expect(result.cookie).toBeNull();
    expect(kv.delete).toHaveBeenCalledWith('admin_auth:challenge:ch-2');
  });

  it('creates an MFA-verified session from a verified assertion', async () => {
    const before = Date.now();
    const result = await verify({}, env(), {
      'x-forwarded-for': '198.51.100.8',
      'user-agent': 'UA/2',
    });
    expect(result.body).toEqual({
      verified: true,
      userId: 'admin-1',
      user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin', email_verified: 1 },
    });
    expect(fx.passkeys.findByCredentialId).toHaveBeenCalledWith('cred-_');
    const args = fx.webauthn.verifyAuthenticationResponse.mock.calls[0][0];
    expect(args).toMatchObject({
      expectedChallenge: 'auth-challenge',
      expectedOrigin: ORIGIN,
      expectedRPID: 'admin.example.com',
      credential: { id: 'cred-stored', counter: 5 },
      requireUserVerification: true,
    });
    expect(Array.from(args.credential?.publicKey ?? [])).toEqual([1, 2]);
    expect(fx.passkeys.updateCounter).toHaveBeenCalledWith('pk-1', 6);
    const session = fx.sessions.createSession.mock.calls[0][0];
    expect(session).toMatchObject({
      id: 'generated-id',
      tenant_id: 'tenant-home',
      admin_user_id: 'admin-1',
      ip_address: '198.51.100.8',
      user_agent: 'UA/2',
      mfa_verified: true,
      passkey_credential_id: 'cred-stored',
    });
    expect(Number(session.expires_at) - before).toBeGreaterThanOrEqual(1_800_000);
    expect(fx.sessions.tenantIds).toEqual(['tenant-home']);
    expect(result.cookie).toContain('authrim_admin_session=generated-id');
    expect(result.cookie).toMatch(/Max-Age=1800/);
    expect(result.cookie).toMatch(/HttpOnly/);
    expect(result.cookie).toMatch(/Secure/);
    expect(fx.audit).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-home',
      action: 'admin.login',
      method: 'passkey',
      adminUserId: 'admin-1',
      sessionId: 'generated-id',
    });
    expect(kv.values.has('admin_auth:challenge:ch-2')).toBe(false);
  });

  it('prefers the Cloudflare IP, omits absent headers and hides late failures', async () => {
    fx.users.findById.mockResolvedValue({ ...user, name: '' });
    const result = await verify({}, env(), {
      'cf-connecting-ip': '203.0.113.2',
      'x-forwarded-for': '198.51.100.8',
    });
    expect((result.body.user as Record<string, unknown>).name).toBeNull();
    expect(fx.sessions.createSession.mock.calls[0][0]).toMatchObject({
      ip_address: '203.0.113.2',
      user_agent: undefined,
    });
    const challenge = JSON.stringify({
      challenge: 'auth-challenge',
      rpID: 'admin.example.com',
      origin: ORIGIN,
    });
    kv.values.set('admin_auth:challenge:ch-2', challenge);
    await verify();
    expect(fx.sessions.createSession.mock.calls[1][0].ip_address).toBeUndefined();
    kv.values.set('admin_auth:challenge:ch-2', challenge);
    fx.passkeys.updateCounter.mockRejectedValue(new Error('db'));
    expect((await verify()).body).toEqual({
      error: 'server_error',
      error_description: 'Login verification failed',
    });
  });
});
