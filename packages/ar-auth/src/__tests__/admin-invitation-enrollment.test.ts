import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const { adapter, enrollments, webauthn } = vi.hoisted(() => ({
  adapter: {
    queryOne: vi.fn(),
    execute: vi.fn(),
    batch: vi.fn<(statements: Array<{ sql: string; params?: unknown[] }>) => Promise<unknown[]>>(),
  },
  enrollments: new Map<string, { phase: string; state_json: string; expires_at: number }>(),
  webauthn: {
    generateRegistrationOptions: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => adapter),
  };
});

vi.mock('@simplewebauthn/server', () => webauthn);

vi.mock('../session-ttl', () => ({
  resolveSessionTtl: vi.fn(async () => ({ seconds: 3600, milliseconds: 3_600_000 })),
}));

import { adminInvitationEnrollmentApp } from '../admin-invitation-enrollment';

const invitation = {
  id: 'invitation_1',
  tenant_id: 'tenant_123',
  admin_user_id: 'admin_new',
  email: 'new-admin@example.com',
  name: 'New Admin',
  status: 'pending',
  admin_role_id: 'role_admin',
  role_name: 'admin',
  role_display_name: 'Administrator',
  scope_type: 'tenant',
  scope_id: 'tenant_123',
  role_expires_at: null,
  ip_restriction_enabled: 1,
  allowed_ip_ranges_json: JSON.stringify(['203.0.113.0/24']),
  expires_at: Date.now() + 60_000,
  created_by: 'admin_actor',
};

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function seedEnrollment(token: string, state: object): Promise<void> {
  enrollments.set(await hashToken(token), {
    phase: String((state as { phase: string }).phase),
    state_json: JSON.stringify(state),
    expires_at: Date.now() + 600_000,
  });
}

function createEnv() {
  return {
    DB_ADMIN: {},
    ADMIN_UI_URL: 'https://admin.example.com',
  } as unknown as Env;
}

