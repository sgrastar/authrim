import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDirectoryPasswordLoginHandler,
  directoryMigrationEmailCodeSendHandler,
  directoryMigrationEmailCodeVerifyHandler,
  directoryMigrationPasskeyOptionsHandler,
  directoryMigrationPasskeyVerifyHandler,
} from '../directory-password-login';
import { hashEmailCode } from '../utils/email-code-utils';

const mocks = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  findByEmail: vi.fn(),
  findById: vi.fn(),
  syncUser: vi.fn(),
  passkeyRepo: {
    findByUserId: vi.fn(),
    create: vi.fn(),
  },
  sessionStore: {
    createSessionRpc: vi.fn(),
  },
  getSessionStoreForNewSession: vi.fn(),
  generateUserIdFromSettings: vi.fn(),
  generateBrowserState: vi.fn(),
  getChallengeStoreByChallengeId: vi.fn(),
  publishEvent: vi.fn(),
  createAuditLog: vi.fn(),
  completeDirectoryAuthEmailCodeFallback: vi.fn(),
  findActiveInvitationByToken: vi.fn(),
  emailNotifier: {
    send: vi.fn(),
  },
  emailNotifierEnabled: true,
  rateLimiter: {
    incrementRpc: vi.fn(),
    resetRpc: vi.fn(),
  },
  coreAdapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  },
  challengeStore: {
    storeChallengeRpc: vi.fn(),
    getChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
  },
  confirmationStore: {
    storeChallengeRpc: vi.fn(),
  },
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mocks.generateRegistrationOptions,
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
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
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: mocks.coreAdapter,
      repositories: {
        passkey: mocks.passkeyRepo,
      },
    })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    ensureAccountAuthenticationState: vi.fn(async () => ({ lifecycle: 'active' })),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getSessionStoreForNewSession: mocks.getSessionStoreForNewSession,
    generateUserIdFromSettings: mocks.generateUserIdFromSettings,
    generateBrowserState: mocks.generateBrowserState,
    getChallengeStoreByChallengeId: mocks.getChallengeStoreByChallengeId,
    publishEvent: mocks.publishEvent,
    createAuditLog: mocks.createAuditLog,
    completeDirectoryAuthEmailCodeFallback: mocks.completeDirectoryAuthEmailCodeFallback,
    resolveDirectoryAuthEffectiveEmailCodeFallbackMode: vi.fn(
      async (_adapter, _tenantId, campaign) =>
        campaign.email_code_fallback_mode === 'tenant_default'
          ? 'migration_recovery'
          : campaign.email_code_fallback_mode
    ),
    resolveDirectoryAuthEmailFallbackRecoveryCampaign: vi.fn(
      async (
        adapter: {
          query: (
            sql: string,
            params: unknown[]
          ) => Promise<Array<{ target_policy_json?: string }>>;
        },
        input: { tenantId: string; mode: string; userId: string }
      ) => {
        const campaigns = await adapter.query(
          `SELECT *
           FROM directory_auth_migration_campaigns
          WHERE tenant_id = ?
            AND status = 'active'
            AND is_template = 0
            AND email_code_fallback_mode IN (?, 'tenant_default')
          ORDER BY updated_at DESC
          LIMIT 20`,
          [input.tenantId, input.mode]
        );
        return (
          campaigns.find((campaign: { target_policy_json?: string }) => {
            const policy = JSON.parse(campaign.target_policy_json ?? '{}') as Record<
              string,
              unknown
            >;
            return (
              policy.type === 'all' ||
              policy.tenant_default === true ||
              (Array.isArray(policy.user_ids) && policy.user_ids.includes(input.userId))
            );
          }) ?? null
        );
      }
    ),
    findActiveInvitationByToken: mocks.findActiveInvitationByToken,
    getSessionCookieSameSite: vi.fn(() => 'Lax'),
    getBrowserStateCookieSameSite: vi.fn(() => 'Lax'),
    getLogger: vi.fn(() => ({
      module: () => ({
        warn: vi.fn(),
        error: vi.fn(),
      }),
    })),
    getRequiredPluginContext: vi.fn(() => ({
      registry: {
        getNotifier: vi.fn((channel: string) =>
          channel === 'email' && mocks.emailNotifierEnabled ? mocks.emailNotifier : undefined
        ),
      },
    })),
    produceNotificationDelivery: vi.fn(async (_env, input) => {
      if (!mocks.emailNotifierEnabled) {
        throw new Error('notification_delivery_provider_order_unavailable');
      }
      const result = await mocks.emailNotifier.send(input.payload);
      return {
        reference: { intentId: input.intentId },
        bindingRef: 'TDB_SHARED_CORE',
        delivery: result.success ? 'delivered' : 'permanent_failure',
      };
    }),
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

