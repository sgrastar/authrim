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
    getPasskeysByUser = fx.passkeys.getPasskeysByUser;
    findByCredentialId = fx.passkeys.findByCredentialId;
    updateCounter = fx.passkeys.updateCounter;
  },
}));

import { adminSetupApiApp } from '../admin-setup-api';
import type { SetupApiKv } from './helpers/mut-admin-setup-api-fixture';

const ORIGIN = 'https://admin.example.com';
let kv: SetupApiKv;

function env(overrides: Record<string, unknown> = {}) {
  return { DB_ADMIN: {}, AUTHRIM_CONFIG: kv, ADMIN_UI_URL: ORIGIN, ...overrides };
}

async function post(
  path: string,
  body: unknown,
  e: Record<string, unknown> = env(),
  headers: Record<string, string> = {}
) {
  const response = await adminSetupApiApp.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    e
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const pendingToken = () => ({
  id: 'setup-1',
  admin_user_id: 'admin-1',
  status: 'pending',
  expires_at: Date.now() + 60_000,
});
const user = { id: 'admin-1', email: 'admin@example.com', name: 'Admin' };

beforeEach(() => {
  vi.clearAllMocks();
  kv = fx.createKv();
  fx.adapter.queryOne.mockResolvedValue(pendingToken());
  fx.users.findById.mockResolvedValue(user);
  fx.passkeys.getPasskeysByUser.mockResolvedValue([]);
  fx.webauthn.generateRegistrationOptions.mockResolvedValue({ challenge: 'reg-challenge' });
});

describe('setup token verification', () => {
  const verify = (body: unknown, e?: Record<string, unknown>) =>
    post('/api/admin/setup-token/verify', body, e);

  it('requires a token', async () => {
    expect(await verify({})).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'token is required' },
    });
  });

  it('hides a malformed body behind server_error', async () => {
    expect(await verify('not-json')).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Verification failed' },
    });
  });

  it('requires the admin database', async () => {
    expect(await verify({ token: 't' }, env({ DB_ADMIN: undefined }))).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Admin database not configured' },
    });
  });

  it.each([
    [null, 401, 'invalid_token', 'Setup token not found'],
    [{ ...pendingToken(), status: 'used' }, 401, 'token_used', 'Setup token has already been used'],
    [
      { ...pendingToken(), expires_at: Date.now() - 1 },
      401,
      'token_expired',
      'Setup token has expired',
    ],
  ])('rejects token row %j', async (row, status, error, description) => {
    fx.adapter.queryOne.mockResolvedValue(row);
    expect(await verify({ token: 'setup-1' })).toEqual({
      status,
      body: { error, error_description: description },
    });
  });

  it('reports a missing admin user', async () => {
    fx.users.findById.mockResolvedValue(null);
    expect(await verify({ token: 'setup-1' })).toEqual({
      status: 404,
      body: { error: 'user_not_found', error_description: 'Admin user not found' },
    });
  });

  it('returns the admin for a pending token', async () => {
    fx.users.findById.mockResolvedValue({ ...user, name: '' });
    expect(await verify({ token: 'setup-1' })).toEqual({
      status: 200,
      body: { valid: true, user: { id: 'admin-1', email: 'admin@example.com', name: null } },
    });
    expect(fx.adapter.queryOne.mock.calls[0][1]).toEqual(['setup-1']);
    expect(fx.users.findById).toHaveBeenCalledWith('admin-1');
    expect(fx.requireAdapter.mock.calls[0][1]).toBe('admin-setup-api');
  });
});

describe('setup passkey options', () => {
  const options = (body: unknown, e?: Record<string, unknown>, headers = { origin: ORIGIN }) =>
    post('/api/admin/setup-token/passkey/options', body, e, headers);
  const valid = { token: 'setup-1', rp_id: 'admin.example.com' };

  it.each([[{ token: 'setup-1' }], [{ rp_id: 'admin.example.com' }]])(
    'requires token and rp_id %j',
    async (body) => {
      expect(await options(body)).toEqual({
        status: 400,
        body: { error: 'invalid_request', error_description: 'token and rp_id are required' },
      });
    }
  );

  it.each([
    [{ DB_ADMIN: undefined }, 'Admin database not configured'],
    [{ AUTHRIM_CONFIG: undefined }, 'Challenge storage not configured'],
  ])('requires storage %j', async (overrides, description) => {
    expect(await options(valid, env(overrides))).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: description },
    });
  });

  it.each([
    ['a foreign origin', { origin: 'https://evil.example.net' }, valid],
    ['a mismatching rp_id', { origin: ORIGIN }, { ...valid, rp_id: 'example.net' }],
  ])('refuses %s', async (_label, headers, body) => {
    expect(await options(body, env(), headers)).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Admin WebAuthn origin is not allowed' },
    });
    expect(fx.adapter.queryOne).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [{ ...pendingToken(), status: 'used' }],
    [{ ...pendingToken(), expires_at: Date.now() - 1 }],
  ])('refuses token row %j', async (row) => {
    fx.adapter.queryOne.mockResolvedValue(row);
    expect(await options(valid)).toEqual({
      status: 401,
      body: { error: 'invalid_token', error_description: 'Invalid or expired token' },
    });
  });

  it('reports a missing admin user', async () => {
    fx.users.findById.mockResolvedValue(null);
    expect((await options(valid)).body).toEqual({
      error: 'user_not_found',
      error_description: 'Admin user not found',
    });
  });

  it('stores a five-minute challenge bound to the token, user and origin', async () => {
    fx.users.findById.mockResolvedValue({ ...user, name: null });
    const result = await options(valid);
    expect(result).toEqual({
      status: 200,
      body: { options: { challenge: 'reg-challenge' }, challenge_id: 'generated-id' },
    });
    const args = fx.webauthn.generateRegistrationOptions.mock.calls[0][0];
    expect(args).toMatchObject({
      rpName: 'Authrim Admin',
      rpID: 'admin.example.com',
      userName: 'admin@example.com',
      userDisplayName: 'admin@example.com',
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 60000,
    });
    expect(new TextDecoder().decode(args.userID)).toBe('admin-1');
    const [key, value, opts] = kv.put.mock.calls[0];
    expect(key).toBe('admin_setup:challenge:generated-id');
    expect(JSON.parse(value)).toEqual({
      challenge: 'reg-challenge',
      rpID: 'admin.example.com',
      origin: ORIGIN,
      userId: 'admin-1',
      token: 'setup-1',
    });
    expect(opts).toEqual({ expirationTtl: 300 });
  });

  it('uses the admin name for display and hides generator failures', async () => {
    await options(valid);
    expect(fx.webauthn.generateRegistrationOptions.mock.calls[0][0].userDisplayName).toBe('Admin');
    fx.webauthn.generateRegistrationOptions.mockRejectedValue(new Error('x'));
    expect(await options(valid)).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Failed to generate options' },
    });
  });
});

