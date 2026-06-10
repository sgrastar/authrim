import { describe, expect, it, vi, beforeEach } from 'vitest';
import { adminSetupApiApp } from '../admin-setup-api';

const mocks = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));

vi.mock('@simplewebauthn/server', () => mocks);

describe('admin passkey login origin resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'admin-login-challenge',
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
});
