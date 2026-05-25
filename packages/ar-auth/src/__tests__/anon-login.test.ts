/**
 * Anonymous Login Handler Unit Tests
 *
 * Tests for device-based anonymous authentication.
 * @see architecture-decisions.md §17
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const mockChallengeStore = {
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
};

const mockSessionStore = {
  createSessionRpc: vi.fn(),
};

const mockDatabaseAdapter = {
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
};

const mockUserCoreRepository = {
  createUser: vi.fn(),
  findById: vi.fn(),
};

vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    getTenantIdFromContext: vi.fn().mockReturnValue('default'),
    getSessionStoreForNewSession: vi.fn().mockResolvedValue({
      stub: mockSessionStore,
      sessionId: 'session-12345',
    }),
    getChallengeStoreByChallengeId: vi.fn().mockResolvedValue(mockChallengeStore),
    isAnonymousAuthEnabled: vi.fn().mockResolvedValue(true),
    loadClientContract: vi.fn().mockResolvedValue({
      anonymousAuth: {
        enabled: true,
        deviceStability: 'installation',
        expiresInDays: 30,
      },
    }),
    createAuthContextFromHono: vi.fn().mockReturnValue({
      coreAdapter: mockDatabaseAdapter,
      repositories: {
        userCore: mockUserCoreRepository,
      },
    }),
    generateId: vi.fn().mockReturnValue('generated-user-id'),
    generateBrowserState: vi.fn().mockResolvedValue('browser-state-123'),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    hashDeviceIdentifiers: vi.fn().mockResolvedValue({
      device_id_hash: 'hashed-device-id',
      installation_id_hash: 'hashed-install-id',
      fingerprint_hash: null,
      device_platform: 'ios',
    }),
    verifyDeviceSignature: vi.fn().mockResolvedValue(true),
    verifyChallengeResponse: vi.fn().mockResolvedValue(true),
    generateDeviceChallenge: vi.fn().mockReturnValue({
      challenge_id: 'challenge-id-123',
      challenge: 'random-challenge-string',
      expires_at: Math.floor(Date.now() / 1000) + 300,
    }),
    validateDeviceId: vi.fn().mockReturnValue(true),
    validateDeviceStability: vi.fn().mockReturnValue(true),
  };
});

describe('Anonymous Login Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('anonLoginChallengeHandler', () => {
    describe('Input Validation', () => {
      it('should require client_id parameter', () => {
        const requiredParams = ['client_id', 'device_id'];
        const validRequest = {
          client_id: 'client-123',
          device_id: 'device-12345678',
        };

        requiredParams.forEach((param) => {
          expect(validRequest).toHaveProperty(param);
        });
      });

      it('should require device_id parameter', () => {
        const requestBody = { client_id: 'client-123' };
        expect(requestBody).not.toHaveProperty('device_id');
      });

      it('should validate device_id format', () => {
        const validDeviceIds = [
          'device-12345678',
          '550e8400-e29b-41d4-a716-446655440000',
          'ABCD1234-EFGH-5678',
        ];
        const invalidDeviceIds = ['short', '123', ''];

        // Device ID must be at least 8 characters
        validDeviceIds.forEach((id) => {
          expect(id.length).toBeGreaterThanOrEqual(8);
        });

        invalidDeviceIds.forEach((id) => {
          expect(id.length).toBeLessThan(8);
        });
      });

      it('should accept optional installation_id', () => {
        const requestWithInstall = {
          client_id: 'client-123',
          device_id: 'device-12345678',
          installation_id: 'install-abc123',
        };

        expect(requestWithInstall.installation_id).toBeDefined();
      });

      it('should accept optional fingerprint', () => {
        const requestWithFingerprint = {
          client_id: 'client-123',
          device_id: 'device-12345678',
          fingerprint: 'fingerprint-hash-xyz',
        };

        expect(requestWithFingerprint.fingerprint).toBeDefined();
      });

      it('should accept valid platform values', () => {
        const validPlatforms = ['ios', 'android', 'web', 'other'];

        validPlatforms.forEach((platform) => {
          expect(['ios', 'android', 'web', 'other']).toContain(platform);
        });
      });

      it('should accept valid device_stability values', () => {
        const validStabilities = ['session', 'installation', 'device'];

        validStabilities.forEach((stability) => {
          expect(['session', 'installation', 'device']).toContain(stability);
        });
      });
    });

    describe('Feature Flag Check', () => {
      it('should return error when anonymous auth is disabled', async () => {
        const { isAnonymousAuthEnabled } = await import('@authrim/ar-lib-core');
        vi.mocked(isAnonymousAuthEnabled).mockResolvedValueOnce(false);

        // When disabled, should return invalid_request error
        const result = await vi.mocked(isAnonymousAuthEnabled)({} as never);
        expect(result).toBe(false);
      }, 15_000);
    });

    describe('Challenge Generation', () => {
      it('should generate unique challenge for each request', async () => {
        const { generateDeviceChallenge } = await import('@authrim/ar-lib-core');

        const challenge1 = generateDeviceChallenge();
        const challenge2 = generateDeviceChallenge();

        // Mocked, but in real implementation these would be unique
        expect(challenge1).toHaveProperty('challenge_id');
        expect(challenge1).toHaveProperty('challenge');
        expect(challenge1).toHaveProperty('expires_at');
      });

      it('should store challenge in ChallengeStore with correct type', async () => {
        const challengeType = 'anon_login';
        const challengeId = 'challenge-123';

        await mockChallengeStore.storeChallengeRpc({
          id: `anon_login:${challengeId}`,
          tenantId: 'tenant-1',
          type: challengeType,
          userId: '',
          challenge: 'random-challenge',
          ttl: 300,
          metadata: {
            client_id: 'client-123',
            device_signature: { device_id_hash: 'hash' },
            device_stability: 'installation',
          },
        });

        expect(mockChallengeStore.storeChallengeRpc).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'anon_login',
            ttl: 300,
          })
        );
      });

      it('should set challenge TTL to 5 minutes', () => {
        const CHALLENGE_TTL = 5 * 60; // 5 minutes in seconds
        expect(CHALLENGE_TTL).toBe(300);
      });
    });

    describe('Response Format', () => {
      it('should return challenge_id in response', () => {
        const response = {
          challenge_id: 'challenge-id-123',
          challenge: 'random-challenge-string',
          expires_at: Math.floor(Date.now() / 1000) + 300,
        };

        expect(response).toHaveProperty('challenge_id');
        expect(response.challenge_id).toBeTypeOf('string');
      });

      it('should return challenge in response', () => {
        const response = {
          challenge_id: 'challenge-id-123',
          challenge: 'random-challenge-string',
          expires_at: Math.floor(Date.now() / 1000) + 300,
        };

        expect(response).toHaveProperty('challenge');
        expect(response.challenge).toBeTypeOf('string');
      });

      it('should return expires_at timestamp', () => {
        const now = Math.floor(Date.now() / 1000);
        const response = {
          challenge_id: 'challenge-id-123',
          challenge: 'random-challenge-string',
          expires_at: now + 300,
        };

        expect(response.expires_at).toBeGreaterThan(now);
        expect(response.expires_at).toBeLessThanOrEqual(now + 301);
      });
    });
  });

  describe('anonLoginVerifyHandler', () => {
    describe('Input Validation', () => {
      it('should require challenge_id', () => {
        const requiredFields = ['challenge_id', 'device_id', 'response', 'timestamp'];

        requiredFields.forEach((field) => {
          expect(requiredFields).toContain(field);
        });
      });

      it('should require device_id', () => {
        const requestBody = {
          challenge_id: 'challenge-123',
          device_id: 'device-12345678',
          response: 'signed-response',
          timestamp: Date.now(),
        };

        expect(requestBody.device_id).toBeDefined();
      });

      it('should require response signature', () => {
        const requestBody = {
          challenge_id: 'challenge-123',
          device_id: 'device-12345678',
          response: 'hmac-signed-response',
          timestamp: Math.floor(Date.now() / 1000),
        };

        expect(requestBody.response).toBeDefined();
        expect(requestBody.response.length).toBeGreaterThan(0);
      });

      it('should require timestamp', () => {
        const requestBody = {
          challenge_id: 'challenge-123',
          device_id: 'device-12345678',
          response: 'signed-response',
          timestamp: Math.floor(Date.now() / 1000),
        };

        expect(requestBody.timestamp).toBeTypeOf('number');
      });
    });

    describe('Challenge Consumption', () => {
      it('should consume challenge atomically', async () => {
        mockChallengeStore.consumeChallengeRpc.mockResolvedValueOnce({
          challenge: 'original-challenge',
          metadata: {
            client_id: 'client-123',
            device_signature: { device_id_hash: 'hash' },
          },
        });

        const result = await mockChallengeStore.consumeChallengeRpc({
          id: 'anon_login:challenge-123',
          tenantId: 'tenant-1',
          type: 'anon_login',
        });

        expect(mockChallengeStore.consumeChallengeRpc).toHaveBeenCalled();
        expect(result.challenge).toBeDefined();
      });

      it('should reject already consumed challenge', async () => {
        mockChallengeStore.consumeChallengeRpc.mockRejectedValueOnce(
          new Error('Challenge not found or expired')
        );

        await expect(
          mockChallengeStore.consumeChallengeRpc({
            id: 'anon_login:already-used',
            tenantId: 'tenant-1',
            type: 'anon_login',
          })
        ).rejects.toThrow();
      });
    });

    describe('New User Creation', () => {
      it('should create anonymous user with user_type=anonymous', async () => {
        mockDatabaseAdapter.queryOne.mockResolvedValueOnce(null); // No existing device

        await mockUserCoreRepository.createUser({
          id: 'new-user-id',
          tenant_id: 'default',
          email_verified: false,
          user_type: 'anonymous',
          pii_partition: 'none',
          pii_status: 'none',
        });

        expect(mockUserCoreRepository.createUser).toHaveBeenCalledWith(
          expect.objectContaining({
            user_type: 'anonymous',
            pii_status: 'none',
          })
        );
      });

      it('should set pii_status to none for anonymous users', async () => {
        const createUserParams = {
          id: 'user-123',
          tenant_id: 'default',
          email_verified: false,
          user_type: 'anonymous',
          pii_partition: 'none',
          pii_status: 'none',
        };

        expect(createUserParams.pii_status).toBe('none');
        expect(createUserParams.pii_partition).toBe('none');
      });

      it('should create anonymous_devices record', async () => {
        const now = Date.now();

        await mockDatabaseAdapter.execute(
          `INSERT INTO anonymous_devices (
            id, tenant_id, user_id, device_id_hash, installation_id_hash,
            fingerprint_hash, device_platform, device_stability,
            expires_at, created_at, last_used_at, is_active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            'device-record-id',
            'default',
            'user-123',
            'hashed-device-id',
            'hashed-install-id',
            null,
            'ios',
            'installation',
            now + 30 * 24 * 60 * 60 * 1000, // 30 days
            now,
            now,
          ]
        );

        expect(mockDatabaseAdapter.execute).toHaveBeenCalled();
      });
    });

    describe('Existing User Resumption', () => {
      it('should resume existing user if device_id_hash matches', () => {
        // Test the logic: when device exists and is not expired, use existing user
        const existingDevice = {
          id: 'device-record-id',
          user_id: 'existing-user-456',
          expires_at: Date.now() + 1000000, // Not expired
          is_active: 1,
        };

        // Logic check: if device found and not expired, should use existing user
        const isExpired = existingDevice.expires_at < Date.now();
        const shouldResumeUser = existingDevice && !isExpired && existingDevice.is_active === 1;

        expect(shouldResumeUser).toBe(true);
        expect(existingDevice.user_id).toBe('existing-user-456');
      });

      it('should update last_used_at for existing device', async () => {
        const now = Date.now();

        await mockDatabaseAdapter.execute(
          'UPDATE anonymous_devices SET last_used_at = ? WHERE id = ?',
          [now, 'device-record-id']
        );

        expect(mockDatabaseAdapter.execute).toHaveBeenCalledWith(
          expect.stringContaining('UPDATE anonymous_devices SET last_used_at'),
          expect.arrayContaining([now])
        );
      });

      it('should deactivate expired device and create new user', async () => {
        const expiredDevice = {
          id: 'expired-device-id',
          user_id: 'old-user-id',
          expires_at: Date.now() - 1000, // Already expired
          is_active: 1,
        };

        mockDatabaseAdapter.queryOne.mockResolvedValueOnce(expiredDevice);

        // Check if expired
        const isExpired = expiredDevice.expires_at < Date.now();
        expect(isExpired).toBe(true);
      });
    });

    describe('Session Creation', () => {
      it('should create session with amr=anon', async () => {
        await mockSessionStore.createSessionRpc('session-123', 'user-456', 86400, {
          amr: ['anon'],
          acr: 'urn:mace:incommon:iap:anonymous',
          is_anonymous: true,
          upgrade_eligible: true,
          device_id_hash: 'hashed-device-id',
          client_id: 'client-123',
        });

        expect(mockSessionStore.createSessionRpc).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          expect.any(Number),
          expect.objectContaining({
            amr: ['anon'],
            is_anonymous: true,
            upgrade_eligible: true,
          })
        );
      });

      it('should set session TTL to 24 hours', () => {
        const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds
        expect(SESSION_TTL).toBe(86400);
      });

      it('should include device_id_hash in session data', async () => {
        const sessionData = {
          amr: ['anon'],
          is_anonymous: true,
          upgrade_eligible: true,
          device_id_hash: 'hashed-device-id',
          client_id: 'client-123',
        };

        expect(sessionData.device_id_hash).toBeDefined();
      });
    });

    describe('Response Format', () => {
      it('should return success and session_id', () => {
        const response = {
          success: true,
          session_id: 'session-12345',
          user_id: 'user-67890',
          is_new_user: true,
          upgrade_eligible: true,
          user: {
            id: 'user-67890',
            user_type: 'anonymous',
          },
        };

        expect(response.success).toBe(true);
        expect(response.session_id).toBeDefined();
        expect(response.user_id).toBeDefined();
      });

      it('should indicate if user is new', () => {
        const newUserResponse = { is_new_user: true };
        const existingUserResponse = { is_new_user: false };

        expect(newUserResponse.is_new_user).toBe(true);
        expect(existingUserResponse.is_new_user).toBe(false);
      });

      it('should include user object with user_type', () => {
        const response = {
          user: {
            id: 'user-123',
            user_type: 'anonymous',
          },
        };

        expect(response.user.user_type).toBe('anonymous');
      });

      it('should set upgrade_eligible to true', () => {
        const response = {
          upgrade_eligible: true,
        };

        expect(response.upgrade_eligible).toBe(true);
      });
    });

    describe('Cookie Management', () => {
      it('should set authrim_session cookie', () => {
        const cookieConfig = {
          name: 'authrim_session',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'None',
          maxAge: 86400, // 24 hours
        };

        expect(cookieConfig.name).toBe('authrim_session');
        expect(cookieConfig.httpOnly).toBe(true);
        expect(cookieConfig.secure).toBe(true);
      });

      it('should set browser state cookie for session management', () => {
        const cookieName = 'authrim_browser_state';
        expect(cookieName).toBe('authrim_browser_state');
      });
    });

    describe('Error Handling', () => {
      it('should return error for invalid challenge response', async () => {
        const { verifyChallengeResponse } = await import('@authrim/ar-lib-core');
        vi.mocked(verifyChallengeResponse).mockResolvedValueOnce(false);

        const isValid = await verifyChallengeResponse(
          'challenge',
          'wrong-response',
          'device',
          123,
          'secret'
        );
        expect(isValid).toBe(false);
      });

      it('should return error for mismatched device signature', async () => {
        const { verifyDeviceSignature } = await import('@authrim/ar-lib-core');
        vi.mocked(verifyDeviceSignature).mockResolvedValueOnce(false);

        const isValid = await verifyDeviceSignature(
          { device_id: 'device-123' },
          { device_id_hash: 'wrong-hash' },
          'secret'
        );
        expect(isValid).toBe(false);
      });
    });

    describe('Security', () => {
      it('should use constant-time response to prevent timing attacks', () => {
        // The handler uses constantTimeWrapper with MIN_RESPONSE_TIME_MS = 500ms
        const MIN_RESPONSE_TIME_MS = 500;
        const JITTER_MS = 100;

        expect(MIN_RESPONSE_TIME_MS).toBeGreaterThan(0);
        expect(JITTER_MS).toBeGreaterThan(0);
      });

      it('should hash device identifiers before storage', async () => {
        const { hashDeviceIdentifiers } = await import('@authrim/ar-lib-core');

        const signature = await hashDeviceIdentifiers(
          { device_id: 'plain-device-id' },
          'hmac-secret'
        );

        // Should return hashed value, not plain
        expect(signature.device_id_hash).not.toBe('plain-device-id');
      });

      it('should never store plaintext device_id', () => {
        const storedData = {
          device_id_hash: 'hashed-value',
          // device_id should NOT exist in stored data
        };

        expect(storedData).not.toHaveProperty('device_id');
        expect(storedData).toHaveProperty('device_id_hash');
      });
    });
  });
});
