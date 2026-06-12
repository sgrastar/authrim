import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryPasswordLoginHandler } from '../directory-password-login';

const mocks = vi.hoisted(() => ({
  findByEmail: vi.fn(),
  findById: vi.fn(),
  syncUser: vi.fn(),
  sessionStore: {
    createSessionRpc: vi.fn(),
  },
  getSessionStoreForNewSession: vi.fn(),
  generateUserIdFromSettings: vi.fn(),
  generateBrowserState: vi.fn(),
  getChallengeStoreByChallengeId: vi.fn(),
  publishEvent: vi.fn(),
  createAuditLog: vi.fn(),
  challengeStore: {
    consumeChallengeRpc: vi.fn(),
  },
  confirmationStore: {
    storeChallengeRpc: vi.fn(),
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    CanonicalRuntimeUserStore: class {
      findByEmail = mocks.findByEmail;
      findById = mocks.findById;
      syncUser = mocks.syncUser;
    },
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getSessionStoreForNewSession: mocks.getSessionStoreForNewSession,
    generateUserIdFromSettings: mocks.generateUserIdFromSettings,
    generateBrowserState: mocks.generateBrowserState,
    getChallengeStoreByChallengeId: mocks.getChallengeStoreByChallengeId,
    publishEvent: mocks.publishEvent,
    createAuditLog: mocks.createAuditLog,
    getSessionCookieSameSite: vi.fn(() => 'Lax'),
    getBrowserStateCookieSameSite: vi.fn(() => 'Lax'),
    getLogger: vi.fn(() => ({
      module: () => ({
        warn: vi.fn(),
        error: vi.fn(),
      }),
    })),
  };
});

function createKV(values: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string) => {
      const value = values[key];
      return value === undefined ? null : JSON.stringify(value);
    }),
  };
}

function createContext(body: Record<string, unknown>, settings?: Record<string, unknown>) {
  const headers = new Headers();
  const env = {
    AUTHRIM_CONFIG: createKV({
      'settings:tenant:tenant-a:authentication-methods': {
        'authentication-methods.directory_password.enabled': true,
        'authentication-methods.directory_password.connector_id': 'campus',
      },
      'settings:tenant:tenant-a:directory-connectors': {
        'directory-connectors.campus.endpoint_url': 'https://wordwarden.example.com',
        'directory-connectors.campus.auth_mode': 'hmac',
        'directory-connectors.campus.connector_id': 'ww_tenant_a',
        'directory-connectors.campus.key_id': 'kid-active',
        'directory-connectors.campus.secret_ref': 'env:WORDWARDEN_SECRET',
        'directory-connectors.campus.timeouts.request_ms': 1000,
        'directory-connectors.campus.attribute_names': ['mail', 'displayName'],
      },
      ...settings,
    }),
    WORDWARDEN_SECRET: 'active-secret',
  };
  return {
    req: {
      url: 'https://auth.example.com/api/auth/directory-password/login',
      json: vi.fn(async () => body),
      header: vi.fn((name: string) => {
        const lower = name.toLowerCase();
        if (lower === 'user-agent') return 'Test Browser';
        if (lower === 'cf-connecting-ip') return '203.0.113.10';
        return undefined;
      }),
    },
    env,
    header: (name: string, value: string) => {
      headers.append(name, value);
    },
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers,
      }),
  };
}

