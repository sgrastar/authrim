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
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'admin.authrim.example',
      })
    );
  });
});
