import { describe, expect, it, vi, beforeEach } from 'vitest';
import { adminSetupApiApp } from '../admin-setup-api';

const mocks = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));

vi.mock('@simplewebauthn/server', () => mocks);

function createMockAdminDb(firstResults: unknown[]) {
  const queue = [...firstResults];
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn(async () => queue.shift() ?? null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
    })),
  };
}

function adminUserRow() {
  const now = Date.now();
  return {
    id: 'admin-1',
    tenant_id: 'default',
    email: 'admin@example.com',
    email_verified: 1,
    name: 'Admin User',
    password_hash: null,
    is_active: 1,
    status: 'active',
    mfa_enabled: 0,
    mfa_method: null,
    totp_secret_encrypted: null,
    last_login_at: null,
    last_login_ip: null,
    failed_login_count: 0,
    locked_until: null,
    created_by: null,
    created_at: now,
    updated_at: now,
  };
}

describe('admin passkey login origin resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'admin-login-challenge',
    });
    mocks.generateRegistrationOptions.mockResolvedValue({
      challenge: 'admin-registration-challenge',
    });
    mocks.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: new Uint8Array([1, 2, 3]),
        credentialPublicKey: new Uint8Array([4, 5, 6]),
        counter: 0,
      },
    });
  });

  it('uses the Admin UI browser origin as RP ID behind the BFF proxy', async () => {
    const config = {
      put: vi.fn(),
    };

    const response = await adminSetupApiApp.request(
      '/api/admin/auth/passkey/options',
      {
        method: 'POST',
        headers: {
          Origin: 'https://test.authrim.com',
          'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
          'X-Authrim-Forwarded-Origin': 'https://test-ar-admin-ui.sgrastar.workers.dev',
        },
        body: '{}',
      },
      {
        AUTHRIM_CONFIG: config,
        ISSUER_URL: 'https://test.authrim.com',
        ADMIN_UI_URL: 'https://test-ar-admin-ui.sgrastar.workers.dev',
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'test-ar-admin-ui.sgrastar.workers.dev',
      })
    );

    const storedChallenge = JSON.parse(config.put.mock.calls[0][1]) as {
      rpID: string;
      origin: string;
    };
    expect(storedChallenge).toMatchObject({
      rpID: 'test-ar-admin-ui.sgrastar.workers.dev',
      origin: 'https://test-ar-admin-ui.sgrastar.workers.dev',
    });
  });

  it('falls back to the request Origin outside the BFF proxy', async () => {
    const config = {
      put: vi.fn(),
    };

    const response = await adminSetupApiApp.request(
      '/api/admin/auth/passkey/options',
      {
        method: 'POST',
        headers: {
          Origin: 'https://admin.authrim.example',
        },
        body: '{}',
      },
      {
        AUTHRIM_CONFIG: config,
        ISSUER_URL: 'https://authrim.example',
        ADMIN_UI_URL: 'https://admin.authrim.example',
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'admin.authrim.example',
      })
    );
  });

  it('rejects an unconfigured forwarded Admin UI browser origin', async () => {
    const config = {
      put: vi.fn(),
    };

    const response = await adminSetupApiApp.request(
      '/api/admin/auth/passkey/options',
      {
        method: 'POST',
        headers: {
          Origin: 'https://test.authrim.com',
          'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
          'X-Authrim-Forwarded-Origin': 'https://evil.example.com',
        },
        body: '{}',
      },
      {
        AUTHRIM_CONFIG: config,
        ISSUER_URL: 'https://test.authrim.com',
        ADMIN_UI_URL: 'https://admin.example.com',
      }
    );

    expect(response.status).toBe(400);
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
    expect(config.put).not.toHaveBeenCalled();
  });

  it('requires resident credentials and user verification during initial Admin setup', async () => {
    const config = {
      put: vi.fn(),
    };
    const token = {
      id: 'setup-token',
      admin_user_id: 'admin-1',
      status: 'pending',
      expires_at: Date.now() + 60_000,
    };

    const response = await adminSetupApiApp.request(
      '/api/admin/setup-token/passkey/options',
      {
        method: 'POST',
        headers: {
          Origin: 'https://admin.authrim.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: 'setup-token',
          rp_id: 'admin.authrim.example',
        }),
      },
      {
        DB_ADMIN: createMockAdminDb([token, adminUserRow()]),
        AUTHRIM_CONFIG: config,
        ISSUER_URL: 'https://authrim.example',
        ADMIN_UI_URL: 'https://admin.authrim.example',
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'admin.authrim.example',
        authenticatorSelection: expect.objectContaining({
          residentKey: 'required',
          userVerification: 'required',
        }),
      })
    );
  });

  it('requires user verification when completing initial Admin passkey setup', async () => {
    const config = {
      get: vi.fn().mockResolvedValue(
        JSON.stringify({
          challenge: 'admin-registration-challenge',
          rpID: 'admin.authrim.example',
          origin: 'https://admin.authrim.example',
          userId: 'admin-1',
          token: 'setup-token',
        })
      ),
      delete: vi.fn(),
    };
    const token = {
      id: 'setup-token',
      admin_user_id: 'admin-1',
      status: 'pending',
      expires_at: Date.now() + 60_000,
    };

    const response = await adminSetupApiApp.request(
      '/api/admin/setup-token/passkey/complete',
      {
        method: 'POST',
        headers: {
          Origin: 'https://admin.authrim.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: 'setup-token',
          challenge_id: 'challenge-1',
          origin: 'https://admin.authrim.example',
          passkey_response: {
            id: 'credential-1',
            rawId: 'credential-1',
            type: 'public-key',
            response: {
              transports: ['internal'],
            },
          },
        }),
      },
      {
        DB_ADMIN: createMockAdminDb([token, adminUserRow()]),
        AUTHRIM_CONFIG: config,
        ISSUER_URL: 'https://authrim.example',
        ADMIN_UI_URL: 'https://admin.authrim.example',
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'admin-registration-challenge',
        expectedOrigin: 'https://admin.authrim.example',
        expectedRPID: 'admin.authrim.example',
        requireUserVerification: true,
      })
    );
  });
});