describe('Admin invitation enrollment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrollments.clear();
    adapter.queryOne.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM admin_invitation_enrollments')) {
        const enrollment = enrollments.get(String(params[0]));
        return enrollment && enrollment.expires_at > Number(params[1])
          ? { state_json: enrollment.state_json }
          : null;
      }
      return invitation;
    });
    adapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('DELETE FROM admin_invitation_enrollments WHERE expires_at')) {
        const cutoff = Number(params[0]);
        for (const [key, enrollment] of enrollments) {
          if (enrollment.expires_at <= cutoff) enrollments.delete(key);
        }
        return { rowsAffected: 0 };
      }
      if (sql.includes('INSERT INTO admin_invitation_enrollments')) {
        enrollments.set(String(params[0]), {
          phase: String(params[2]),
          state_json: String(params[3]),
          expires_at: Number(params[4]),
        });
        return { rowsAffected: 1 };
      }
      if (sql.includes('UPDATE admin_invitation_enrollments')) {
        const key = String(params[3]);
        const enrollment = enrollments.get(key);
        if (
          !enrollment ||
          enrollment.phase !== String(params[4]) ||
          enrollment.expires_at <= Number(params[5])
        ) {
          return { rowsAffected: 0 };
        }
        enrollments.set(key, {
          ...enrollment,
          phase: String(params[0]),
          state_json: String(params[1]),
        });
        return { rowsAffected: 1 };
      }
      return { rowsAffected: 1 };
    });
    adapter.batch.mockImplementation(async (statements) => {
      const consume = statements.find((statement) =>
        statement.sql.includes('DELETE FROM admin_invitation_enrollments')
      );
      if (consume?.params?.[0]) enrollments.delete(String(consume.params[0]));
      return [];
    });
    webauthn.generateRegistrationOptions.mockResolvedValue({ challenge: 'registration-challenge' });
    webauthn.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'authentication-challenge',
    });
    webauthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'credential-id',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 1,
        },
        aaguid: null,
      },
    });
    webauthn.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    });
  });

  it('rejects redemption outside the invitation IP ranges', async () => {
    const env = createEnv();
    const response = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/redeem',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '198.51.100.20',
        },
        body: JSON.stringify({
          email: invitation.email,
          code: '2345-6789-ABCD-EFGH',
        }),
      },
      env
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'ip_not_allowed' });
    expect(enrollments.size).toBe(0);
  });

  it('redeems an allowed code only for a short Passkey enrollment token', async () => {
    const env = createEnv();
    const response = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/redeem',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.42',
        },
        body: JSON.stringify({
          email: invitation.email,
          code: '2345-6789-ABCD-EFGH',
        }),
      },
      env
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveProperty('enrollment_token');
    expect(body).not.toHaveProperty('session_id');
    expect(response.headers.get('set-cookie')).toBeNull();
    const enrollmentToken = (body as { enrollment_token: string }).enrollment_token;
    expect(enrollments.has(await hashToken(enrollmentToken))).toBe(true);
    expect([...enrollments.keys()]).not.toContain(enrollmentToken);
  });

  it('requires a resident, user-verified Passkey during registration', async () => {
    const env = createEnv();
    await seedEnrollment('enrollment-token', {
      invitationId: invitation.id,
      phase: 'redeemed',
      clientIp: '203.0.113.42',
    });

    const response = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/passkey/options',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://admin.example.com',
          'cf-connecting-ip': '203.0.113.42',
        },
        body: JSON.stringify({
          enrollment_token: 'enrollment-token',
          rp_id: 'admin.example.com',
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(webauthn.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
      })
    );
  });

  it('rejects an enrollment token after its fixed D1 expiry', async () => {
    const env = createEnv();
    const token = 'expired-enrollment-token';
    enrollments.set(await hashToken(token), {
      phase: 'redeemed',
      state_json: JSON.stringify({
        invitationId: invitation.id,
        phase: 'redeemed',
        clientIp: '203.0.113.42',
      }),
      expires_at: Date.now() - 1,
    });

    const response = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/passkey/options',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://admin.example.com',
          'cf-connecting-ip': '203.0.113.42',
        },
        body: JSON.stringify({
          enrollment_token: token,
          rp_id: 'admin.example.com',
        }),
      },
      env
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_enrollment' });
  });

  it('rejects malformed WebAuthn JSON before calling the verifier', async () => {
    const env = createEnv();
    await seedEnrollment('enrollment-token', {
      invitationId: invitation.id,
      phase: 'registration',
      clientIp: '203.0.113.42',
      registration: {
        challengeId: 'challenge-id',
        challenge: 'registration-challenge',
        rpID: 'admin.example.com',
        origin: 'https://admin.example.com',
      },
    });

    const response = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/passkey/register',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enrollment_token: 'enrollment-token',
          challenge_id: 'challenge-id',
          origin: 'https://admin.example.com',
          passkey_response: { id: 'credential-id' },
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_request' });
    expect(webauthn.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('completes registration, verifies the same Passkey, and rejects replay', async () => {
    const env = createEnv();
    const commonHeaders = {
      'content-type': 'application/json',
      origin: 'https://admin.example.com',
      'cf-connecting-ip': '203.0.113.42',
    };

    const redeemResponse = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/redeem',
      {
        method: 'POST',
        headers: commonHeaders,
        body: JSON.stringify({
          email: invitation.email,
          code: '2345-6789-ABCD-EFGH',
        }),
      },
      env
    );
    const redeemBody = (await redeemResponse.json()) as { enrollment_token: string };

    const optionsResponse = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/passkey/options',
      {
        method: 'POST',
        headers: commonHeaders,
        body: JSON.stringify({
          enrollment_token: redeemBody.enrollment_token,
          rp_id: 'admin.example.com',
        }),
      },
      env
    );
    const optionsBody = (await optionsResponse.json()) as { challenge_id: string };

    const registerResponse = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/passkey/register',
      {
        method: 'POST',
        headers: commonHeaders,
        body: JSON.stringify({
          enrollment_token: redeemBody.enrollment_token,
          challenge_id: optionsBody.challenge_id,
          origin: 'https://admin.example.com',
          passkey_response: {
            id: 'credential-id',
            rawId: 'credential-id',
            response: {
              clientDataJSON: 'registration-client-data',
              attestationObject: 'attestation-object',
              transports: ['internal'],
            },
            type: 'public-key',
            clientExtensionResults: {},
          },
        }),
      },
      env
    );
    const registerBody = (await registerResponse.json()) as { challenge_id: string };

    const activationRequest = {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({
        enrollment_token: redeemBody.enrollment_token,
        challenge_id: registerBody.challenge_id,
        credential: {
          id: 'credential-id',
          rawId: 'credential-id',
          response: {
            clientDataJSON: 'authentication-client-data',
            authenticatorData: 'authenticator-data',
            signature: 'signature',
          },
          type: 'public-key',
          clientExtensionResults: {},
        },
      }),
    };
    const activationResponse = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/activate',
      activationRequest,
      env
    );
    const replayResponse = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/activate',
      activationRequest,
      env
    );

    expect(redeemResponse.status).toBe(200);
    expect(optionsResponse.status).toBe(200);
    expect(registerResponse.status).toBe(200);
    expect(activationResponse.status).toBe(200);
    expect(adapter.batch).toHaveBeenCalledOnce();
    expect(replayResponse.status).toBe(401);
    await expect(replayResponse.json()).resolves.toEqual({ error: 'invalid_enrollment' });
  });

  it('rejects an origin outside the configured Admin UI origin', async () => {
    const env = createEnv();
    await seedEnrollment('enrollment-token', {
      invitationId: invitation.id,
      phase: 'redeemed',
      clientIp: '203.0.113.42',
    });

    const response = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/passkey/options',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example.com',
          'cf-connecting-ip': '203.0.113.42',
        },
        body: JSON.stringify({
          enrollment_token: 'enrollment-token',
          rp_id: 'evil.example.com',
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_origin' });
  });

  it('expires an invitation and releases its pending email key', async () => {
    adapter.queryOne.mockResolvedValue({ ...invitation, expires_at: Date.now() - 1 });
    const env = createEnv();

    const response = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/redeem',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.42',
        },
        body: JSON.stringify({
          email: invitation.email,
          code: '2345-6789-ABCD-EFGH',
        }),
      },
      env
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'invitation_expired' });
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('pending_email_key = NULL'),
      expect.arrayContaining([invitation.id])
    );
  });

  it('activates Admin, Passkey, role, session, invitation, and audit in one batch', async () => {
    const env = createEnv();
    await seedEnrollment('enrollment-token', {
      invitationId: invitation.id,
      phase: 'authentication',
      clientIp: '203.0.113.42',
      authentication: {
        challengeId: 'challenge-id',
        challenge: 'authentication-challenge',
        rpID: 'admin.example.com',
        origin: 'https://admin.example.com',
        credentialId: 'credential-id',
        publicKey: 'AQID',
        counter: 1,
        transports: ['internal'],
        aaguid: null,
      },
    });

    const response = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/activate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.42',
          'user-agent': 'test-browser',
        },
        body: JSON.stringify({
          enrollment_token: 'enrollment-token',
          challenge_id: 'challenge-id',
          credential: {
            id: 'credential-id',
            rawId: 'credential-id',
            response: {
              clientDataJSON: 'client-data',
              authenticatorData: 'authenticator-data',
              signature: 'signature',
            },
            type: 'public-key',
            clientExtensionResults: {},
          },
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(adapter.batch).toHaveBeenCalledOnce();
    const statements = adapter.batch.mock.calls[0][0];
    expect(statements).toHaveLength(7);
    for (const statement of statements) {
      expect(statement.sql.match(/\?/gu) ?? []).toHaveLength(statement.params?.length ?? 0);
    }
    expect(statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining('INSERT INTO admin_users'),
      expect.stringContaining('INSERT INTO admin_passkeys'),
      expect.stringContaining('INSERT INTO admin_role_assignments'),
      expect.stringContaining('INSERT INTO admin_sessions'),
      expect.stringContaining('UPDATE admin_invitations'),
      expect.stringContaining('INSERT INTO admin_audit_log'),
      expect.stringContaining('DELETE FROM admin_invitation_enrollments'),
    ]);
    expect(statements[0].sql).toContain('EXISTS');
    expect(statements[0].params).toContain(await hashToken('enrollment-token'));
    expect(enrollments.has(await hashToken('enrollment-token'))).toBe(false);
    expect(response.headers.get('set-cookie')).toContain('authrim_admin_session=');
  });

  it('does not create a session when the atomic activation batch conflicts', async () => {
    const env = createEnv();
    await seedEnrollment('enrollment-token', {
      invitationId: invitation.id,
      phase: 'authentication',
      clientIp: '203.0.113.42',
      authentication: {
        challengeId: 'challenge-id',
        challenge: 'authentication-challenge',
        rpID: 'admin.example.com',
        origin: 'https://admin.example.com',
        credentialId: 'credential-id',
        publicKey: 'AQID',
        counter: 1,
        transports: ['internal'],
        aaguid: null,
      },
    });
    adapter.batch.mockRejectedValueOnce(new Error('UNIQUE constraint failed'));

    const response = await adminInvitationEnrollmentApp.request(
      '/api/admin/invitations/activate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.42',
        },
        body: JSON.stringify({
          enrollment_token: 'enrollment-token',
          challenge_id: 'challenge-id',
          credential: {
            id: 'credential-id',
            rawId: 'credential-id',
            response: {
              clientDataJSON: 'client-data',
              authenticatorData: 'authenticator-data',
              signature: 'signature',
            },
            type: 'public-key',
            clientExtensionResults: {},
          },
        }),
      },
      env
    );

    expect(response.status).toBe(409);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(enrollments.has(await hashToken('enrollment-token'))).toBe(true);
  });
});
