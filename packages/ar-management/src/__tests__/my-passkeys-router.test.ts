import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  getPasskeysByUser: vi.fn(),
  credentialExists: vi.fn(),
  createPasskey: vi.fn(),
  getPasskey: vi.fn(),
  updateDeviceName: vi.fn(),
  deletePasskeyIfUserHasAnother: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  writeAdminAuditLog: vi.fn(),
  generateId: vi.fn(() => 'challenge-id'),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mocks.generateRegistrationOptions,
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
}));

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  class MockAdminPasskeyRepository {
    getPasskeysByUser = mocks.getPasskeysByUser;
    credentialExists = mocks.credentialExists;
    createPasskey = mocks.createPasskey;
    getPasskey = mocks.getPasskey;
    updateDeviceName = mocks.updateDeviceName;
    deletePasskeyIfUserHasAnother = mocks.deletePasskeyIfUserHasAnother;
  }
  const status: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    AdminPasskeyRepository: MockAdminPasskeyRepository,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    generateId: mocks.generateId,
    adminAuthMiddleware:
      () =>
      async (
        c: { req: { header: (name: string) => string | undefined }; set: Function },
        next: () => Promise<void>
      ) => {
        c.set('adminAuth', {
          userId: c.req.header('x-test-user-id') ?? 'admin-1',
          email: c.req.header('x-test-email') ?? 'admin@example.com',
        });
        c.set('tenantId', 'tenant-1');
        await next();
      },
    createErrorResponse: vi.fn((c: { json: Function }, code: string) =>
      c.json({ error: 'error', error_code: code }, status[code] ?? 500)
    ),
  };
});

import { myPasskeysRouter } from '../routes/admin-management/my-passkeys';

function passkey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'passkey-1',
    admin_user_id: 'admin-1',
    credential_id: 'credential-1',
    public_key: 'secret-public-key',
    counter: 0,
    transports: ['internal'],
    device_name: 'MacBook',
    aaguid: null,
    created_at: 100,
    last_used_at: null,
    ...overrides,
  };
}

function createApp(config = true) {
  const kv = config ? { get: vi.fn(), put: vi.fn(), delete: vi.fn() } : undefined;
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/me/passkeys', myPasskeysRouter);
  return {
    app,
    kv,
    env: {
      AUTHRIM_CONFIG: kv,
      ADMIN_UI_URL: 'https://admin.example.com',
    } as unknown as Env,
  };
}

function registrationResponse() {
  return {
    id: 'credential',
    rawId: 'credential',
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'client-data',
      attestationObject: 'attestation',
      transports: ['internal', 'invalid-transport'],
    },
  };
}

