import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const fx = await vi.hoisted(async () => {
  const m = await import('./helpers/mut-admin-enrollment-fixture');
  return m.createEnrollmentFixture();
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => fx.adapter),
    AdminNoticeRepository: class {
      create = fx.noticeCreate;
    },
  };
});
vi.mock('@simplewebauthn/server', () => fx.webauthn);
vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', () => ({
  prepareLogIcebergRowWrite: fx.prepareLogIcebergRowWrite,
}));
vi.mock('../session-ttl', () => ({
  resolveSessionTtl: vi.fn(async () => ({ seconds: 3600, milliseconds: 3_600_000 })),
}));

import { adminInvitationEnrollmentApp } from '../admin-invitation-enrollment';
import { base64, sha256Hex } from './helpers/mut-admin-enrollment-fixture';

const TOKEN = 'enrollment-token-0002';
const ORIGIN = 'https://admin.example.com';
const env = { DB_ADMIN: {}, ADMIN_UI_URL: ORIGIN } as unknown as Env;

const registrationState = {
  invitationId: 'invitation_1',
  phase: 'registration',
  clientIp: '198.51.100.7',
  registration: {
    challengeId: 'challenge-1',
    challenge: 'reg-challenge',
    rpID: 'admin.example.com',
    origin: ORIGIN,
  },
};

const passkeyResponse = {
  id: 'credential-id',
  rawId: 'credential-id',
  response: {
    clientDataJSON: 'x',
    attestationObject: 'y',
    transports: ['internal', 'bogus', 'usb'],
  },
  type: 'public-key',
  clientExtensionResults: {},
};

async function register(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await adminInvitationEnrollmentApp.request(
    '/api/admin/invitations/passkey/register',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        enrollment_token: TOKEN,
        challenge_id: 'challenge-1',
        origin: ORIGIN,
        passkey_response: passkeyResponse,
        ...body,
      }),
    },
    env
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

interface StoredState {
  clientIp: string | null;
  authentication: Record<string, unknown>;
}

async function storedState(): Promise<StoredState> {
  return JSON.parse(fx.enrollments.get(await sha256Hex(TOKEN))!.state_json) as StoredState;
}

beforeEach(async () => {
  vi.clearAllMocks();
  fx.reset();
  await fx.seed(TOKEN, registrationState);
  fx.webauthn.generateAuthenticationOptions.mockResolvedValue({ challenge: 'auth-challenge' });
  fx.webauthn.verifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id: 'credential-id', publicKey: new Uint8Array([1, 2, 3]), counter: 4 },
      aaguid: 'aaguid-1',
    },
  });
});