describe('directory password login handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByEmail.mockResolvedValue(null);
    mocks.findById.mockResolvedValue({
      id: 'user_generated',
      email: 'alice@example.com',
      name: 'Alice Example',
    });
    mocks.syncUser.mockResolvedValue({ userId: 'user_generated' });
    mocks.getSessionStoreForNewSession.mockResolvedValue({
      stub: mocks.sessionStore,
      sessionId: 'sess_directory',
    });
    mocks.generateUserIdFromSettings.mockResolvedValue('user_generated');
    mocks.generateBrowserState.mockResolvedValue('browser-state');
    mocks.sessionStore.createSessionRpc.mockResolvedValue({ id: 'sess_directory' });
    mocks.getChallengeStoreByChallengeId.mockReset();
    mocks.challengeStore.consumeChallengeRpc.mockReset();
    mocks.confirmationStore.storeChallengeRpc.mockReset();
    mocks.publishEvent.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
  });

  it('verifies Wordwarden credentials and creates an Authrim session', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;

      expect(headers.get('X-Authrim-Connector-Id')).toBe('ww_tenant_a');
      expect(headers.get('X-Authrim-Signature')).toMatch(/^[a-f0-9]{64}$/);
      expect(body).toMatchObject({
        tenant_id: 'tenant-a',
        connector_id: 'ww_tenant_a',
        username: 'alice',
        password: 'correct',
        attribute_names: ['mail', 'displayName'],
      });

      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'ww_tenant_a',
        result: 'success',
        subject: {
          directory_id: 'uid=alice,ou=People,dc=example,dc=com',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
          displayName: ['Alice Example'],
        },
        directory_status: 'ok',
      });
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:authentication-methods': {
            'authentication-methods.directory_password.enabled': true,
            'authentication-methods.directory_password.connector_id': 'campus',
            'authentication-methods.directory_password.auto_provision': true,
          },
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.syncUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_generated',
        email: 'alice@example.com',
        emailVerified: true,
        sourceRef: 'directory:campus',
        externalId: 'uid=alice,ou=People,dc=example,dc=com',
      })
    );
    expect(mocks.sessionStore.createSessionRpc).toHaveBeenCalledWith(
      'sess_directory',
      'user_generated',
      86400,
      expect.objectContaining({
        amr: ['pwd', 'directory'],
        directory_connector_id: 'campus',
      }),
      'tenant-a'
    );
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'auth.directory_password.succeeded',
        tenantId: 'tenant-a',
        data: expect.objectContaining({
          userId: 'user_generated',
          method: 'directory_password',
          sessionId: 'sess_directory',
          connectorId: 'campus',
          requestId: expect.any(String),
        }),
      })
    );
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'session.user.created',
        tenantId: 'tenant-a',
        data: expect.objectContaining({
          userId: 'user_generated',
          sessionId: 'sess_directory',
          ttlSeconds: 86400,
        }),
      })
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        userId: 'user_generated',
        action: 'user.login',
        resourceId: 'sess_directory',
        ipAddress: '203.0.113.10',
        userAgent: 'Test Browser',
        metadata: expect.stringContaining('"method":"directory_password"'),
      })
    );
    expect(response.headers.get('set-cookie')).toContain('authrim_session=sess_directory');
  });

  it('returns 401 without creating a session when Wordwarden rejects credentials', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'ww_tenant_a',
        result: 'failure',
        reason: 'invalid_credentials',
        directory_status: 'ok',
      });
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext({ username: 'alice', password: 'wrong' }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body.error).toBe('invalid_credentials');
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'auth.directory_password.failed',
        tenantId: 'tenant-a',
        data: expect.objectContaining({
          method: 'directory_password',
          connectorId: 'campus',
          requestId: expect.any(String),
          errorCode: 'invalid_credentials',
        }),
      })
    );
  });

  it('does not create a session for policy-required directory verdicts', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'ww_tenant_a',
        result: 'policy_required',
        reason: 'must_change_password',
        directory_status: 'ok',
      });
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext({ username: 'alice', password: 'correct' }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body.error).toBe('invalid_credentials');
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
    expect(mocks.syncUser).not.toHaveBeenCalled();
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'auth.directory_password.failed',
        tenantId: 'tenant-a',
        data: expect.objectContaining({
          method: 'directory_password',
          connectorId: 'campus',
          errorCode: 'must_change_password',
        }),
      })
    );
  });

  it('returns a generic connector error and publishes a failure event when Wordwarden is unavailable', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json(
        {
          request_id: body.request_id,
          tenant_id: 'tenant-a',
          connector_id: 'ww_tenant_a',
          error: {
            code: 'directory_unavailable',
            retryable: true,
          },
        },
        { status: 503 }
      );
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext({ username: 'alice', password: 'correct' }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: 'connector_unavailable',
      retryable: true,
    });
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'auth.directory_password.failed',
        tenantId: 'tenant-a',
        data: expect.objectContaining({
          method: 'directory_password',
          connectorId: 'campus',
          requestId: expect.any(String),
          errorCode: 'directory_unavailable',
        }),
      })
    );
  });

  it('returns unmapped when a directory identity has no Authrim user and auto provision is disabled', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'ww_tenant_a',
        result: 'success',
        subject: {
          directory_id: 'uid=alice,ou=People,dc=example,dc=com',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
          displayName: ['Alice Example'],
        },
        directory_status: 'ok',
      });
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext({ username: 'alice', password: 'correct' }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body.error).toBe('directory_identity_unmapped');
    expect(mocks.syncUser).not.toHaveBeenCalled();
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'auth.directory_password.failed',
        data: expect.objectContaining({
          connectorId: 'campus',
          errorCode: 'directory_identity_unmapped',
        }),
      })
    );
  });

  it('continues an authorization challenge after successful directory password login', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'ww_tenant_a',
        result: 'success',
        subject: {
          directory_id: 'uid=alice,ou=People,dc=example,dc=com',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
          displayName: ['Alice Example'],
        },
        directory_status: 'ok',
      });
    });
    mocks.findByEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'alice@example.com',
      name: 'Alice Example',
    });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      metadata: {
        issuer: 'https://auth.example.com',
        response_type: 'code',
        client_id: 'client-a',
        redirect_uri: 'https://app.example.com/callback',
        scope: 'openid profile',
        state: 'state-123',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
      },
    });
    mocks.getChallengeStoreByChallengeId
      .mockResolvedValueOnce(mocks.challengeStore)
      .mockResolvedValueOnce(mocks.confirmationStore);
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext({
        username: 'alice',
        password: 'correct',
        authorization_challenge_id: 'login_challenge',
      }) as never
    );
    const body = (await response.json()) as {
      redirect_url?: string;
      authorization?: { challenge_id?: string; type?: string };
    };

    expect(response.status).toBe(200);
    expect(body.authorization).toEqual({
      challenge_id: 'login_challenge',
      type: 'login',
    });
    expect(body.redirect_url).toContain('https://auth.example.com/authorize?');
    expect(body.redirect_url).toContain('client_id=client-a');
    expect(body.redirect_url).toContain('_confirmation_challenge=');
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'login_challenge',
      tenantId: 'tenant-a',
      type: 'login',
      challenge: 'login_challenge',
    });
    expect(mocks.confirmationStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        type: 'reauth',
        userId: 'user_existing',
        ttl: 60,
      })
    );
  });

  it('returns 404 when the tenant has not enabled directory password login', async () => {
    const handler = createDirectoryPasswordLoginHandler(vi.fn());

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:authentication-methods': {
            'authentication-methods.directory_password.enabled': false,
          },
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body.error).toBe('directory_password_not_configured');
  });

  it('returns 404 when the connector uses an unsupported auth mode', async () => {
    const handler = createDirectoryPasswordLoginHandler(vi.fn());

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': {
            'directory-connectors.campus.endpoint_url': 'https://wordwarden.example.com',
            'directory-connectors.campus.auth_mode': 'mtls',
            'directory-connectors.campus.connector_id': 'ww_tenant_a',
            'directory-connectors.campus.key_id': 'kid-active',
            'directory-connectors.campus.secret_ref': 'env:WORDWARDEN_SECRET',
          },
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body.error).toBe('directory_password_not_configured');
  });

  it('returns 404 when the connector secret references a disallowed env binding', async () => {
    const handler = createDirectoryPasswordLoginHandler(vi.fn());

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': {
            'directory-connectors.campus.endpoint_url': 'https://wordwarden.example.com',
            'directory-connectors.campus.auth_mode': 'hmac',
            'directory-connectors.campus.connector_id': 'ww_tenant_a',
            'directory-connectors.campus.key_id': 'kid-active',
            'directory-connectors.campus.secret_ref': 'env:UNRELATED_SECRET',
          },
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body.error).toBe('directory_password_not_configured');
  });
});