describe('myPasskeysRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPasskeysByUser.mockResolvedValue([]);
    mocks.credentialExists.mockResolvedValue(false);
  });

  it('lists only sanitized passkey metadata for the current admin', async () => {
    mocks.getPasskeysByUser.mockResolvedValue([passkey()]);
    const { app, env } = createApp();

    const response = await app.request('/api/admin/me/passkeys', {}, env);
    const body = (await response.json()) as { passkeys: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(mocks.getPasskeysByUser).toHaveBeenCalledWith('admin-1');
    expect(body.passkeys[0]).not.toHaveProperty('credential_id');
    expect(body.passkeys[0]).not.toHaveProperty('public_key');
  });

  it.each([
    ['missing RP ID', {}, true, 400],
    ['missing challenge store', { rp_id: 'admin.example.com' }, false, 500],
    ['origin/RP mismatch', { rp_id: 'evil.example.com' }, true, 400],
  ])('rejects registration options for %s', async (_label, body, config, status) => {
    const { app, env } = createApp(config);
    const response = await app.request(
      '/api/admin/me/passkeys/options',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://admin.example.com' },
        body: JSON.stringify(body),
      },
      env
    );

    expect(response.status).toBe(status);
    expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('creates origin-bound registration options and excludes existing credentials', async () => {
    mocks.getPasskeysByUser.mockResolvedValue([passkey()]);
    mocks.generateRegistrationOptions.mockResolvedValue({ challenge: 'webauthn-challenge' });
    const { app, env, kv } = createApp();

    const response = await app.request(
      '/api/admin/me/passkeys/options',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://admin.example.com' },
        body: JSON.stringify({ rp_id: 'admin.example.com', device_name: 'Security key' }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'admin.example.com',
        userName: 'admin@example.com',
        excludeCredentials: [expect.objectContaining({ id: 'credential-1' })],
      })
    );
    expect(kv?.put).toHaveBeenCalledWith(
      'admin_passkey:challenge:challenge-id',
      expect.stringContaining('https://admin.example.com'),
      { expirationTtl: 300 }
    );
  });

  it.each([
    ['missing request fields', {}, null, 400],
    [
      'expired challenge',
      {
        challenge_id: 'missing',
        passkey_response: registrationResponse(),
        origin: 'https://admin.example.com',
      },
      null,
      400,
    ],
    [
      'challenge owned by another admin',
      {
        challenge_id: 'c',
        passkey_response: registrationResponse(),
        origin: 'https://admin.example.com',
      },
      {
        challenge: 'x',
        rpID: 'admin.example.com',
        origin: 'https://admin.example.com',
        userId: 'other',
        deviceName: null,
      },
      401,
    ],
    [
      'origin mismatch',
      {
        challenge_id: 'c',
        passkey_response: registrationResponse(),
        origin: 'https://evil.example.com',
      },
      {
        challenge: 'x',
        rpID: 'admin.example.com',
        origin: 'https://admin.example.com',
        userId: 'admin-1',
        deviceName: null,
      },
      400,
    ],
  ])('rejects registration completion for %s', async (_label, body, stored, status) => {
    const { app, env, kv } = createApp();
    kv?.get.mockResolvedValue(stored ? JSON.stringify(stored) : null);

    const response = await app.request(
      '/api/admin/me/passkeys/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env
    );

    expect(response.status).toBe(status);
    expect(mocks.createPasskey).not.toHaveBeenCalled();
  });

  it('rejects failed WebAuthn verification and consumes the challenge', async () => {
    const { app, env, kv } = createApp();
    kv?.get.mockResolvedValue(
      JSON.stringify({
        challenge: 'x',
        rpID: 'admin.example.com',
        origin: 'https://admin.example.com',
        userId: 'admin-1',
        deviceName: null,
      })
    );
    mocks.verifyRegistrationResponse.mockRejectedValue(new Error('bad attestation'));

    const response = await app.request(
      '/api/admin/me/passkeys/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: 'c',
          passkey_response: registrationResponse(),
          origin: 'https://admin.example.com',
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(kv?.delete).toHaveBeenCalledWith('admin_passkey:challenge:c');
  });

  it('registers a verified unique credential, filters transports, audits, and consumes challenge', async () => {
    const { app, env, kv } = createApp();
    kv?.get.mockResolvedValue(
      JSON.stringify({
        challenge: 'x',
        rpID: 'admin.example.com',
        origin: 'https://admin.example.com',
        userId: 'admin-1',
        deviceName: 'Stored name',
      })
    );
    mocks.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: 'Y3JlZGVudGlhbA', publicKey: new Uint8Array([1, 2]), counter: 3 },
        attestationObject: new Uint8Array([3]),
        aaguid: 'aaguid',
      },
    });
    mocks.createPasskey.mockResolvedValue(passkey({ device_name: 'Request name' }));

    const response = await app.request(
      '/api/admin/me/passkeys/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: 'c',
          passkey_response: registrationResponse(),
          origin: 'https://admin.example.com',
          device_name: 'Request name',
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(mocks.createPasskey).toHaveBeenCalledWith(
      expect.objectContaining({
        admin_user_id: 'admin-1',
        counter: 3,
        transports: ['internal'],
        device_name: 'Request name',
      })
    );
    expect(kv?.delete).toHaveBeenCalledWith('admin_passkey:challenge:c');
    expect(mocks.writeAdminAuditLog).toHaveBeenCalled();
  });

  it.each([
    ['unverified response', { verified: false, registrationInfo: null }, false, 400],
    [
      'missing credential material',
      { verified: true, registrationInfo: { credential: {}, counter: 0 } },
      false,
      400,
    ],
    [
      'already registered credential',
      {
        verified: true,
        registrationInfo: {
          credentialID: new Uint8Array([1, 2]).buffer,
          credentialPublicKey: new Uint8Array([3, 4]),
          counter: 0,
        },
      },
      true,
      409,
    ],
  ])('rejects a %s after consuming its challenge', async (_label, verification, exists, status) => {
    const { app, env, kv } = createApp();
    kv?.get.mockResolvedValue(
      JSON.stringify({
        challenge: 'x',
        rpID: 'admin.example.com',
        origin: 'https://admin.example.com',
        userId: 'admin-1',
        deviceName: null,
      })
    );
    mocks.verifyRegistrationResponse.mockResolvedValue(verification);
    mocks.credentialExists.mockResolvedValue(exists);

    const response = await app.request(
      '/api/admin/me/passkeys/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: 'c',
          passkey_response: registrationResponse(),
          origin: 'https://admin.example.com',
        }),
      },
      env
    );

    expect(response.status).toBe(status);
    expect(kv?.delete).toHaveBeenCalledWith('admin_passkey:challenge:c');
    expect(mocks.createPasskey).not.toHaveBeenCalled();
  });

  it.each([
    ['missing name', {}, null, 400],
    ['name over 100 characters', { device_name: 'x'.repeat(101) }, null, 400],
    ['unknown passkey', { device_name: 'New' }, null, 404],
    ['another admin passkey', { device_name: 'New' }, passkey({ admin_user_id: 'other' }), 403],
  ])('rejects rename for %s', async (_label, body, stored, status) => {
    mocks.getPasskey.mockResolvedValue(stored);
    const { app, env } = createApp();
    const response = await app.request(
      '/api/admin/me/passkeys/passkey-1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env
    );

    expect(response.status).toBe(status);
    expect(mocks.updateDeviceName).not.toHaveBeenCalled();
  });

  it('renames only the current admin passkey and audits old and new names', async () => {
    mocks.getPasskey.mockResolvedValue(passkey());
    const { app, env } = createApp();
    const response = await app.request(
      '/api/admin/me/passkeys/passkey-1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_name: 'New name' }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(mocks.updateDeviceName).toHaveBeenCalledWith('passkey-1', 'New name');
    expect(mocks.writeAdminAuditLog).toHaveBeenCalled();
  });

  it.each([
    ['unknown passkey', null, true, 404],
    ['another admin passkey', passkey({ admin_user_id: 'other' }), true, 403],
    ['last remaining passkey', passkey(), false, 400],
  ])('rejects deletion of %s', async (_label, stored, deleted, status) => {
    mocks.getPasskey.mockResolvedValue(stored);
    mocks.deletePasskeyIfUserHasAnother.mockResolvedValue(deleted);
    const { app, env } = createApp();
    const response = await app.request(
      '/api/admin/me/passkeys/passkey-1',
      { method: 'DELETE' },
      env
    );

    expect(response.status).toBe(status);
  });

  it('deletes an owned passkey only when another remains and audits the deletion', async () => {
    mocks.getPasskey.mockResolvedValue(passkey());
    mocks.deletePasskeyIfUserHasAnother.mockResolvedValue(true);
    const { app, env } = createApp();

    const response = await app.request(
      '/api/admin/me/passkeys/passkey-1',
      { method: 'DELETE' },
      env
    );

    expect(response.status).toBe(200);
    expect(mocks.deletePasskeyIfUserHasAnother).toHaveBeenCalledWith('passkey-1', 'admin-1');
    expect(mocks.writeAdminAuditLog).toHaveBeenCalled();
  });
});
