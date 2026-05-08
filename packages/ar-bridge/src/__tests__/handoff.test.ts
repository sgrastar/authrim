import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  consumeChallengeRpc: vi.fn(),
  getSessionRpc: vi.fn(),
  createSessionRpc: vi.fn(),
  findClientByClientId: vi.fn(),
  findUserById: vi.fn(),
  findUserPIIById: vi.fn(),
  extractDPoPProof: vi.fn(),
  validateDPoPProof: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  AR_ERROR_CODES: {
    VALIDATION_REQUIRED_FIELD: 'validation_required_field',
    RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
    AUTH_ORIGIN_NOT_ALLOWED: 'auth_origin_not_allowed',
    AUTH_CLIENT_NOT_FOUND: 'auth_client_not_found',
    CLIENT_METADATA_INVALID: 'client_metadata_invalid',
    AUTH_INVALID_CODE: 'auth_invalid_code',
    INTERNAL_ERROR: 'internal_error',
    AUTH_SESSION_EXPIRED: 'auth_session_expired',
    USER_INVALID_CREDENTIALS: 'user_invalid_credentials',
  },
  createErrorResponse: (c: any, code: string, options?: unknown) =>
    c.json({ error: code, options }, 400),
  createPhase1ErrorDetails: (code: string) => ({
    code,
    retryable: false,
    severity: 'error',
    user_action: 'reauthenticate',
  }),
  getLogger: () => ({
    module: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  getTenantIdFromContext: vi.fn().mockReturnValue('tenant-123'),
  createAuthContextFromHono: vi.fn(() => ({
    repositories: {
      client: {
        findByClientId: mocks.findClientByClientId,
      },
      userCore: {
        findById: mocks.findUserById,
      },
    },
  })),
  createPIIContextFromHono: vi.fn(() => ({
    piiRepositories: {
      userPII: {
        findById: mocks.findUserPIIById,
      },
    },
  })),
  hasPIIDatabase: vi.fn().mockReturnValue(true),
  isAllowedOriginForClient: vi.fn().mockReturnValue(true),
  getChallengeStoreByChallengeId: vi.fn().mockResolvedValue({
    consumeChallengeRpc: mocks.consumeChallengeRpc,
  }),
  getSessionStoreBySessionId: vi.fn().mockReturnValue({
    stub: {
      getSessionRpc: mocks.getSessionRpc,
    },
  }),
  getSessionStoreForNewSession: vi.fn().mockResolvedValue({
    sessionId: 'rp-access-token',
    stub: {
      createSessionRpc: mocks.createSessionRpc,
    },
  }),
  isShardedSessionId: vi.fn().mockReturnValue(true),
  extractDPoPProof: mocks.extractDPoPProof,
  validateDPoPProof: mocks.validateDPoPProof,
  getSessionCookieSameSite: vi.fn().mockReturnValue('Lax'),
}));

import { handleHandoffFinalize, handleHandoffVerify } from '../handlers/handoff';

function createContext(url = 'https://issuer.example.com/handoff/verify') {
  const headers = new Headers({
    Origin: 'https://rp.example.com',
    DPoP: 'dpop-proof',
  });
  const responseHeaders = new Headers();
  const parsedUrl = new URL(url);

  return {
    env: {
      ENVIRONMENT: 'production',
      DPOP_JTI_STORE: {},
      SETTINGS: {},
    },
    req: {
      method: 'POST',
      url,
      raw: { headers },
      header: (name: string) => headers.get(name),
      query: (name: string) => parsedUrl.searchParams.get(name) ?? undefined,
      json: vi.fn().mockResolvedValue({
        handoff_token: 'handoff-token',
        state: 'state-123',
        client_id: 'client-123',
      }),
    },
    header: (name: string, value: string) => {
      if (name.toLowerCase() === 'set-cookie' && responseHeaders.has(name)) {
        responseHeaders.set(name, `${responseHeaders.get(name)}, ${value}`);
        return;
      }
      responseHeaders.set(name, value);
    },
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: responseHeaders,
      }),
  } as any;
}