async function testMigrationTokenHash(tenantId: string, token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${tenantId}:${token}`)
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}

function directoryConnectors(
  connectorOverrides: Record<string, unknown> = {},
  configOverrides: Record<string, unknown> = {}
) {
  return {
    enabled: true,
    default_connector_id: 'campus',
    auto_provision: false,
    connectors: [
      {
        id: 'campus',
        endpoint_url: 'https://wordwarden.example.com',
        auth_mode: 'hmac',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        key_id: 'kid-active',
        secret_ref: 'env:WORDWARDEN_SECRET',
        timeouts: {
          request_ms: 1000,
        },
        attribute_names: ['mail', 'displayName'],
        ...connectorOverrides,
      },
    ],
    ...configOverrides,
  };
}

function createContext(
  body: Record<string, unknown>,
  settings?: Record<string, unknown>,
  authrimConfigOverrides?: Record<string, unknown>,
  envOverrides: Record<string, unknown> = {}
) {
  const headers = new Headers();
  const authrimConfigSettings = {
    ...settings,
    ...authrimConfigOverrides,
  };
  const settingsKV = {
    'settings:tenant:tenant-a:directory-connectors': directoryConnectors(),
    ...settings,
  };
  const env = {
    AUTHRIM_CONFIG: createKV(authrimConfigSettings),
    SETTINGS: createKV(settingsKV),
    WORDWARDEN_SECRET: 'active-secret',
    EMAIL_DOMAIN_HASH_SECRET: 'audit-hash-secret',
    OTP_HMAC_SECRET: 'otp-secret',
    EMAIL_FROM: 'noreply@example.com',
    RATE_LIMITER: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => mocks.rateLimiter),
    },
    ...envOverrides,
  };
  return {
    req: {
      url: 'https://auth.example.com/api/auth/directory-password/login',
      raw: new Request('https://auth.example.com/api/auth/directory-password/login'),
      json: vi.fn(async () => body),
      header: vi.fn((name: string) => {
        const lower = name.toLowerCase();
        if (lower === 'origin') return 'https://auth.example.com';
        if (lower === 'host') return 'auth.example.com';
        if (lower === 'user-agent') return 'Test Browser';
        if (lower === 'cf-connecting-ip') return '203.0.113.10';
        return undefined;
      }),
    },
    env,
    get: vi.fn((name: string) => (name === 'tenantId' ? 'tenant-a' : undefined)),
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
    mocks.coreAdapter.query.mockResolvedValue([]);
    mocks.coreAdapter.queryOne.mockResolvedValue({ user_id: 'user_generated' });
    mocks.coreAdapter.execute.mockResolvedValue({ rowsAffected: 1, success: true });
    mocks.findById.mockResolvedValue({
      id: 'user_generated',
      email: 'alice@example.com',
      name: 'Alice Example',
      active: 1,
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
    mocks.getChallengeStoreByChallengeId.mockResolvedValue(mocks.challengeStore);
    mocks.challengeStore.storeChallengeRpc.mockReset();
    mocks.challengeStore.consumeChallengeRpc.mockReset();
    mocks.passkeyRepo.findByUserId.mockReset().mockResolvedValue([]);
    mocks.passkeyRepo.create.mockReset().mockResolvedValue('passkey-id');
    mocks.generateRegistrationOptions.mockReset().mockResolvedValue({
      challenge: 'webauthn-challenge',
      rp: { id: 'auth.example.com', name: 'Authrim' },
      user: { id: 'user_generated', name: 'alice@example.com', displayName: 'Alice Example' },
      pubKeyCredParams: [],
    });
    mocks.verifyRegistrationResponse.mockReset().mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: new Uint8Array([1, 2, 3]),
        credentialPublicKey: new Uint8Array([4, 5, 6]),
        counter: 0,
        aaguid: null,
      },
    });
    mocks.confirmationStore.storeChallengeRpc.mockReset();
    mocks.completeDirectoryAuthEmailCodeFallback.mockReset().mockResolvedValue(true);
    mocks.findActiveInvitationByToken.mockReset().mockResolvedValue(null);
    mocks.emailNotifierEnabled = true;
    mocks.emailNotifier.send.mockReset().mockResolvedValue({ success: true, messageId: 'email-1' });
    mocks.rateLimiter.incrementRpc.mockReset().mockResolvedValue({ allowed: true });
    mocks.rateLimiter.resetRpc.mockReset().mockResolvedValue(true);
    mocks.publishEvent.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
  });

  it('verifies Wordwarden credentials and creates an Authrim session', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;

      expect(headers.get('X-Authrim-Connector-Id')).toBe('wwcon_8K4M2Q9F7D3H6P1X');
      expect(headers.get('X-Authrim-Signature')).toMatch(/^[a-f0-9]{64}$/);
      expect(body).toMatchObject({
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        username: 'alice',
        password: 'correct',
        attribute_names: ['mail', 'displayName'],
      });

      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {},
            { auto_provision: true }
          ),
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.syncUser).not.toHaveBeenCalled();
    expect(mocks.coreAdapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM directory_identity_links'),
      ['tenant-a', 'wwcon_8K4M2Q9F7D3H6P1X', 'uid=alice,ou=People,dc=example,dc=com']
    );
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE directory_identity_links'),
      expect.arrayContaining([
        'tenant-a',
        'wwcon_8K4M2Q9F7D3H6P1X',
        'uid=alice,ou=People,dc=example,dc=com',
      ])
    );
    expect(mocks.sessionStore.createSessionRpc).toHaveBeenCalledWith(
      'sess_directory',
      'user_generated',
      86400,
      expect.objectContaining({
        amr: ['pwd', 'directory'],
        directory_connector_id: 'campus',
        wordwarden_connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
        metadata: expect.stringContaining('"directory_source_decisions"'),
      })
    );
    expect(response.headers.get('set-cookie')).toContain('authrim_session=sess_directory');
    expect(body.redirect_url).toBe('/account');
  });

  it('creates a migration transaction instead of a session when passkey enrollment is required', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;

      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
    mocks.coreAdapter.query.mockResolvedValueOnce([
      {
        id: 'damc_1',
        tenant_id: 'tenant-a',
        name: 'Require passkey',
        description: null,
        status: 'active',
        mode: 'require_passkey_after_directory',
        passkey_prompt_mode: 'campaign_only',
        email_code_fallback_mode: 'migration_recovery',
        grace_period_days: 0,
        transaction_ttl_seconds: 600,
        enforcement_start_mode: 'first_directory_login',
        target_policy_json: JSON.stringify({ type: 'all' }),
        is_template: 0,
        created_by: 'admin-1',
        created_at: 1000,
        updated_at: 1000,
      },
    ]);
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({ user_id: 'user_generated' })
      .mockResolvedValueOnce(null);
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {},
            { auto_provision: true }
          ),
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.migration).toMatchObject({
      required: true,
      action: 'require_passkey',
      campaign_id: 'damc_1',
      state: 'passkey_required',
      reason: 'immediate',
      email_code_fallback_mode: 'migration_recovery',
      email_code_fallback_available: true,
      email_code_fallback: {
        transaction_id: expect.any(String),
        transaction_token: expect.any(String),
        expires_at: expect.any(Number),
        masked_email: 'al***@example.com',
      },
    });
    expect((body.migration as Record<string, unknown>).transaction_token).toEqual(
      expect.any(String)
    );
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_transactions'),
      expect.arrayContaining([
        'tenant-a',
        'damc_1',
        'user_generated',
        'wwcon_8K4M2Q9F7D3H6P1X',
        'uid=alice,ou=People,dc=example,dc=com',
        expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      ])
    );
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_transactions'),
      expect.arrayContaining(['email_code_fallback'])
    );
  });

  it('does not create an email-code fallback transaction when the campaign disables fallback', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;

      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
    mocks.coreAdapter.query.mockResolvedValueOnce([
      {
        id: 'damc_1',
        tenant_id: 'tenant-a',
        name: 'Require passkey',
        description: null,
        status: 'active',
        mode: 'require_passkey_after_directory',
        passkey_prompt_mode: 'campaign_only',
        email_code_fallback_mode: 'disabled',
        grace_period_days: 0,
        transaction_ttl_seconds: 600,
        enforcement_start_mode: 'first_directory_login',
        target_policy_json: JSON.stringify({ type: 'all' }),
        is_template: 0,
        created_by: 'admin-1',
        created_at: 1000,
        updated_at: 1000,
      },
    ]);
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({ user_id: 'user_generated' })
      .mockResolvedValueOnce(null);
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {},
            { auto_provision: true }
          ),
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.migration).toMatchObject({
      required: true,
      action: 'require_passkey',
      email_code_fallback_mode: 'disabled',
      email_code_fallback_available: false,
    });
    expect(
      mocks.coreAdapter.execute.mock.calls.some(([_sql, params]) =>
        Array.isArray(params) ? params.includes('email_code_fallback') : false
      )
    ).toBe(false);
  });

  it('requires a matching admin invitation before issuing invitation-only email fallback', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;

      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
    mocks.coreAdapter.query.mockResolvedValueOnce([
      {
        id: 'damc_1',
        tenant_id: 'tenant-a',
        name: 'Require passkey',
        description: null,
        status: 'active',
        mode: 'require_passkey_after_directory',
        passkey_prompt_mode: 'campaign_only',
        email_code_fallback_mode: 'admin_invitation_only',
        grace_period_days: 0,
        transaction_ttl_seconds: 600,
        enforcement_start_mode: 'first_directory_login',
        target_policy_json: JSON.stringify({ type: 'all' }),
        is_template: 0,
        created_by: 'admin-1',
        created_at: 1000,
        updated_at: 1000,
      },
    ]);
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({ user_id: 'user_generated' })
      .mockResolvedValueOnce(null);
    mocks.findActiveInvitationByToken.mockResolvedValueOnce({
      id: 'inv_1',
      token: 'invite-token',
      tenant_id: 'tenant-a',
      invited_email: 'alice@example.com',
      role_id: null,
      org_id: null,
      max_uses: 1,
      use_count: 0,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct', invite_token: 'invite-token' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {},
            { auto_provision: true }
          ),
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.migration).toMatchObject({
      email_code_fallback_mode: 'admin_invitation_only',
      email_code_fallback_available: true,
      email_code_fallback: {
        transaction_id: expect.any(String),
        transaction_token: expect.any(String),
        masked_email: 'al***@example.com',
      },
    });
    expect(mocks.findActiveInvitationByToken).toHaveBeenCalledWith(
      mocks.coreAdapter,
      'invite-token',
      expect.any(Number)
    );
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_transactions'),
      expect.arrayContaining(['email_code_fallback'])
    );
  });

  it('does not issue invitation-only email fallback for a mismatched invitation email', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;

      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        result: 'success',
        subject: {
          directory_id: 'uid=alice,ou=People,dc=example,dc=com',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
        },
        directory_status: 'ok',
      });
    });
    mocks.coreAdapter.query.mockResolvedValueOnce([
      {
        id: 'damc_1',
        tenant_id: 'tenant-a',
        name: 'Require passkey',
        description: null,
        status: 'active',
        mode: 'require_passkey_after_directory',
        passkey_prompt_mode: 'campaign_only',
        email_code_fallback_mode: 'admin_invitation_only',
        grace_period_days: 0,
        transaction_ttl_seconds: 600,
        enforcement_start_mode: 'first_directory_login',
        target_policy_json: JSON.stringify({ type: 'all' }),
        is_template: 0,
        created_by: 'admin-1',
        created_at: 1000,
        updated_at: 1000,
      },
    ]);
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({ user_id: 'user_generated' })
      .mockResolvedValueOnce(null);
    mocks.findActiveInvitationByToken.mockResolvedValueOnce({
      id: 'inv_1',
      token: 'invite-token',
      tenant_id: 'tenant-a',
      invited_email: 'bob@example.com',
      role_id: null,
      org_id: null,
      max_uses: 1,
      use_count: 0,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct', invite_token: 'invite-token' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {},
            { auto_provision: true }
          ),
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.migration).toMatchObject({
      email_code_fallback_mode: 'admin_invitation_only',
      email_code_fallback_available: false,
    });
    expect(
      mocks.coreAdapter.execute.mock.calls.some(([_sql, params]) =>
        Array.isArray(params) ? params.includes('email_code_fallback') : false
      )
    ).toBe(false);
  });

  it('treats an existing passkey as satisfying a required directory migration campaign', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;

      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        result: 'success',
        subject: {
          directory_id: 'uid=alice,ou=People,dc=example,dc=com',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
        },
        directory_status: 'ok',
      });
    });
    mocks.coreAdapter.query.mockResolvedValueOnce([
      {
        id: 'damc_1',
        tenant_id: 'tenant-a',
        name: 'Require passkey',
        description: null,
        status: 'active',
        mode: 'require_passkey_after_directory',
        passkey_prompt_mode: 'campaign_only',
        email_code_fallback_mode: 'migration_recovery',
        grace_period_days: 0,
        transaction_ttl_seconds: 600,
        enforcement_start_mode: 'first_directory_login',
        target_policy_json: JSON.stringify({ type: 'all' }),
        is_template: 0,
        created_by: 'admin-1',
        created_at: 1000,
        updated_at: 1000,
      },
    ]);
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({ user_id: 'user_generated' })
      .mockResolvedValueOnce(null);
    mocks.passkeyRepo.findByUserId.mockResolvedValueOnce([
      {
        id: 'pk_1',
        credential_id: 'credential-id',
        transports: ['internal'],
      },
    ]);
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {},
            { auto_provision: true }
          ),
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('migration');
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE directory_auth_migration_user_states'),
      expect.arrayContaining(['tenant-a', 'damc_1', 'user_generated'])
    );
    expect(mocks.coreAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_transactions'),
      expect.anything()
    );
    expect(mocks.sessionStore.createSessionRpc).toHaveBeenCalled();
  });

  it('creates passkey registration options for an active directory migration transaction', async () => {
    const tokenHash = await testMigrationTokenHash('tenant-a', 'migration-token');
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'damt_1',
      tenant_id: 'tenant-a',
      campaign_id: 'damc_1',
      user_id: 'user_generated',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: 'uid=alice,ou=People,dc=example,dc=com',
      token_hash: tokenHash,
      scope: 'passkey_enrollment',
      state: 'active',
      request_id: 'wwreq_1',
      authorization_challenge_id: null,
      created_at: 1000,
      updated_at: 1000,
      expires_at: Date.now() + 600_000,
      completed_at: null,
      blocked_reason: null,
    });

    const response = await directoryMigrationPasskeyOptionsHandler(
      createContext({
        transaction_id: 'damt_1',
        transaction_token: 'migration-token',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.challenge_id).toEqual(expect.any(String));
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'auth.example.com',
        userName: 'alice@example.com',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        type: 'directory_migration_passkey',
        userId: 'user_generated',
        challenge: 'webauthn-challenge',
        metadata: expect.objectContaining({
          transaction_id: 'damt_1',
          token_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          origin: 'https://auth.example.com',
          rpID: 'auth.example.com',
        }),
      })
    );
  });

  it('completes a directory migration passkey transaction and creates a session', async () => {
    const tokenHash = await testMigrationTokenHash('tenant-a', 'migration-token');
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'damt_1',
      tenant_id: 'tenant-a',
      campaign_id: 'damc_1',
      user_id: 'user_generated',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: 'uid=alice,ou=People,dc=example,dc=com',
      token_hash: tokenHash,
      scope: 'passkey_enrollment',
      state: 'active',
      request_id: 'wwreq_1',
      authorization_challenge_id: null,
      created_at: 1000,
      updated_at: 1000,
      expires_at: Date.now() + 600_000,
      completed_at: null,
      blocked_reason: null,
    });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      challenge: 'webauthn-challenge',
      userId: 'user_generated',
      metadata: {
        transaction_id: 'damt_1',
        token_hash: tokenHash,
        origin: 'https://auth.example.com',
        rpID: 'auth.example.com',
      },
    });

    const response = await directoryMigrationPasskeyVerifyHandler(
      createContext({
        transaction_id: 'damt_1',
        transaction_token: 'migration-token',
        challenge_id: 'challenge_1',
        credential: {
          id: 'credential-id',
          rawId: 'credential-id',
          response: {
            clientDataJSON: 'client',
            attestationObject: 'attestation',
            transports: ['internal'],
          },
          type: 'public-key',
          clientExtensionResults: {},
        },
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.session).toMatchObject({
      userId: 'user_generated',
      amr: ['pwd', 'directory', 'passkey'],
    });
    expect(mocks.passkeyRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user_generated',
        credential_id: 'AQID',
        public_key: 'BAUG',
        device_name: 'Directory Migration Passkey',
      })
    );
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET state = 'completed'"),
      expect.arrayContaining(['tenant-a', 'damt_1'])
    );
    expect(mocks.sessionStore.createSessionRpc).toHaveBeenCalledWith(
      'sess_directory',
      'user_generated',
      86400,
      expect.objectContaining({
        amr: ['pwd', 'directory', 'passkey'],
      }),
      'tenant-a'
    );
    expect(response.headers.get('set-cookie')).toContain('authrim_session=sess_directory');
    expect(JSON.stringify(mocks.coreAdapter.execute.mock.calls)).not.toContain('migration-token');
  });

  it('sends an email code for an active directory migration fallback transaction', async () => {
    const tokenHash = await testMigrationTokenHash('tenant-a', 'migration-email-token');
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'damt_email_1',
      tenant_id: 'tenant-a',
      campaign_id: 'damc_1',
      user_id: 'user_generated',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: 'uid=alice,ou=People,dc=example,dc=com',
      token_hash: tokenHash,
      scope: 'email_code_fallback',
      state: 'active',
      request_id: 'wwreq_1',
      authorization_challenge_id: null,
      created_at: 1000,
      updated_at: 1000,
      expires_at: Date.now() + 600_000,
      completed_at: null,
      blocked_reason: null,
    });

    const response = await directoryMigrationEmailCodeSendHandler(
      createContext({
        transaction_id: 'damt_email_1',
        transaction_token: 'migration-email-token',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      challenge_id: expect.any(String),
      masked_email: 'al***@example.com',
    });
    expect(mocks.rateLimiter.incrementRpc).toHaveBeenCalledWith('transaction:damt_email_1', {
      windowSeconds: 15 * 60,
      maxRequests: 3,
    });
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        type: 'directory_migration_email',
        userId: 'user_generated',
        email: 'alice@example.com',
        metadata: expect.objectContaining({
          transaction_id: 'damt_email_1',
          token_hash: tokenHash,
          purpose: 'directory_migration_email_fallback',
        }),
      })
    );
    expect(mocks.emailNotifier.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email',
        to: 'alice@example.com',
        subject: 'Your Authrim migration verification code',
      })
    );
  });

  it('sends a distinct email code for a directory unavailable recovery transaction', async () => {
    const tokenHash = await testMigrationTokenHash('tenant-a', 'recovery-email-token');
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'damt_recovery_1',
      tenant_id: 'tenant-a',
      campaign_id: 'damc_recovery',
      user_id: 'user_generated',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: null,
      token_hash: tokenHash,
      scope: 'recovery',
      state: 'active',
      request_id: 'directory_unavailable_recovery:wwreq_1',
      authorization_challenge_id: null,
      created_at: 1000,
      updated_at: 1000,
      expires_at: Date.now() + 600_000,
      completed_at: null,
      blocked_reason: null,
    });

    const response = await directoryMigrationEmailCodeSendHandler(
      createContext({
        transaction_id: 'damt_recovery_1',
        transaction_token: 'recovery-email-token',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      challenge_id: expect.any(String),
      masked_email: 'al***@example.com',
    });
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        type: 'directory_migration_email',
        userId: 'user_generated',
        email: 'alice@example.com',
        metadata: expect.objectContaining({
          transaction_id: 'damt_recovery_1',
          token_hash: tokenHash,
          purpose: 'directory_unavailable_recovery_email_code',
        }),
      })
    );
    expect(mocks.emailNotifier.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email',
        to: 'alice@example.com',
        subject: 'Your Authrim directory recovery code',
      })
    );
  });

  it('does not call a provider when no materialized provider order is configured', async () => {
    const tokenHash = await testMigrationTokenHash('tenant-a', 'migration-email-token');
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'damt_email_1',
      tenant_id: 'tenant-a',
      campaign_id: 'damc_1',
      user_id: 'user_generated',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: 'uid=alice,ou=People,dc=example,dc=com',
      token_hash: tokenHash,
      scope: 'email_code_fallback',
      state: 'active',
      request_id: 'wwreq_1',
      authorization_challenge_id: null,
      created_at: 1000,
      updated_at: 1000,
      expires_at: Date.now() + 600_000,
      completed_at: null,
      blocked_reason: null,
    });
    mocks.emailNotifierEnabled = false;

    const response = await directoryMigrationEmailCodeSendHandler(
      createContext({
        transaction_id: 'damt_email_1',
        transaction_token: 'migration-email-token',
      }) as never
    );

    expect(response.status).toBe(500);
    // The undisclosed, TTL-bound challenge is committed before any provider execution.
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledOnce();
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
  });

  it('verifies a directory migration email code and creates a session', async () => {
    const tokenHash = await testMigrationTokenHash('tenant-a', 'migration-email-token');
    const issuedAt = 123456;
    const challengeHash = await hashEmailCode(
      '123456',
      'alice@example.com',
      'email_challenge_1',
      issuedAt,
      'otp-secret'
    );
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'damt_email_1',
      tenant_id: 'tenant-a',
      campaign_id: 'damc_1',
      user_id: 'user_generated',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: 'uid=alice,ou=People,dc=example,dc=com',
      token_hash: tokenHash,
      scope: 'email_code_fallback',
      state: 'active',
      request_id: 'wwreq_1',
      authorization_challenge_id: null,
      created_at: 1000,
      updated_at: 1000,
      expires_at: Date.now() + 600_000,
      completed_at: null,
      blocked_reason: null,
    });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      challenge: challengeHash,
      userId: 'user_generated',
      email: 'alice@example.com',
      metadata: {
        transaction_id: 'damt_email_1',
        token_hash: tokenHash,
        issued_at: issuedAt,
        purpose: 'directory_migration_email_fallback',
      },
    });

    const response = await directoryMigrationEmailCodeVerifyHandler(
      createContext({
        transaction_id: 'damt_email_1',
        transaction_token: 'migration-email-token',
        challenge_id: 'email_challenge_1',
        code: '123456',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.session).toMatchObject({
      userId: 'user_generated',
      amr: ['pwd', 'directory', 'otp'],
    });
    expect(mocks.completeDirectoryAuthEmailCodeFallback).toHaveBeenCalledWith(
      mocks.coreAdapter,
      expect.objectContaining({
        tenantId: 'tenant-a',
        transactionId: 'damt_email_1',
        campaignId: 'damc_1',
        userId: 'user_generated',
        requestId: 'wwreq_1',
      })
    );
    expect(mocks.sessionStore.createSessionRpc).toHaveBeenCalledWith(
      'sess_directory',
      'user_generated',
      86400,
      expect.objectContaining({
        amr: ['pwd', 'directory', 'otp'],
      }),
      'tenant-a'
    );
    expect(JSON.stringify(mocks.coreAdapter.execute.mock.calls)).not.toContain(
      'migration-email-token'
    );
  });

  it('verifies a directory unavailable recovery email code without password AMR', async () => {
    const tokenHash = await testMigrationTokenHash('tenant-a', 'recovery-email-token');
    const issuedAt = 123456;
    const challengeHash = await hashEmailCode(
      '123456',
      'alice@example.com',
      'email_challenge_1',
      issuedAt,
      'otp-secret'
    );
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'damt_recovery_1',
      tenant_id: 'tenant-a',
      campaign_id: 'damc_recovery',
      user_id: 'user_generated',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: null,
      token_hash: tokenHash,
      scope: 'recovery',
      state: 'active',
      request_id: 'directory_unavailable_recovery:wwreq_1',
      authorization_challenge_id: null,
      created_at: 1000,
      updated_at: 1000,
      expires_at: Date.now() + 600_000,
      completed_at: null,
      blocked_reason: null,
    });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      challenge: challengeHash,
      userId: 'user_generated',
      email: 'alice@example.com',
      metadata: {
        transaction_id: 'damt_recovery_1',
        token_hash: tokenHash,
        issued_at: issuedAt,
        purpose: 'directory_unavailable_recovery_email_code',
      },
    });

    const response = await directoryMigrationEmailCodeVerifyHandler(
      createContext({
        transaction_id: 'damt_recovery_1',
        transaction_token: 'recovery-email-token',
        challenge_id: 'email_challenge_1',
        code: '123456',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.session).toMatchObject({
      userId: 'user_generated',
      amr: ['directory', 'otp'],
    });
    expect(mocks.completeDirectoryAuthEmailCodeFallback).toHaveBeenCalledWith(
      mocks.coreAdapter,
      expect.objectContaining({
        tenantId: 'tenant-a',
        transactionId: 'damt_recovery_1',
        campaignId: 'damc_recovery',
        userId: 'user_generated',
        requestId: 'directory_unavailable_recovery:wwreq_1',
        scope: 'recovery',
      })
    );
    expect(mocks.sessionStore.createSessionRpc).toHaveBeenCalledWith(
      'sess_directory',
      'user_generated',
      86400,
      expect.objectContaining({
        amr: ['directory', 'otp'],
      }),
      'tenant-a'
    );
  });

  it('rejects an invalid directory migration email code without creating a session', async () => {
    const tokenHash = await testMigrationTokenHash('tenant-a', 'migration-email-token');
    const issuedAt = 123456;
    const challengeHash = await hashEmailCode(
      '123456',
      'alice@example.com',
      'email_challenge_1',
      issuedAt,
      'otp-secret'
    );
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'damt_email_1',
      tenant_id: 'tenant-a',
      campaign_id: 'damc_1',
      user_id: 'user_generated',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: 'uid=alice,ou=People,dc=example,dc=com',
      token_hash: tokenHash,
      scope: 'email_code_fallback',
      state: 'active',
      request_id: 'wwreq_1',
      authorization_challenge_id: null,
      created_at: 1000,
      updated_at: 1000,
      expires_at: Date.now() + 600_000,
      completed_at: null,
      blocked_reason: null,
    });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      challenge: challengeHash,
      userId: 'user_generated',
      email: 'alice@example.com',
      metadata: {
        transaction_id: 'damt_email_1',
        token_hash: tokenHash,
        issued_at: issuedAt,
        purpose: 'directory_migration_email_fallback',
      },
    });

    const response = await directoryMigrationEmailCodeVerifyHandler(
      createContext({
        transaction_id: 'damt_email_1',
        transaction_token: 'migration-email-token',
        challenge_id: 'email_challenge_1',
        code: '654321',
      }) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
    expect(mocks.completeDirectoryAuthEmailCodeFallback).not.toHaveBeenCalled();
  });

  it('does not complete an email-code fallback transaction when the user was deactivated', async () => {
    const tokenHash = await testMigrationTokenHash('tenant-a', 'migration-email-token');
    const issuedAt = 123456;
    const challengeHash = await hashEmailCode(
      '123456',
      'alice@example.com',
      'email_challenge_1',
      issuedAt,
      'otp-secret'
    );
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'damt_email_1',
      tenant_id: 'tenant-a',
      campaign_id: 'damc_1',
      user_id: 'user_generated',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: 'uid=alice,ou=People,dc=example,dc=com',
      token_hash: tokenHash,
      scope: 'email_code_fallback',
      state: 'active',
      request_id: 'wwreq_1',
      authorization_challenge_id: null,
      created_at: 1000,
      updated_at: 1000,
      expires_at: Date.now() + 600_000,
      completed_at: null,
      blocked_reason: null,
    });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      challenge: challengeHash,
      userId: 'user_generated',
      email: 'alice@example.com',
      metadata: {
        transaction_id: 'damt_email_1',
        token_hash: tokenHash,
        issued_at: issuedAt,
        purpose: 'directory_migration_email_fallback',
      },
    });
    mocks.findById.mockResolvedValueOnce({
      id: 'user_generated',
      email: 'alice@example.com',
      name: 'Alice Example',
      active: 0,
    });

    const response = await directoryMigrationEmailCodeVerifyHandler(
      createContext({
        transaction_id: 'damt_email_1',
        transaction_token: 'migration-email-token',
        challenge_id: 'email_challenge_1',
        code: '123456',
      }) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
    expect(mocks.completeDirectoryAuthEmailCodeFallback).not.toHaveBeenCalled();
  });

  it('verifies credentials through the relay transport and creates an Authrim session', async () => {
    const relayFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        username: 'alice',
        password: 'correct',
        attribute_names: ['mail', 'displayName'],
      });

      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
    const relay = {
      idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
      get: vi.fn(() => ({ fetch: relayFetch }) as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace;
    const handler = createDirectoryPasswordLoginHandler();

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {
              transport: 'relay',
              endpoint_url: '',
            },
            { auto_provision: true }
          ),
        },
        {},
        {
          DIRECTORY_CONNECTOR_RELAY: relay,
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(relay.idFromName).toHaveBeenCalledWith('tenant-a:wwcon_8K4M2Q9F7D3H6P1X');
    expect(mocks.sessionStore.createSessionRpc).toHaveBeenCalledWith(
      'sess_directory',
      'user_generated',
      86400,
      expect.objectContaining({
        directory_connector_id: 'campus',
      }),
      'tenant-a'
    );
  });

  it('returns configured post-login redirect after direct directory password login', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        ok: true,
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {},
            { auto_provision: true }
          ),
          'settings:tenant:tenant-a:login-entry': {
            'login-entry.post_login_behavior': 'custom_url',
            'login-entry.post_login_redirect_url': '/mypage',
          },
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.redirect_url).toBe('/mypage');
  });

  it('returns 401 without creating a session when Wordwarden rejects credentials', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
          usernameHash: expect.any(String),
        }),
      })
    );
    expect(JSON.stringify(mocks.publishEvent.mock.calls)).not.toContain('alice');
    expect(mocks.rateLimiter.incrementRpc).toHaveBeenCalledWith(
      expect.stringMatching(/^account:[a-f0-9]{64}$/),
      { windowSeconds: 900, maxRequests: 5 }
    );
  });

  it('atomically blocks an exhausted account before contacting the directory connector', async () => {
    mocks.rateLimiter.incrementRpc.mockResolvedValueOnce({
      allowed: false,
      retryAfter: 300,
    });
    const fetcher = vi.fn();
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext({ username: 'Alice', password: 'guessed-password' }) as never
    );

    expect(response.status).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.rateLimiter.incrementRpc).toHaveBeenCalledWith(
      expect.stringMatching(/^account:[a-f0-9]{64}$/),
      { windowSeconds: 900, maxRequests: 5 }
    );
  });

  it('limits a concurrent password-guess burst before connector verification', async () => {
    let attemptCount = 0;
    mocks.rateLimiter.incrementRpc.mockImplementation(async () => {
      attemptCount += 1;
      return {
        allowed: attemptCount <= 5,
        retryAfter: attemptCount <= 5 ? 0 : 300,
      };
    });
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        result: 'failure',
        reason: 'invalid_credentials',
        directory_status: 'ok',
      });
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        handler(
          createContext({ username: 'alice', password: `guessed-password-${index}` }) as never
        )
      )
    );

    expect(responses.map((response) => response.status).sort()).toEqual([
      401, 401, 401, 401, 401, 429,
    ]);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('does not create a session for policy-required directory verdicts', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
          usernameHash: expect.any(String),
        }),
      })
    );
    expect(JSON.stringify(mocks.publishEvent.mock.calls)).not.toContain('alice');
  });

  it('returns a generic connector error and publishes a failure event when Wordwarden is unavailable', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json(
        {
          request_id: body.request_id,
          tenant_id: 'tenant-a',
          connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
          usernameHash: expect.any(String),
        }),
      })
    );
    expect(JSON.stringify(mocks.publishEvent.mock.calls)).not.toContain('alice');
  });

  it('starts directory unavailable recovery only for an existing linked email user', async () => {
    mocks.findByEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'alice@example.com',
      name: 'Alice Existing',
      active: 1,
    });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({ id: 'dil_1' });
    mocks.coreAdapter.query.mockResolvedValueOnce([
      {
        id: 'damc_recovery',
        tenant_id: 'tenant-a',
        name: 'Directory unavailable recovery',
        description: null,
        status: 'active',
        mode: 'directory_login_allowed',
        passkey_prompt_mode: 'none',
        email_code_fallback_mode: 'directory_unavailable_recovery',
        grace_period_days: 0,
        transaction_ttl_seconds: 600,
        enforcement_start_mode: 'first_directory_login',
        target_policy_json: JSON.stringify({ type: 'all' }),
        is_template: 0,
        created_by: 'admin-1',
        created_at: 1000,
        updated_at: 1000,
      },
    ]);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json(
        {
          request_id: body.request_id,
          tenant_id: 'tenant-a',
          connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
      createContext({ username: 'alice@example.com', password: 'correct' }) as never
    );
    const body = (await response.json()) as {
      ok: false;
      recovery: {
        required: boolean;
        reason: string;
        transaction_id: string;
        transaction_token: string;
        masked_email: string;
      };
      user: { id: string; email: string };
    };

    expect(response.status).toBe(200);
    expect(body.recovery).toMatchObject({
      required: true,
      reason: 'directory_unavailable',
      masked_email: 'al***@example.com',
    });
    expect(body.user).toMatchObject({ id: 'user_existing', email: 'alice@example.com' });
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
    expect(mocks.coreAdapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM directory_identity_links'),
      ['tenant-a', 'wwcon_8K4M2Q9F7D3H6P1X', 'user_existing']
    );
    expect(mocks.coreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining("email_code_fallback_mode IN (?, 'tenant_default')"),
      ['tenant-a', 'directory_unavailable_recovery']
    );
    expect(mocks.rateLimiter.incrementRpc).toHaveBeenCalledWith(
      'user:wwcon_8K4M2Q9F7D3H6P1X:user_existing',
      {
        windowSeconds: 15 * 60,
        maxRequests: 3,
      }
    );
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_transactions'),
      expect.arrayContaining(['tenant-a', 'damc_recovery', 'user_existing', 'recovery'])
    );
  });

  it('rate limits directory unavailable recovery transaction creation per linked user', async () => {
    mocks.findByEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'alice@example.com',
      name: 'Alice Existing',
      active: 1,
    });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({ id: 'dil_1' });
    mocks.coreAdapter.query.mockResolvedValueOnce([
      {
        id: 'damc_recovery',
        tenant_id: 'tenant-a',
        name: 'Directory unavailable recovery',
        description: null,
        status: 'active',
        mode: 'directory_login_allowed',
        passkey_prompt_mode: 'none',
        email_code_fallback_mode: 'directory_unavailable_recovery',
        grace_period_days: 0,
        transaction_ttl_seconds: 600,
        enforcement_start_mode: 'first_directory_login',
        target_policy_json: JSON.stringify({ type: 'all' }),
        is_template: 0,
        created_by: 'admin-1',
        created_at: 1000,
        updated_at: 1000,
      },
    ]);
    mocks.rateLimiter.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 60 });
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json(
        {
          request_id: body.request_id,
          tenant_id: 'tenant-a',
          connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
      createContext({ username: 'alice@example.com', password: 'correct' }) as never
    );

    expect(response.status).toBe(429);
    expect(mocks.coreAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_transactions'),
      expect.anything()
    );
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('does not start directory unavailable recovery for non-email usernames', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json(
        {
          request_id: body.request_id,
          tenant_id: 'tenant-a',
          connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
    expect(mocks.findByEmail).not.toHaveBeenCalled();
    expect(mocks.coreAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_auth_migration_transactions'),
      expect.anything()
    );
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('returns unmapped when a directory identity has no Authrim user and auto provision is disabled', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValue(null);
    mocks.findByEmail.mockResolvedValue(null);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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

  it('links a first directory login to an existing Authrim user by unique email match', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValue(null);
    mocks.findByEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'alice@example.com',
      name: 'Alice Existing',
    });
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        result: 'success',
        subject: {
          directory_id: 'objectguid-base64url',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
          displayName: ['Alice Example'],
        },
        group_facts: [
          {
            id: 'staff',
            dn: 'cn=staff,ou=Groups,dc=example,dc=com',
            display: 'Staff',
            source: 'memberOf',
            depth: 1,
          },
        ],
        directory_status: 'ok',
      });
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext({ username: 'alice', password: 'correct' }) as never
    );

    expect(response.status).toBe(200);
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_identity_links'),
      expect.arrayContaining([
        'tenant-a',
        'wwcon_8K4M2Q9F7D3H6P1X',
        'objectguid-base64url',
        'user_existing',
      ])
    );
    const params = mocks.coreAdapter.execute.mock.calls[0]?.[1] as unknown[];
    expect(String(params[5])).toContain('"groups"');
    expect(String(params[5])).toContain('"staff"');
    expect(String(params[5])).toContain('"source_decisions"');
    expect(String(params[5])).toContain('"allowlisted_directory_attribute"');
    expect(mocks.sessionStore.createSessionRpc).toHaveBeenCalledWith(
      'sess_directory',
      'user_existing',
      86400,
      expect.anything(),
      'tenant-a'
    );
  });

  it('creates a pending JIT record instead of a session when auto provision is enabled', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValue(null);
    mocks.findByEmail.mockResolvedValue(null);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        result: 'success',
        subject: {
          directory_id: 'objectguid-base64url',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
        },
        directory_status: 'ok',
      });
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {},
            { auto_provision: true }
          ),
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.error).toBe('directory_provisioning_pending');
    expect(mocks.syncUser).not.toHaveBeenCalled();
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_jit_pending_users'),
      expect.arrayContaining([
        'tenant-a',
        'wwcon_8K4M2Q9F7D3H6P1X',
        'objectguid-base64url',
        'alice@example.com',
      ])
    );
  });

  it('fails closed when pending creation loses a state race', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValue(null);
    mocks.coreAdapter.execute.mockResolvedValue({ rowsAffected: 0, success: true });
    mocks.findByEmail.mockResolvedValue(null);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        result: 'success',
        subject: {
          directory_id: 'objectguid-base64url',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
        },
        directory_status: 'ok',
      });
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {},
            { auto_provision: true }
          ),
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body.error).toBe('directory_identity_unmapped');
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'auth.directory_password.failed',
        data: expect.objectContaining({
          errorCode: 'directory_pending_state_conflict',
        }),
      })
    );
  });

  it('does not use a connector config with a mutable connector id as the Wordwarden id', async () => {
    const fetcher = vi.fn();
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors({
            connector_id: 'campus',
          }),
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body.error).toBe('directory_password_not_configured');
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('does not recreate pending access for a rejected directory subject', async () => {
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'rejected' });
    mocks.findByEmail.mockResolvedValue(null);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        result: 'success',
        subject: {
          directory_id: 'objectguid-base64url',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
        },
        directory_status: 'ok',
      });
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {},
            { auto_provision: true }
          ),
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body.error).toBe('directory_identity_unmapped');
    expect(mocks.coreAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_jit_pending_users'),
      expect.anything()
    );
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('fails closed when an existing directory subject link points to a missing user', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValue({ user_id: 'user_deleted' });
    mocks.findById.mockResolvedValue(null);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        result: 'success',
        subject: {
          directory_id: 'objectguid-base64url',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
        },
        directory_status: 'ok',
      });
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {},
            { auto_provision: true }
          ),
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body.error).toBe('directory_identity_unmapped');
    expect(mocks.findByEmail).not.toHaveBeenCalled();
    expect(mocks.coreAdapter.execute).not.toHaveBeenCalled();
    expect(mocks.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('continues an authorization challenge after successful directory password login', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
    mocks.coreAdapter.queryOne.mockResolvedValue(null);
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
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      tenantId: 'tenant-a',
      type: 'login',
      challenge: 'login_challenge',
    });
    mocks.getChallengeStoreByChallengeId
      .mockResolvedValueOnce(mocks.challengeStore)
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
    const redirectUrl = new URL(body.redirect_url!);
    expect([...redirectUrl.searchParams.keys()]).toEqual(['_confirmation_challenge']);
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

  it('prefers SETTINGS for directory connectors over stale AUTHRIM_CONFIG values', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(String(url)).toBe('https://wordwarden-current.example.com/v1/auth/verify-password');
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        result: 'success',
        subject: {
          directory_id: 'uid=alice,ou=People,dc=example,dc=com',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
        },
        directory_status: 'ok',
      });
    });
    const handler = createDirectoryPasswordLoginHandler(fetcher);

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {
              endpoint_url: 'https://wordwarden-current.example.com',
            },
            { auto_provision: true }
          ),
        },
        {
          'settings:tenant:tenant-a:directory-connectors': {
            connectors: [
              {
                id: 'campus',
                endpoint_url: 'https://wordwarden-stale.example.com',
                auth_mode: 'mtls',
                connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
                key_id: 'kid-stale',
                secret_ref: 'env:WORDWARDEN_SECRET',
              },
            ],
          },
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('returns 404 when the tenant has not enabled directory password login', async () => {
    const handler = createDirectoryPasswordLoginHandler(vi.fn());

    const response = await handler(
      createContext(
        { username: 'alice', password: 'correct' },
        {
          'settings:tenant:tenant-a:directory-connectors': directoryConnectors(
            {},
            { enabled: false }
          ),
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
            enabled: true,
            default_connector_id: 'campus',
            auto_provision: false,
            connectors: [
              {
                id: 'campus',
                endpoint_url: 'https://wordwarden.example.com',
                auth_mode: 'mtls',
                connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
                key_id: 'kid-active',
                secret_ref: 'env:WORDWARDEN_SECRET',
              },
            ],
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
            enabled: true,
            default_connector_id: 'campus',
            auto_provision: false,
            connectors: [
              {
                id: 'campus',
                endpoint_url: 'https://wordwarden.example.com',
                auth_mode: 'hmac',
                connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
                key_id: 'kid-active',
                secret_ref: 'env:UNRELATED_SECRET',
              },
            ],
          },
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body.error).toBe('directory_password_not_configured');
  });
});
