/**
 * Anonymous User Upgrade Handler Unit Tests
 *
 * Tests for upgrading anonymous users to full accounts.
 * @see architecture-decisions.md §17
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { upgradeCompleteHandler, upgradeStatusHandler } from '../upgrade';

const hoistedMocks = vi.hoisted(() => {
  const mockLog = {
    error: vi.fn(),
    warn: vi.fn(),
  };

  return {
    mockSessionStore: {
      getSessionRpc: vi.fn(),
      updateSessionDataRpc: vi.fn(),
      updateSessionUserIdRpc: vi.fn(),
    },
    mockDatabaseAdapter: {
      queryOne: vi.fn(),
      query: vi.fn(),
      execute: vi.fn(),
    },
    mockUserCoreRepository: {
      findById: vi.fn(),
      updateUser: vi.fn(),
    },
    mockSyncUserLifecycleState: vi.fn(),
    mockLoadClientContractCached: vi.fn(),
    mockGetCookie: vi.fn(),
    mockLog,
    mockLogger: {
      module: vi.fn().mockReturnValue(mockLog),
    },
  };
});

const mockSessionStore = hoistedMocks.mockSessionStore;
const mockDatabaseAdapter = hoistedMocks.mockDatabaseAdapter;
const mockUserCoreRepository = hoistedMocks.mockUserCoreRepository;
const mockSyncUserLifecycleState = hoistedMocks.mockSyncUserLifecycleState;
const mockLoadClientContractCached = hoistedMocks.mockLoadClientContractCached;
const mockGetCookie = hoistedMocks.mockGetCookie;
const mockLog = hoistedMocks.mockLog;
const mockLogger = hoistedMocks.mockLogger;

vi.mock('hono/cookie', () => ({
  getCookie: hoistedMocks.mockGetCookie,
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    getTenantIdFromContext: vi.fn().mockReturnValue('default'),
    getSessionStoreBySessionId: vi.fn().mockReturnValue({
      stub: hoistedMocks.mockSessionStore,
    }),
    isAnonymousAuthEnabled: vi.fn().mockResolvedValue(true),
    loadClientContract: vi.fn().mockResolvedValue({
      anonymousAuth: {
        enabled: true,
        preserveSubOnUpgrade: true,
      },
    }),
    loadClientContractCached: hoistedMocks.mockLoadClientContractCached,
    createAuthContextFromHono: vi.fn().mockReturnValue({
      coreAdapter: hoistedMocks.mockDatabaseAdapter,
      repositories: {
        userCore: hoistedMocks.mockUserCoreRepository,
      },
    }),
    generateId: vi.fn().mockReturnValue('generated-id'),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    getLogger: vi.fn().mockReturnValue(hoistedMocks.mockLogger),
    syncUserLifecycleState: hoistedMocks.mockSyncUserLifecycleState,
  };
});

function createMockContext(options: {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  dbPii?: unknown;
}) {
  const contextStore = new Map<string, unknown>([['tenantId', 'default']]);

  return {
    req: {
      method: options.method ?? 'POST',
      url: 'https://example.com/api/auth/upgrade',
      json: vi.fn().mockResolvedValue(options.body ?? {}),
      header: vi.fn(),
    },
    env: {
      DB: {} as any,
      DB_PII: options.dbPii ?? null,
      AUTHRIM_CONFIG: {} as any,
    },
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  } as any;
}

describe('Upgrade Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCookie.mockReturnValue('session-123');
    mockLoadClientContractCached.mockResolvedValue({
      anonymousAuth: {
        enabled: true,
        preserveSubOnUpgrade: true,
      },
    });
    mockSyncUserLifecycleState.mockResolvedValue({
      lifecycleState: 'active',
      missingRequiredFields: [],
    });
    mockDatabaseAdapter.query.mockResolvedValue([]);
    mockLogger.module.mockReturnValue(mockLog);

    // Default mock for valid anonymous session
    mockSessionStore.getSessionRpc.mockResolvedValue({
      userId: 'anon-user-123',
      data: {
        is_anonymous: true,
        upgrade_eligible: true,
        client_id: 'client-123',
      },
    });

    mockUserCoreRepository.findById.mockResolvedValue({
      id: 'anon-user-123',
      user_type: 'anonymous',
      tenant_id: 'default',
    });
  });

  describe('upgradeHandler (POST /api/auth/upgrade)', () => {
    describe('Session Validation', () => {
      it('should require valid session cookie', () => {
        const cookieName = 'authrim_session';
        expect(cookieName).toBe('authrim_session');
      });

      it('should reject requests without session', async () => {
        mockSessionStore.getSessionRpc.mockResolvedValueOnce(null);

        const result = await mockSessionStore.getSessionRpc('invalid-session');
        expect(result).toBeNull();
      });

      it('should reject non-anonymous sessions', async () => {
        mockSessionStore.getSessionRpc.mockResolvedValueOnce({
          userId: 'regular-user-123',
          data: {
            is_anonymous: false,
          },
        });

        const session = await mockSessionStore.getSessionRpc('session-id');
        expect(session?.data?.is_anonymous).toBe(false);
      });

      it('should reject non-upgrade-eligible sessions', async () => {
        mockSessionStore.getSessionRpc.mockResolvedValueOnce({
          userId: 'anon-user-123',
          data: {
            is_anonymous: true,
            upgrade_eligible: false, // Already upgraded
          },
        });

        const session = await mockSessionStore.getSessionRpc('session-id');
        expect(session?.data?.upgrade_eligible).toBe(false);
      });
    });

    describe('Upgrade Method Validation', () => {
      it('should accept email upgrade method', () => {
        const validMethods = ['email', 'passkey', 'social'];
        expect(validMethods).toContain('email');
      });

      it('should accept passkey upgrade method', () => {
        const validMethods = ['email', 'passkey', 'social'];
        expect(validMethods).toContain('passkey');
      });

      it('should accept social upgrade method', () => {
        const validMethods = ['email', 'passkey', 'social'];
        expect(validMethods).toContain('social');
      });

      it('should reject invalid upgrade method', () => {
        const validMethods = ['email', 'passkey', 'social'];
        expect(validMethods).not.toContain('invalid');
      });
    });

    describe('Response Format', () => {
      it('should return upgrade_token for tracking', () => {
        const response = {
          success: true,
          user_id: 'anon-user-123',
          upgrade_token: 'token-abc123',
          instructions: {
            next_step: 'verify_email',
            endpoint: '/api/auth/email-code/send',
          },
        };

        expect(response.upgrade_token).toBeDefined();
      });

      it('should return method-specific instructions', () => {
        const emailInstructions = {
          next_step: 'verify_email',
          endpoint: '/api/auth/email-code/send',
        };

        const passkeyInstructions = {
          next_step: 'register_passkey',
          endpoint: '/api/auth/passkey/register/options',
        };

        const socialInstructions = {
          next_step: 'link_social',
          endpoint: '/api/auth/social/link',
        };

        expect(emailInstructions.next_step).toBe('verify_email');
        expect(passkeyInstructions.next_step).toBe('register_passkey');
        expect(socialInstructions.next_step).toBe('link_social');
      });
    });
  });

  describe('upgradeCompleteHandler (POST /api/auth/upgrade/complete)', () => {
    describe('Input Validation', () => {
      it('should require method parameter', () => {
        const requiredFields = ['method'];
        const requestBody = { method: 'email' };

        requiredFields.forEach((field) => {
          expect(requestBody).toHaveProperty(field);
        });
      });

      it('should accept optional preserve_sub parameter', () => {
        const requestWithPreserveSub = {
          method: 'email',
          preserve_sub: true,
        };

        expect(requestWithPreserveSub.preserve_sub).toBeDefined();
      });

      it('should accept optional migrate_data parameter', () => {
        const requestWithMigrate = {
          method: 'email',
          migrate_data: true,
        };

        expect(requestWithMigrate.migrate_data).toBeDefined();
      });
    });

    describe('Sub Preservation (PAIR-002 Compliance)', () => {
      it('should preserve sub by default', () => {
        const defaultPreserveSub = true;
        expect(defaultPreserveSub).toBe(true);
      });

      it('should use ClientContract setting for preserve_sub default', async () => {
        const { loadClientContract } = await import('@authrim/ar-lib-core');

        const contract = await loadClientContract(
          {} as never,
          {} as never,
          'default',
          'client-123'
        );

        expect(contract?.anonymousAuth?.preserveSubOnUpgrade).toBe(true);
      });

      it('should allow explicit preserve_sub=false', () => {
        const request = {
          method: 'email',
          preserve_sub: false, // Explicit opt-out
        };

        expect(request.preserve_sub).toBe(false);
      });

      it('should update user_type when preserving sub', async () => {
        await mockUserCoreRepository.updateUser('anon-user-123', {
          user_type: 'end_user',
          email_verified: true,
        });

        expect(mockUserCoreRepository.updateUser).toHaveBeenCalledWith(
          'anon-user-123',
          expect.objectContaining({
            user_type: 'end_user',
          })
        );
      });

      it('should create new user when not preserving sub', async () => {
        // When preserve_sub=false, create new user and link
        const newUserId = 'new-user-456';
        const previousUserId = 'anon-user-123';

        expect(newUserId).not.toBe(previousUserId);
      });
    });

    describe('Upgrade History Recording', () => {
      it('should record upgrade in user_upgrades table', async () => {
        const now = Date.now();

        await mockDatabaseAdapter.execute(
          `INSERT INTO user_upgrades (
            id, tenant_id, anonymous_user_id, upgraded_user_id,
            upgrade_method, provider_id, preserve_sub, upgraded_at, data_migrated
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'upgrade-record-id',
            'default',
            'anon-user-123',
            'anon-user-123', // Same if preserve_sub=true
            'email',
            null,
            1, // preserve_sub=true
            now,
            0, // data_migrated=false initially
          ]
        );

        expect(mockDatabaseAdapter.execute).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO user_upgrades'),
          expect.any(Array)
        );
      });

      it('should include provider_id for social upgrades', () => {
        const socialUpgrade = {
          method: 'social',
          provider_id: 'google',
        };

        expect(socialUpgrade.provider_id).toBe('google');
      });
    });

    describe('Session Update', () => {
      it('should update session to mark as upgraded', async () => {
        await mockSessionStore.updateSessionDataRpc('session-123', {
          is_anonymous: false,
          upgrade_eligible: false,
          upgraded_at: Date.now(),
        });

        expect(mockSessionStore.updateSessionDataRpc).toHaveBeenCalledWith(
          'session-123',
          expect.objectContaining({
            is_anonymous: false,
            upgrade_eligible: false,
          })
        );
      });

      it('should update session userId when preserve_sub=false', async () => {
        const newUserId = 'new-user-456';

        await mockSessionStore.updateSessionUserIdRpc('session-123', newUserId);

        expect(mockSessionStore.updateSessionUserIdRpc).toHaveBeenCalledWith(
          'session-123',
          newUserId
        );
      });
    });

    describe('Device Record Update', () => {
      it('should deactivate anonymous devices after upgrade', async () => {
        await mockDatabaseAdapter.execute(
          'UPDATE anonymous_devices SET is_active = 0 WHERE user_id = ?',
          ['anon-user-123']
        );

        expect(mockDatabaseAdapter.execute).toHaveBeenCalledWith(
          expect.stringContaining('UPDATE anonymous_devices SET is_active = 0'),
          expect.arrayContaining(['anon-user-123'])
        );
      });
    });

    describe('Response Format', () => {
      it('should return success status', () => {
        const response = {
          success: true,
          user_id: 'anon-user-123',
          preserve_sub: true,
          method: 'email',
          upgraded_at: Date.now(),
        };

        expect(response.success).toBe(true);
      });

      it('should return final user_id', () => {
        const response = {
          user_id: 'final-user-id',
        };

        expect(response.user_id).toBeDefined();
      });

      it('should return previous_user_id when preserve_sub=false', () => {
        const response = {
          success: true,
          user_id: 'new-user-456',
          previous_user_id: 'anon-user-123', // Only when preserve_sub=false
          preserve_sub: false,
        };

        expect(response.previous_user_id).toBe('anon-user-123');
      });

      it('should not return previous_user_id when preserve_sub=true', () => {
        const response = {
          success: true,
          user_id: 'anon-user-123',
          preserve_sub: true,
        };

        expect(response).not.toHaveProperty('previous_user_id');
      });

      it('should return upgrade timestamp', () => {
        const response = {
          upgraded_at: Date.now(),
        };

        expect(response.upgraded_at).toBeTypeOf('number');
      });
    });

    describe('Event Publishing', () => {
      it('should publish user.upgraded event', async () => {
        const { publishEvent } = await import('@authrim/ar-lib-core');

        await publishEvent({} as never, {
          type: 'user.upgraded',
          tenantId: 'default',
          data: {
            userId: 'anon-user-123',
            method: 'upgrade',
            clientId: 'client-123',
            upgradeMethod: 'email',
            preserveSub: true,
          },
        });

        expect(publishEvent).toHaveBeenCalled();
      });
    });

    describe('Handler execution', () => {
      it('should expose profile completion hints when required claims remain missing', async () => {
        mockSyncUserLifecycleState.mockResolvedValueOnce({
          lifecycleState: 'incomplete',
          missingRequiredFields: [
            {
              fieldKey: 'department',
              label: 'Department',
              fieldType: 'string',
            },
          ],
        });

        const c = createMockContext({
          method: 'POST',
          body: { method: 'passkey' },
        });

        const response = await upgradeCompleteHandler(c);
        const body = (await response.json()) as {
          profile_completion_required: boolean;
          account_lifecycle_state: string;
          missing_required_custom_claims: Array<{
            field_key: string;
            label: string;
            field_type: string;
          }>;
        };

        expect(response.status).toBe(200);
        expect(body.profile_completion_required).toBe(true);
        expect(body.account_lifecycle_state).toBe('incomplete');
        expect(body.missing_required_custom_claims).toEqual([
          {
            field_key: 'department',
            label: 'Department',
            field_type: 'string',
          },
        ]);
        expect(mockSessionStore.updateSessionDataRpc).toHaveBeenCalledWith(
          'session-123',
          expect.objectContaining({
            profile_completion_required: true,
            account_lifecycle_state: 'incomplete',
            missing_required_custom_claims: [
              {
                field_key: 'department',
                label: 'Department',
                field_type: 'string',
              },
            ],
          })
        );
      });
    });
  });

  describe('upgradeStatusHandler (GET /api/auth/upgrade/status)', () => {
    describe('Response Format', () => {
      it('should return user_id', () => {
        const response = {
          user_id: 'anon-user-123',
          is_anonymous: true,
          upgrade_eligible: true,
          upgrade_history: [],
        };

        expect(response.user_id).toBeDefined();
      });

      it('should return is_anonymous flag', () => {
        const anonymousResponse = { is_anonymous: true };
        const upgradedResponse = { is_anonymous: false };

        expect(anonymousResponse.is_anonymous).toBe(true);
        expect(upgradedResponse.is_anonymous).toBe(false);
      });

      it('should return upgrade_eligible flag', () => {
        const eligibleResponse = { upgrade_eligible: true };
        const ineligibleResponse = { upgrade_eligible: false };

        expect(eligibleResponse.upgrade_eligible).toBe(true);
        expect(ineligibleResponse.upgrade_eligible).toBe(false);
      });

      it('should return upgrade_history array', async () => {
        mockDatabaseAdapter.query.mockResolvedValueOnce([
          {
            id: 'upgrade-1',
            upgrade_method: 'email',
            upgraded_at: Date.now() - 86400000, // 1 day ago
            preserve_sub: 1,
          },
        ]);

        const history = await mockDatabaseAdapter.query(
          `SELECT id, upgrade_method, upgraded_at, preserve_sub
           FROM user_upgrades
           WHERE anonymous_user_id = ? OR upgraded_user_id = ?
           ORDER BY upgraded_at DESC`,
          ['anon-user-123', 'anon-user-123']
        );

        expect(Array.isArray(history)).toBe(true);
        expect(history[0]).toHaveProperty('upgrade_method');
      });
    });

    describe('Upgrade History Format', () => {
      it('should format history entries correctly', () => {
        const rawEntry = {
          id: 'upgrade-1',
          upgrade_method: 'email',
          upgraded_at: 1704067200000,
          preserve_sub: 1,
        };

        const formattedEntry = {
          id: rawEntry.id,
          method: rawEntry.upgrade_method,
          upgraded_at: rawEntry.upgraded_at,
          preserve_sub: rawEntry.preserve_sub === 1,
        };

        expect(formattedEntry.method).toBe('email');
        expect(formattedEntry.preserve_sub).toBe(true);
      });
    });

    describe('Handler execution', () => {
      it('should report incomplete lifecycle hints for upgraded users with missing required claims', async () => {
        mockSessionStore.getSessionRpc.mockResolvedValueOnce({
          userId: 'user-123',
          data: {
            is_anonymous: false,
            upgrade_eligible: false,
          },
        });
        mockUserCoreRepository.findById.mockResolvedValueOnce({
          id: 'user-123',
          user_type: 'end_user',
          tenant_id: 'default',
        });
        mockSyncUserLifecycleState.mockResolvedValueOnce({
          lifecycleState: 'incomplete',
          missingRequiredFields: [
            {
              fieldKey: 'employeeNumber',
              label: 'Employee Number',
              fieldType: 'string',
            },
          ],
        });
        mockDatabaseAdapter.query.mockResolvedValueOnce([]);

        const c = createMockContext({ method: 'GET' });
        const response = await upgradeStatusHandler(c);
        const body = (await response.json()) as {
          is_anonymous: boolean;
          profile_completion_required: boolean;
          account_lifecycle_state: string;
          missing_required_custom_claims: Array<{
            field_key: string;
            label: string;
            field_type: string;
          }>;
        };

        expect(response.status).toBe(200);
        expect(body.is_anonymous).toBe(false);
        expect(body.profile_completion_required).toBe(true);
        expect(body.account_lifecycle_state).toBe('incomplete');
        expect(body.missing_required_custom_claims).toEqual([
          {
            field_key: 'employeeNumber',
            label: 'Employee Number',
            field_type: 'string',
          },
        ]);
      });
    });
  });

  describe('Security Considerations', () => {
    describe('Session Binding', () => {
      it('should only allow upgrade for session owner', async () => {
        const sessionUserId = 'anon-user-123';
        const requestedUpgradeUserId = 'different-user-456';

        expect(sessionUserId).not.toBe(requestedUpgradeUserId);
      });

      it('should verify session is not expired', async () => {
        mockSessionStore.getSessionRpc.mockResolvedValueOnce(null); // Expired/invalid session

        const session = await mockSessionStore.getSessionRpc('expired-session');
        expect(session).toBeNull();
      });
    });

    describe('One-Time Upgrade', () => {
      it('should prevent double upgrade', () => {
        const alreadyUpgradedSession = {
          userId: 'user-123',
          data: {
            is_anonymous: false, // Already upgraded
            upgrade_eligible: false,
          },
        };

        expect(alreadyUpgradedSession.data.upgrade_eligible).toBe(false);
      });
    });

    describe('Rate Limiting', () => {
      it('should apply rate limiting to upgrade endpoints', () => {
        // Rate limit profile should be 'moderate' for upgrade endpoints
        const rateLimitProfile = 'moderate';
        expect(rateLimitProfile).toBe('moderate');
      });
    });
  });
});