describe('handleHandoffVerify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractDPoPProof.mockReturnValue('dpop-proof');
    mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'jkt-123' });
    mocks.findClientByClientId.mockResolvedValue({
      redirect_uris: JSON.stringify(['https://rp.example.com/callback']),
    });
    mocks.consumeChallengeRpc.mockResolvedValue({
      challenge: 'shard-session-123',
      userId: 'user-123',
      metadata: {
        client_id: 'client-123',
        state: 'state-123',
        aud: 'handoff',
        created_at: Date.now(),
      },
    });
    mocks.getSessionRpc.mockResolvedValue({
      data: {
        amr: ['external_idp'],
        acr: 'urn:mace:incommon:iap:bronze',
      },
    });
    mocks.findUserById.mockResolvedValue({
      id: 'user-123',
      is_active: true,
      email_verified: true,
    });
    mocks.findUserPIIById.mockResolvedValue({
      email: 'user@example.com',
      name: 'Example User',
    });
    mocks.createSessionRpc.mockResolvedValue(undefined);
  });

  it('rejects missing DPoP proof with machine-readable details', async () => {
    mocks.extractDPoPProof.mockReturnValue(undefined);

    const response = await handleHandoffVerify(createContext());
    const body = (await response.json()) as { error: string; error_details?: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.error_details?.code).toBe('dpop_proof_missing');
    expect(mocks.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('rejects invalid DPoP proof with machine-readable details', async () => {
    mocks.validateDPoPProof.mockResolvedValue({
      valid: false,
      error_description: 'DPoP proof signature verification failed',
    });

    const response = await handleHandoffVerify(createContext());
    const body = (await response.json()) as { error: string; error_details?: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.error_details?.code).toBe('dpop_proof_invalid');
    expect(mocks.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('returns a pure DPoP token response by default and binds the RP token to the DPoP key', async () => {
    const response = await handleHandoffVerify(createContext());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      token_type: 'DPoP',
      access_token: 'rp-access-token',
      expires_in: 3600,
    });
    expect(body.session).toBeUndefined();
    expect(body.user).toBeUndefined();
    expect(mocks.validateDPoPProof).toHaveBeenCalledWith(
      'dpop-proof',
      'POST',
      'https://issuer.example.com/handoff/verify',
      undefined,
      expect.any(Object),
      'client-123',
      'tenant-123'
    );
    expect(mocks.createSessionRpc).toHaveBeenCalledWith(
      'rp-access-token',
      'user-123',
      3600,
      expect.objectContaining({
        token_type: 'DPoP',
        cnf: { jkt: 'jkt-123' },
      })
    );
  });

  it('returns session and user extensions only for include=session,user', async () => {
    const response = await handleHandoffVerify(
      createContext('https://issuer.example.com/handoff/verify?include=session,user')
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.session).toMatchObject({
      id: 'rp-access-token',
      userId: 'user-123',
    });
    expect(body.user).toMatchObject({
      id: 'user-123',
      email: 'user@example.com',
      name: 'Example User',
      emailVerified: true,
    });
  });

  it('rejects handoff artifacts older than the default TTL', async () => {
    mocks.consumeChallengeRpc.mockResolvedValueOnce({
      challenge: 'shard-session-123',
      userId: 'user-123',
      metadata: {
        client_id: 'client-123',
        state: 'state-123',
        aud: 'handoff',
        created_at: Date.now() - 61_000,
      },
    });

    const response = await handleHandoffVerify(createContext());
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('auth_invalid_code');
    expect(mocks.createSessionRpc).not.toHaveBeenCalled();
  });

  it('honors a clamped client handoff artifact TTL policy', async () => {
    mocks.findClientByClientId.mockResolvedValueOnce({
      redirect_uris: JSON.stringify(['https://rp.example.com/callback']),
      handoff_artifact_ttl_seconds: 120,
    });
    mocks.consumeChallengeRpc.mockResolvedValueOnce({
      challenge: 'shard-session-123',
      userId: 'user-123',
      metadata: {
        client_id: 'client-123',
        state: 'state-123',
        aud: 'handoff',
        created_at: Date.now() - 61_000,
      },
    });

    const response = await handleHandoffVerify(createContext());

    expect(response.status).toBe(200);
    expect(mocks.createSessionRpc).toHaveBeenCalled();
  });

  it('rejects unsupported include values', async () => {
    const response = await handleHandoffVerify(
      createContext('https://issuer.example.com/handoff/verify?include=user,session')
    );
    const body = (await response.json()) as { error: string; error_description: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toContain('include=session,user');
    expect(mocks.extractDPoPProof).not.toHaveBeenCalled();
  });

  it('finalizes cookie-only handoff without returning an access token', async () => {
    const response = await handleHandoffFinalize(
      createContext('https://issuer.example.com/handoff/finalize')
    );
    const body = (await response.json()) as Record<string, unknown>;
    const setCookie = response.headers.get('set-cookie') ?? '';

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      expires_in: 3600,
    });
    expect(body.access_token).toBeUndefined();
    expect(body.refresh_token).toBeUndefined();
    expect(setCookie).toContain('authrim_session=rp-access-token');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    expect(mocks.validateDPoPProof).not.toHaveBeenCalled();
    expect(mocks.createSessionRpc).toHaveBeenCalledWith(
      'rp-access-token',
      'user-123',
      3600,
      expect.objectContaining({
        token_type: 'Cookie',
      })
    );
    expect(mocks.createSessionRpc.mock.calls.at(-1)?.[3]).not.toHaveProperty('cnf');
  });

  it('uses the handoff artifact once for cookie-only finalize', async () => {
    mocks.consumeChallengeRpc
      .mockResolvedValueOnce({
        challenge: 'shard-session-123',
        userId: 'user-123',
        metadata: {
          client_id: 'client-123',
          state: 'state-123',
          aud: 'handoff',
          created_at: Date.now(),
        },
      })
      .mockRejectedValueOnce(new Error('already consumed'));

    const first = await handleHandoffFinalize(
      createContext('https://issuer.example.com/handoff/finalize')
    );
    const second = await handleHandoffFinalize(
      createContext('https://issuer.example.com/handoff/finalize')
    );
    const secondBody = (await second.json()) as { error: string };

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(secondBody.error).toBe('auth_invalid_code');
    expect(mocks.consumeChallengeRpc).toHaveBeenCalledTimes(2);
  });
});
