import { describe, expect, it, vi } from 'vitest';
import { adminSetupApiApp } from '../admin-setup-api';

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));

function generateRequest(body: Record<string, unknown>, env: Record<string, unknown>) {
  return adminSetupApiApp.request(
    '/api/admin/setup-token/generate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
}

describe('admin setup token generation', () => {
  it('fails closed when recovery key storage is not configured', async () => {
    const response = await generateRequest(
      { admin_user_id: 'admin-1', recovery_key: 'attacker-controlled' },
      { DB_ADMIN: {} }
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe('unauthorized');
  });

  it('fails closed when no recovery key is stored', async () => {
    const response = await generateRequest(
      { admin_user_id: 'admin-1', recovery_key: 'attacker-controlled' },
      {
        DB_ADMIN: {},
        AUTHRIM_CONFIG: {
          get: vi.fn().mockResolvedValue(null),
        },
      }
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe('unauthorized');
  });

  it('rejects an invalid recovery key before issuing a setup token', async () => {
    const response = await generateRequest(
      { admin_user_id: 'admin-1', recovery_key: 'wrong-key' },
      {
        DB_ADMIN: {},
        AUTHRIM_CONFIG: {
          get: vi.fn().mockResolvedValue('expected-key'),
        },
      }
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe('unauthorized');
  });
});
