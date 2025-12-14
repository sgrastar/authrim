/**
 * Identity Stitching Service Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleIdentity,
  getStitchingConfig,
  hasPasskeyCredential,
} from '../services/identity-stitching';
import * as linkedIdentityStore from '../services/linked-identity-store';
import type { UpstreamProvider, UserInfo, TokenResponse } from '../types';

// Mock the linked identity store
vi.mock('../services/linked-identity-store', () => ({
  findLinkedIdentity: vi.fn(),
  createLinkedIdentity: vi.fn(),
  updateLinkedIdentity: vi.fn(),
}));

describe('Identity Stitching Service', () => {
  const mockProvider: UpstreamProvider = {
    id: 'provider-123',
    tenantId: 'default',
    name: 'Google',
    providerType: 'oidc',
    enabled: true,
    priority: 0,
    issuer: 'https://accounts.google.com',
    clientId: 'test-client-id',
    clientSecretEncrypted: 'encrypted-secret',
    scopes: 'openid email profile',
    attributeMapping: {},
    autoLinkEmail: true,
    jitProvisioning: true,
    requireEmailVerified: true,
    providerQuirks: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const mockUserInfo: UserInfo = {
    sub: 'google-user-123',
    email: 'test@example.com',
    email_verified: true,
    name: 'Test User',
    given_name: 'Test',
    family_name: 'User',
    picture: 'https://example.com/avatar.jpg',
  };

  const mockTokens: TokenResponse = {
    access_token: 'mock-access-token',
    token_type: 'Bearer',
    expires_in: 3600,
    id_token: 'mock-id-token',
  };

  // Mock Env
  const createMockEnv = (overrides: Record<string, unknown> = {}) => ({
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn(),
        all: vi.fn(),
        run: vi.fn(),
      }),
    },
    SETTINGS: {
      get: vi.fn().mockResolvedValue(null),
    },
    IDENTITY_STITCHING_ENABLED: 'true',
    IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'true',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getStitchingConfig', () => {
    it('should return config from KV if available', async () => {
      const env = createMockEnv();
      env.SETTINGS.get.mockResolvedValueOnce(
        JSON.stringify({ enabled: true, requireVerifiedEmail: false })
      );

      const config = await getStitchingConfig(env as never);

      expect(config.enabled).toBe(true);
      expect(config.requireVerifiedEmail).toBe(false);
    });

    it('should fall back to env vars if KV not available', async () => {
      const env = createMockEnv({
        SETTINGS: {
          get: vi.fn().mockRejectedValueOnce(new Error('KV error')),
        },
        IDENTITY_STITCHING_ENABLED: 'true',
        IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false',
      });

      const config = await getStitchingConfig(env as never);

      expect(config.enabled).toBe(true);
      // When IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL is 'false', requireVerifiedEmail should be false
      expect(config.requireVerifiedEmail).toBe(false);
    });

    it('should default to disabled if no config found', async () => {
      const env = createMockEnv({
        SETTINGS: null,
        IDENTITY_STITCHING_ENABLED: undefined,
      });

      const config = await getStitchingConfig(env as never);

      expect(config.enabled).toBe(false);
    });
  });

  describe('handleIdentity', () => {
    describe('Explicit Linking (linkingUserId provided)', () => {
      it('should link identity to specified user', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('linked-id-123');
        env.DB.prepare()
          .bind()
          .run.mockResolvedValueOnce({ meta: { changes: 1 } });

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          linkingUserId: 'existing-user-456',
        });

        expect(result.userId).toBe('existing-user-456');
        expect(result.isNewUser).toBe(false);
        expect(result.stitchedFromExisting).toBe(false);
        expect(result.linkedIdentityId).toBe('linked-id-123');

        expect(linkedIdentityStore.createLinkedIdentity).toHaveBeenCalledWith(
          env,
          expect.objectContaining({
            userId: 'existing-user-456',
            providerId: 'provider-123',
            providerUserId: 'google-user-123',
          })
        );
      });
    });

    describe('Existing Linked Identity', () => {
      it('should return existing user when linked identity found', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce({
          id: 'existing-linked-id',
          userId: 'existing-user-789',
          tenantId: 'default',
          providerId: 'provider-123',
          providerUserId: 'google-user-123',
          emailVerified: true,
          linkedAt: Date.now() - 86400000,
          updatedAt: Date.now() - 86400000,
        });
        vi.mocked(linkedIdentityStore.updateLinkedIdentity).mockResolvedValueOnce(true);

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
        });

        expect(result.userId).toBe('existing-user-789');
        expect(result.isNewUser).toBe(false);
        expect(result.stitchedFromExisting).toBe(false);
        expect(result.linkedIdentityId).toBe('existing-linked-id');

        // Should update tokens and last login
        expect(linkedIdentityStore.updateLinkedIdentity).toHaveBeenCalledWith(
          env,
          'existing-linked-id',
          expect.objectContaining({
            tokens: mockTokens,
            lastLoginAt: expect.any(Number),
          })
        );
      });
    });

    describe('Identity Stitching by Email', () => {
      it('should auto-link when email matches verified user', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('new-linked-id');

        // Mock findUserByEmail
        env.DB.prepare().bind().first.mockResolvedValueOnce({
          id: 'existing-user-by-email',
          email: 'test@example.com',
          email_verified: 1,
        });

        // Mock audit log insert
        env.DB.prepare()
          .bind()
          .run.mockResolvedValueOnce({ meta: { changes: 1 } });

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
        });

        expect(result.userId).toBe('existing-user-by-email');
        expect(result.isNewUser).toBe(false);
        expect(result.stitchedFromExisting).toBe(true);
      });

      it('should not stitch if stitching is disabled', async () => {
        const env = createMockEnv({
          IDENTITY_STITCHING_ENABLED: 'false',
        });
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('new-linked-id');

        // Mock user creation
        env.DB.prepare()
          .bind()
          .run.mockResolvedValue({ meta: { changes: 1 } });

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
        });

        // Should JIT provision instead of stitching
        expect(result.isNewUser).toBe(true);
      });

      it('should not stitch if provider autoLinkEmail is disabled', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('new-linked-id');

        const providerNoAutoLink = { ...mockProvider, autoLinkEmail: false };

        // Mock user creation
        env.DB.prepare()
          .bind()
          .run.mockResolvedValue({ meta: { changes: 1 } });

        const result = await handleIdentity(env as never, {
          provider: providerNoAutoLink,
          userInfo: mockUserInfo,
          tokens: mockTokens,
        });

        // Should JIT provision instead of stitching
        expect(result.isNewUser).toBe(true);
      });

      it('should not stitch if email is not verified and requireVerifiedEmail is true', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);

        const unverifiedUserInfo: UserInfo = {
          ...mockUserInfo,
          email_verified: false,
        };

        // Mock findUserByEmail - no user found (so it will try JIT provisioning)
        env.DB.prepare().bind().first.mockResolvedValueOnce(null);

        // Should throw error because email is not verified
        await expect(
          handleIdentity(env as never, {
            provider: mockProvider,
            userInfo: unverifiedUserInfo,
            tokens: mockTokens,
          })
        ).rejects.toThrow('email from your external account is not verified');
      });

      it('should not stitch if existing user email is not verified', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);

        // Mock findUserByEmail - user exists but email not verified
        env.DB.prepare().bind().first.mockResolvedValueOnce({
          id: 'existing-user-unverified',
          email: 'test@example.com',
          email_verified: 0, // Not verified
        });

        // Should throw error because local email is not verified
        await expect(
          handleIdentity(env as never, {
            provider: mockProvider,
            userInfo: mockUserInfo,
            tokens: mockTokens,
          })
        ).rejects.toThrow('existing account email is not verified');
      });
    });

    describe('JIT Provisioning', () => {
      it('should create new user when JIT enabled and no existing user', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('new-linked-id');

        // Mock findUserByEmail - no user found
        env.DB.prepare().bind().first.mockResolvedValueOnce(null);

        // Mock user creation and audit log
        env.DB.prepare()
          .bind()
          .run.mockResolvedValue({ meta: { changes: 1 } });

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
        });

        expect(result.isNewUser).toBe(true);
        expect(result.userId).toBeDefined();
        expect(result.stitchedFromExisting).toBe(false);
      });

      it('should throw error if JIT disabled and no existing account', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);

        const providerNoJIT = { ...mockProvider, jitProvisioning: false };

        // Mock findUserByEmail - no user found
        env.DB.prepare().bind().first.mockResolvedValueOnce(null);

        await expect(
          handleIdentity(env as never, {
            provider: providerNoJIT,
            userInfo: mockUserInfo,
            tokens: mockTokens,
          })
        ).rejects.toThrow('New account registration via external providers is not available');
      });

      it('should use placeholder email if not provided', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('new-linked-id');

        const userInfoNoEmail: UserInfo = {
          sub: 'google-user-123',
        };

        // Mock findUserByEmail - no user found
        env.DB.prepare().bind().first.mockResolvedValueOnce(null);

        // Mock user creation and audit log
        env.DB.prepare()
          .bind()
          .run.mockResolvedValue({ meta: { changes: 1 } });

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: userInfoNoEmail,
          tokens: mockTokens,
        });

        expect(result.isNewUser).toBe(true);
      });
    });

    describe('Audit Logging', () => {
      it('should log audit event for explicit linking', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('linked-id-123');

        // Track calls to DB.prepare
        const runMock = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
        env.DB.prepare = vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn(),
          all: vi.fn(),
          run: runMock,
        });

        await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          linkingUserId: 'existing-user-456',
        });

        // Verify audit log was inserted
        const prepareCallArgs = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls.map(
          (c) => c[0]
        );
        expect(prepareCallArgs.some((sql: string) => sql.includes('audit_log'))).toBe(true);
      });
    });
  });

  describe('hasPasskeyCredential', () => {
    it('should return true if user has passkey', async () => {
      const env = createMockEnv();
      env.DB.prepare().bind().first.mockResolvedValueOnce({ count: 1 });

      const result = await hasPasskeyCredential(env as never, 'user-123');

      expect(result).toBe(true);
    });

    it('should return false if user has no passkey', async () => {
      const env = createMockEnv();
      env.DB.prepare().bind().first.mockResolvedValueOnce({ count: 0 });

      const result = await hasPasskeyCredential(env as never, 'user-123');

      expect(result).toBe(false);
    });

    it('should return false if query returns null', async () => {
      const env = createMockEnv();
      env.DB.prepare().bind().first.mockResolvedValueOnce(null);

      const result = await hasPasskeyCredential(env as never, 'user-123');

      expect(result).toBe(false);
    });
  });
});