describe('passkey registration', () => {
  it('rejects a malformed enrollment token', async () => {
    const result = await register({ enrollment_token: 'x' });
    expect(result).toEqual({ status: 401, body: { error: 'invalid_enrollment' } });
  });

  it('rejects an enrollment that is not in the registration phase', async () => {
    await fx.seed(TOKEN, { ...registrationState, phase: 'redeemed' });
    const result = await register({});
    expect(result).toEqual({ status: 401, body: { error: 'invalid_enrollment' } });
  });

  it('rejects a registration-phase enrollment without a stored challenge', async () => {
    await fx.seed(TOKEN, { invitationId: 'invitation_1', phase: 'registration', clientIp: null });
    const result = await register({});
    expect(result).toEqual({ status: 401, body: { error: 'invalid_enrollment' } });
  });

  it.each([
    ['a missing challenge id', { challenge_id: undefined }],
    ['an overlong challenge id', { challenge_id: 'c'.repeat(129) }],
    ['another challenge id', { challenge_id: 'challenge-2' }],
    ['a response without an id', { passkey_response: { response: {} } }],
    ['a response without a response object', { passkey_response: { id: 'credential-id' } }],
    ['an array response object', { passkey_response: { id: 'c', response: [] } }],
    ['a null passkey response', { passkey_response: null }],
    ['a missing origin', { origin: undefined }],
    ['an overlong origin', { origin: `https://${'a'.repeat(2050)}` }],
  ])('rejects %s with invalid_request', async (_label, body) => {
    const result = await register(body);
    expect(result).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect(fx.webauthn.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it.each([['not-a-url'], ['https://evil.example.net']])(
    'rejects origin %s that differs from the one the challenge was issued for',
    async (origin) => {
      const result = await register({ origin });
      expect(result).toEqual({ status: 400, body: { error: 'invalid_origin' } });
      expect(fx.webauthn.verifyRegistrationResponse).not.toHaveBeenCalled();
    }
  );

  it('re-checks the invitation before verifying', async () => {
    fx.state.invitation = { ...fx.state.invitation, expires_at: Date.now() - 1 };
    const result = await register({});
    expect(result).toEqual({ status: 401, body: { error: 'invitation_expired' } });
    expect(fx.webauthn.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('maps a verifier exception to passkey_registration_failed', async () => {
    fx.webauthn.verifyRegistrationResponse.mockRejectedValue(new Error('bad attestation'));
    const result = await register({});
    expect(result).toEqual({ status: 400, body: { error: 'passkey_registration_failed' } });
  });

  it.each([
    ['unverified', { verified: false, registrationInfo: {} }],
    ['missing registration info', { verified: true }],
  ])('maps an %s result to passkey_registration_failed', async (_label, verification) => {
    fx.webauthn.verifyRegistrationResponse.mockResolvedValue(verification);
    const result = await register({});
    expect(result).toEqual({ status: 400, body: { error: 'passkey_registration_failed' } });
    expect(fx.webauthn.generateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it.each([
    ['no credential id', { credential: { publicKey: new Uint8Array([1]) } }],
    ['no public key', { credential: { id: 'credential-id' } }],
  ])('fails with missing_credential_data on %s', async (_label, registrationInfo) => {
    fx.webauthn.verifyRegistrationResponse.mockResolvedValue({ verified: true, registrationInfo });
    const result = await register({});
    expect(result).toEqual({ status: 500, body: { error: 'missing_credential_data' } });
  });

  it('verifies against the stored challenge and moves to authentication', async () => {
    const result = await register({ origin: `${ORIGIN}/enroll?x=1` });
    expect(result.status).toBe(200);
    expect(result.body.options).toEqual({ challenge: 'auth-challenge' });
    expect(fx.webauthn.verifyRegistrationResponse).toHaveBeenCalledWith({
      response: passkeyResponse,
      expectedChallenge: 'reg-challenge',
      expectedOrigin: ORIGIN,
      expectedRPID: 'admin.example.com',
      requireUserVerification: true,
    });
    expect(fx.webauthn.generateAuthenticationOptions).toHaveBeenCalledWith({
      rpID: 'admin.example.com',
      userVerification: 'required',
      allowCredentials: [{ id: 'credential-id', transports: ['internal', 'usb'] }],
    });
    const stored = await storedState();
    expect(stored).toEqual({
      invitationId: 'invitation_1',
      phase: 'authentication',
      clientIp: null,
      authentication: {
        challengeId: result.body.challenge_id,
        challenge: 'auth-challenge',
        rpID: 'admin.example.com',
        origin: ORIGIN,
        credentialId: 'credential-id',
        publicKey: base64([1, 2, 3]),
        counter: 4,
        transports: ['internal', 'usb'],
        aaguid: 'aaguid-1',
      },
    });
  });

  it('accepts the legacy registration info shape and base64url-encodes binary ids', async () => {
    fx.webauthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: new Uint8Array([0xfb, 0xff, 0xfe]).buffer,
        credentialPublicKey: new Uint8Array([9, 8]),
        counter: 7,
      },
    });
    const result = await register(
      { passkey_response: { ...passkeyResponse, response: { clientDataJSON: 'x' } } },
      { 'cf-connecting-ip': '198.51.100.9' }
    );
    expect(result.status).toBe(200);
    const stored = await storedState();
    expect(stored.clientIp).toBe('198.51.100.9');
    expect(stored.authentication).toMatchObject({
      credentialId: '-__-',
      publicKey: base64([9, 8]),
      counter: 7,
      transports: [],
      aaguid: null,
    });
  });

  it('encodes a typed-array view and a padded string id, defaulting the counter to 0', async () => {
    const bytes = new Uint8Array([0, 0xfb, 0xef, 0xff, 0]);
    fx.webauthn.verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: { id: bytes.subarray(1, 4), publicKey: new Uint8Array([1]) },
      },
    });
    await register({});
    expect((await storedState()).authentication).toMatchObject({
      credentialId: '--__',
      counter: 0,
    });

    await fx.seed(TOKEN, registrationState);
    fx.webauthn.verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: { id: 'ab+/c=', publicKey: new Uint8Array([1]), counter: 2 },
      },
    });
    await register({});
    expect((await storedState()).authentication.credentialId).toBe('ab-_c');
  });

  it('refuses when the enrollment changed phase concurrently', async () => {
    fx.state.updateRowsAffected = 0;
    const result = await register({});
    expect(result).toEqual({ status: 401, body: { error: 'invalid_enrollment' } });
    const update = fx.adapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE admin_invitation_enrollments')
    );
    expect(update?.[1]?.[0]).toBe('authentication');
    expect(update?.[1]?.[4]).toBe('registration');
  });
});