describe('recovery setup token generation', () => {
  const generate = (body: unknown, e?: Record<string, unknown>) =>
    post('/api/admin/setup-token/generate', body, e);

  beforeEach(() => {
    kv.values.set('setup:recovery_key', 'recovery-secret');
  });

  it('requires admin_user_id', async () => {
    expect(await generate({ recovery_key: 'recovery-secret' })).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'admin_user_id is required' },
    });
  });

  it('requires the admin database', async () => {
    expect(
      (await generate({ admin_user_id: 'admin-1' }, env({ DB_ADMIN: undefined }))).body
    ).toEqual({
      error: 'server_error',
      error_description: 'Admin database not configured',
    });
  });

  it('fails closed without the KV store', async () => {
    expect(
      await generate(
        { admin_user_id: 'admin-1', recovery_key: 'x' },
        env({ AUTHRIM_CONFIG: undefined })
      )
    ).toEqual({
      status: 401,
      body: { error: 'unauthorized', error_description: 'Recovery key required' },
    });
  });

  it.each([
    ['a missing key', undefined, true],
    ['a wrong key', 'recovery-secreT', true],
    ['no stored key', 'recovery-secret', false],
  ])('refuses %s', async (_label, recoveryKey, stored) => {
    if (!stored) kv.values.delete('setup:recovery_key');
    expect(await generate({ admin_user_id: 'admin-1', recovery_key: recoveryKey })).toEqual({
      status: 401,
      body: { error: 'unauthorized', error_description: 'Invalid recovery key' },
    });
    expect(fx.users.findById).not.toHaveBeenCalled();
  });

  it('reports a missing admin and an existing passkey', async () => {
    const body = { admin_user_id: 'admin-1', recovery_key: 'recovery-secret' };
    fx.users.findById.mockResolvedValueOnce(null);
    expect(await generate(body)).toEqual({
      status: 404,
      body: { error: 'user_not_found', error_description: 'Admin user not found' },
    });
    fx.passkeys.getPasskeysByUser.mockResolvedValueOnce([{ id: 'pk' }]);
    expect(await generate(body)).toEqual({
      status: 409,
      body: {
        error: 'already_setup',
        error_description: 'Passkey already registered for this user',
      },
    });
    expect(fx.adapter.execute).not.toHaveBeenCalled();
  });

  it('revokes pending tokens and issues a 24-hour CLI token in the default tenant', async () => {
    const result = await generate(
      { admin_user_id: 'admin-1', recovery_key: 'recovery-secret' },
      env({ DEFAULT_TENANT_ID: 'tenant-home' })
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      token: 'generated-id',
      admin_user: { id: 'admin-1', email: 'admin@example.com' },
    });
    const [revokeSql, revokeParams] = fx.adapter.execute.mock.calls[0];
    expect(revokeSql).toContain("SET status = 'revoked'");
    expect(revokeParams).toEqual(['admin-1']);
    const [insertSql, insertParams] = fx.adapter.execute.mock.calls[1];
    expect(insertSql).toContain("'cli'");
    expect(insertParams!.slice(0, 3)).toEqual(['generated-id', 'tenant-home', 'admin-1']);
    expect(Number(insertParams![3]) - Number(insertParams![4])).toBe(86_400_000);
    expect(result.body.expires_at).toBe(insertParams![3]);
    expect(fx.passkeys.getPasskeysByUser).toHaveBeenCalledWith('admin-1');
  });

  it('hides storage failures', async () => {
    fx.adapter.execute.mockRejectedValueOnce(new Error('db'));
    expect(await generate({ admin_user_id: 'admin-1', recovery_key: 'recovery-secret' })).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Token generation failed' },
    });
  });
});
