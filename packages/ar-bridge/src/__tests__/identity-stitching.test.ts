/**
 * Identity Stitching Service Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpstreamProvider, UserInfo, TokenResponse } from '../types';

// Create hoisted mocks that can be configured in tests
const {
  mockCoreQueryOne,
  mockCoreExecute,
  mockPiiQueryOne,
  mockValidateCustomClaimWrite,
  mockPersistCustomClaimWrite,
  mockSyncUserLifecycleState,
  mockCreateAuditLog,
  mockRuntimeSyncUser,
  MockD1Adapter,
  MockCanonicalRuntimeUserStore,
  sqlTracker,
  mockResolveAccountContext,
  mockResolveTenantMetadataContext,
  mockCreateRuleEvaluator,
  mockFindPendingIdentity,
  mockActivatePendingIdentity,
  mockProvisionExternalIdpAccount,
  mockPublishExternalIdpRoute,
} = vi.hoisted(() => {
  // Storage for tracking SQL calls - differentiate between DB and DB_PII
  const tracker = {
    coreDb: [] as { method: string; sql: string; params: unknown[] }[],
    piiDb: [] as { method: string; sql: string; params: unknown[] }[],
    reset() {
      this.coreDb.length = 0;
      this.piiDb.length = 0;
    },
  };

  // Mock functions for Core DB (env.DB)
  const coreQueryOneMock = vi.fn().mockResolvedValue(null);
  const coreExecuteMock = vi.fn().mockResolvedValue({ rowsAffected: 1 });

  // Mock functions for PII DB (env.DB_PII)
  const piiQueryOneMock = vi.fn().mockResolvedValue(null);
  const validateCustomClaimWriteMock = vi.fn().mockResolvedValue({ ok: true });
  const persistCustomClaimWriteMock = vi.fn().mockResolvedValue(undefined);
  const syncUserLifecycleStateMock = vi.fn().mockResolvedValue({
    lifecycleState: 'active',
    missingRequiredFields: [],
  });
  const createAuditLogMock = vi.fn().mockResolvedValue(undefined);
  const runtimeSyncUserMock = vi.fn().mockResolvedValue({ accountId: 'account-id' });
  const resolveAccountContextMock = vi.fn();
  const resolveTenantMetadataContextMock = vi.fn();
  const createRuleEvaluatorMock = vi.fn(() => ({
    evaluate: vi.fn().mockResolvedValue({
      matched_rules: [],
      roles_to_assign: [],
      orgs_to_join: [],
      attributes_to_set: [],
      denied: false,
    }),
  }));
  const findPendingIdentityMock = vi.fn();
  const activatePendingIdentityMock = vi.fn();
  const provisionExternalIdpAccountMock = vi.fn();
  const publishExternalIdpRouteMock = vi.fn();

  // Create a class that wraps the mock functions and tracks calls
  // The class determines binding type from the db option's _isPii marker
  class D1AdapterClass {
    private binding: 'core' | 'pii';

    constructor(options: { db: unknown }) {
      // Determine which DB this adapter is for based on the binding marker
      this.binding = options.db && (options.db as { _isPii?: boolean })._isPii ? 'pii' : 'core';
    }

    execute = (sql: string, params?: unknown[]) => {
      tracker.coreDb.push({ method: 'execute', sql, params: params || [] });
      return coreExecuteMock(sql, params);
    };

    queryOne = (sql: string, params?: unknown[]) => {
      if (this.binding === 'pii') {
        tracker.piiDb.push({ method: 'queryOne', sql, params: params || [] });
        return piiQueryOneMock(sql, params);
      } else {
        tracker.coreDb.push({ method: 'queryOne', sql, params: params || [] });
        return coreQueryOneMock(sql, params);
      }
    };

    query = vi.fn().mockResolvedValue([]);
  }

  class CanonicalRuntimeUserStoreClass {
    async findByEmail(email: string) {
      const piiRow = await piiQueryOneMock(
        `SELECT owner_id
           FROM identity_sensitive_values
          WHERE value_key = 'email'`,
        [email]
      );
      if (!piiRow) {
        return null;
      }
      const userId = piiRow.owner_id ?? piiRow.id;
      const coreRow = await coreQueryOneMock(
        `SELECT *
           FROM identity_accounts
          WHERE legacy_user_id = ?`,
        [userId]
      );
      if (!coreRow) {
        return null;
      }
      return {
        id: userId,
        email: piiRow.email ?? email,
        email_verified: coreRow.email_verified ?? 0,
      };
    }

    async syncUser(input: unknown) {
      return runtimeSyncUserMock(input);
    }
  }

  return {
    mockCoreQueryOne: coreQueryOneMock,
    mockCoreExecute: coreExecuteMock,
    mockPiiQueryOne: piiQueryOneMock,
    mockValidateCustomClaimWrite: validateCustomClaimWriteMock,
    mockPersistCustomClaimWrite: persistCustomClaimWriteMock,
    mockSyncUserLifecycleState: syncUserLifecycleStateMock,
    mockCreateAuditLog: createAuditLogMock,
    mockRuntimeSyncUser: runtimeSyncUserMock,
    MockD1Adapter: D1AdapterClass,
    MockCanonicalRuntimeUserStore: CanonicalRuntimeUserStoreClass,
    sqlTracker: tracker,
    mockResolveAccountContext: resolveAccountContextMock,
    mockResolveTenantMetadataContext: resolveTenantMetadataContextMock,
    mockCreateRuleEvaluator: createRuleEvaluatorMock,
    mockFindPendingIdentity: findPendingIdentityMock,
    mockActivatePendingIdentity: activatePendingIdentityMock,
    mockProvisionExternalIdpAccount: provisionExternalIdpAccountMock,
    mockPublishExternalIdpRoute: publishExternalIdpRouteMock,
  };
});

// Mock @authrim/ar-lib-core to prevent Cloudflare Workers imports
vi.mock('@authrim/ar-lib-core', () => ({
  D1Adapter: MockD1Adapter,
  CanonicalRuntimeUserStore: MockCanonicalRuntimeUserStore,
  ensureDatabaseAdapter: vi.fn().mockImplementation((db: unknown) => new MockD1Adapter({ db })),
  createLogger: () => ({
    module: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  getDefaultTenantId: vi.fn(() => 'default'),
  createRuleEvaluator: mockCreateRuleEvaluator,
  resolveOrgByDomainHash: vi.fn().mockResolvedValue(null),
  resolveAllOrgsByDomainHash: vi.fn().mockResolvedValue([]),
  joinOrganization: vi.fn().mockResolvedValue({ success: true }),
  assignRoleToUser: vi.fn().mockResolvedValue(undefined),
  generateEmailDomainHashWithVersion: vi.fn().mockResolvedValue({
    hash: 'mock-domain-hash',
    version: 1,
  }),
  getEmailDomainHashConfig: vi.fn().mockResolvedValue({
    current_version: 1,
    secrets: { 1: 'test-secret-key-16+' },
    migration_in_progress: false,
    deprecated_versions: [],
  }),
  DEFAULT_JIT_CONFIG: {
    enabled: true,
    auto_create_org_on_domain_match: false,
    join_all_matching_orgs: false,
    allow_user_without_org: true,
    default_role_id: 'role_end_user',
    allow_unverified_domain_mappings: false,
  },
  validateCustomClaimWrite: mockValidateCustomClaimWrite,
  persistCustomClaimWrite: mockPersistCustomClaimWrite,
  syncUserLifecycleState: mockSyncUserLifecycleState,
  createAuditLog: mockCreateAuditLog,
  resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
    schemaDb: env.DB,
    nonPiiDb: env.DB,
    piiDb: env.DB_PII ?? null,
  })),
  resolveTenantUserStoreSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
    coreDb: env.DB,
    piiDb: env.DB_PII ?? env.DB,
  })),
  resolveAccountDataContext: mockResolveAccountContext,
  resolveAccountDataContextByIdentifier: mockResolveAccountContext,
  resolveTenantMetadataContext: mockResolveTenantMetadataContext,
}));

// Mock the linked identity store
vi.mock('../services/linked-identity-store', () => ({
  findLinkedIdentity: vi.fn(),
  createLinkedIdentity: vi.fn(),
  updateLinkedIdentity: vi.fn(),
  findPendingLinkedIdentityProvisioning: mockFindPendingIdentity,
  activatePendingLinkedIdentity: mockActivatePendingIdentity,
}));

import {
  completeExternalIdpJIT,
  handleIdentity,
  getStitchingConfig,
  hasPasskeyCredential,
} from '../services/identity-stitching';
import * as linkedIdentityStore from '../services/linked-identity-store';
import { encrypt } from '../utils/crypto';

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

  // Create mock Env with markers for DB type detection
  const createMockEnv = (overrides: Record<string, unknown> = {}) => ({
    DB: { _isPii: false }, // Core DB marker
    DB_PII: { _isPii: true }, // PII DB marker
    SETTINGS: {
      get: vi.fn().mockResolvedValue(null),
    },
    ENABLE_IDENTITY_STITCHING: 'true',
    ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'true',
    RP_TOKEN_ENCRYPTION_KEY: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    EXTERNAL_IDP_ACCOUNT_PROVISIONER: {
      provisionExternalIdpAccount: mockProvisionExternalIdpAccount,
      publishExternalIdpRoute: mockPublishExternalIdpRoute,
    },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sqlTracker.reset();
    // Reset mock implementations to defaults
    mockCoreQueryOne.mockReset().mockResolvedValue(null);
    mockCoreExecute.mockReset().mockResolvedValue({ rowsAffected: 1 });
    mockPiiQueryOne.mockReset().mockResolvedValue(null);
    mockValidateCustomClaimWrite.mockReset().mockResolvedValue({
      ok: true,
      schemas: [],
      nonPiiValues: {},
      piiValues: {},
      nonPiiKeysToDelete: [],
      piiKeysToDelete: [],
    });
    mockPersistCustomClaimWrite.mockReset().mockResolvedValue(undefined);
    mockRuntimeSyncUser.mockReset().mockResolvedValue({ accountId: 'account-id' });
    mockSyncUserLifecycleState.mockReset().mockResolvedValue({
      lifecycleState: 'active',
      missingRequiredFields: [],
    });
    mockResolveAccountContext
      .mockReset()
      .mockRejectedValue(new Error('account_data_route_not_found'));
    mockResolveTenantMetadataContext.mockReset().mockImplementation(async (env) => ({
      tenantId: 'default',
      coreDb: env.DB,
      route: {},
    }));
    mockCreateRuleEvaluator.mockClear();
    mockFindPendingIdentity.mockReset();
    mockActivatePendingIdentity.mockReset().mockResolvedValue(undefined);
    mockProvisionExternalIdpAccount.mockReset().mockImplementation(async (request) => ({
      status: 202,
      operationId: request.operationId,
      accountId: `account:${request.candidateUserId}`,
      userId: request.candidateUserId,
    }));
    mockPublishExternalIdpRoute.mockReset().mockImplementation(async (request) => ({
      status: 201,
      operationId: request.operationId,
      accountId: request.accountId,
    }));
    vi.mocked(linkedIdentityStore.findLinkedIdentity).mockReset().mockResolvedValue(null);
    vi.mocked(linkedIdentityStore.createLinkedIdentity)
      .mockReset()
      .mockResolvedValue('linked-id-123');
    vi.mocked(linkedIdentityStore.updateLinkedIdentity).mockReset().mockResolvedValue(true);
  });

  describe('getStitchingConfig', () => {
    it('should return config from KV if available', async () => {
      const env = createMockEnv();
      (env.SETTINGS.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
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
        ENABLE_IDENTITY_STITCHING: 'true',
        ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false',
      });

      const config = await getStitchingConfig(env as never);

      expect(config.enabled).toBe(true);
      expect(config.requireVerifiedEmail).toBe(false);
    });

    it('should default to disabled if no config found', async () => {
      const env = createMockEnv({
        SETTINGS: null,
        ENABLE_IDENTITY_STITCHING: undefined,
      });

      const config = await getStitchingConfig(env as never);

      expect(config.enabled).toBe(false);
    });
  });

  describe('handleIdentity', () => {
    describe('Explicit Linking (linkingUserId provided)', () => {
      it('should link identity to specified user', async () => {
        const env = createMockEnv();
        mockResolveAccountContext.mockResolvedValue({
          tenantId: 'default',
          accountId: 'account:existing-user-456',
          legacyUserId: 'existing-user-456',
          coreDb: env.DB,
          piiDb: env.DB_PII,
        });
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('linked-id-123');

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          tenantId: 'default',
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
          }),
          env.DB_PII
        );
      });

      it('writes to the routed PII shard and publishes the external subject route', async () => {
        const accountContext = {
          tenantId: 'default',
          accountId: 'account:existing-user-456',
          legacyUserId: 'existing-user-456',
          coreDb: { _isPii: false },
          piiDb: { _isPii: true },
        };
        mockResolveAccountContext.mockResolvedValue(accountContext);
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('linked-id-123');
        const publishExternalIdpRoute = vi.fn().mockImplementation(async (request) => ({
          status: 201,
          operationId: request.operationId,
          accountId: request.accountId,
        }));
        const env = createMockEnv({
          EXTERNAL_IDP_ACCOUNT_PROVISIONER: { publishExternalIdpRoute },
        });

        await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          tenantId: 'default',
          linkingUserId: 'existing-user-456',
        });

        expect(linkedIdentityStore.createLinkedIdentity).toHaveBeenCalledWith(
          env,
          expect.objectContaining({ userId: 'existing-user-456' }),
          accountContext.piiDb
        );
        expect(publishExternalIdpRoute).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: 'default',
            accountId: 'account:existing-user-456',
            userId: 'existing-user-456',
            linkedIdentityId: 'linked-id-123',
            providerId: mockProvider.id,
            providerUserId: mockUserInfo.sub,
          })
        );
      });
    });

    describe('Existing Linked Identity', () => {
      it('should return existing user when linked identity found', async () => {
        const env = createMockEnv();
        mockResolveAccountContext.mockResolvedValue({
          tenantId: 'default',
          accountId: 'account:existing-user-789',
          legacyUserId: 'existing-user-789',
          coreDb: env.DB,
          piiDb: env.DB_PII,
        });
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
          tenantId: 'default',
        });

        expect(result.userId).toBe('existing-user-789');
        expect(result.isNewUser).toBe(false);
        expect(result.stitchedFromExisting).toBe(false);
        expect(result.linkedIdentityId).toBe('existing-linked-id');
        expect(linkedIdentityStore.findLinkedIdentity).toHaveBeenCalledWith(
          env,
          'default',
          'provider-123',
          'google-user-123',
          env.DB_PII
        );

        expect(linkedIdentityStore.updateLinkedIdentity).toHaveBeenCalledWith(
          env,
          'default',
          'existing-linked-id',
          expect.objectContaining({
            tokens: mockTokens,
            lastLoginAt: expect.any(Number),
          }),
          env.DB_PII
        );
      });

      it('updates an existing linked identity in its routed PII shard', async () => {
        const accountContext = {
          tenantId: 'default',
          accountId: 'account:existing-user-789',
          legacyUserId: 'existing-user-789',
          coreDb: { _isPii: false },
          piiDb: { _isPii: true },
        };
        mockResolveAccountContext.mockResolvedValue(accountContext);
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce({
          id: 'existing-linked-id',
          userId: 'existing-user-789',
          tenantId: 'default',
          providerId: mockProvider.id,
          providerUserId: mockUserInfo.sub,
          emailVerified: true,
          linkedAt: Date.now(),
          updatedAt: Date.now(),
        });
        vi.mocked(linkedIdentityStore.updateLinkedIdentity).mockResolvedValueOnce(true);
        const env = createMockEnv();

        await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          tenantId: 'default',
        });

        expect(linkedIdentityStore.updateLinkedIdentity).toHaveBeenCalledWith(
          env,
          'default',
          'existing-linked-id',
          expect.objectContaining({ tokens: mockTokens }),
          accountContext.piiDb
        );
      });
    });

    describe('Identity Stitching by Email', () => {
      it('should auto-link when email matches verified user', async () => {
        const env = createMockEnv();
        mockResolveAccountContext
          .mockRejectedValueOnce(new Error('account_data_route_not_found'))
          .mockResolvedValueOnce({
            tenantId: 'default',
            accountId: 'account:existing-user-by-email',
            legacyUserId: 'existing-user-by-email',
            coreDb: env.DB,
            piiDb: env.DB_PII,
          });
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('new-linked-id');

        // Mock findUserByEmail - canonical runtime store preserves the PII/Non-PII DB split:
        // 1. DB_PII resolves the email to a runtime user owner (PII DB)
        mockPiiQueryOne.mockResolvedValueOnce({
          id: 'existing-user-by-email',
          email: 'test@example.com',
        });
        // 2. DB resolves non-PII account state (Core DB)
        mockCoreQueryOne.mockResolvedValueOnce({
          id: 'existing-user-by-email',
          email_verified: 1,
        });

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          tenantId: 'default',
        });

        expect(result.userId).toBe('existing-user-by-email');
        expect(result.isNewUser).toBe(false);
        expect(result.stitchedFromExisting).toBe(true);
      });

      it('auto-links in the email-routed PII shard and publishes the external route', async () => {
        const accountContext = {
          tenantId: 'default',
          accountId: 'account:existing-user-by-email',
          legacyUserId: 'existing-user-by-email',
          coreDb: { _isPii: false },
          piiDb: { _isPii: true },
        };
        mockResolveAccountContext
          .mockRejectedValueOnce(new Error('account_data_route_not_found'))
          .mockResolvedValueOnce(accountContext);
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('new-linked-id');
        mockPiiQueryOne.mockResolvedValueOnce({
          id: 'existing-user-by-email',
          email: 'test@example.com',
        });
        mockCoreQueryOne.mockResolvedValueOnce({
          id: 'existing-user-by-email',
          email_verified: 1,
        });
        const publishExternalIdpRoute = vi.fn().mockImplementation(async (request) => ({
          status: 202,
          operationId: request.operationId,
          accountId: request.accountId,
        }));
        const env = createMockEnv({
          EXTERNAL_IDP_ACCOUNT_PROVISIONER: { publishExternalIdpRoute },
        });

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          tenantId: 'default',
        });

        expect(result).toMatchObject({
          status: 'ready',
          userId: 'existing-user-by-email',
          stitchedFromExisting: true,
        });
        expect(linkedIdentityStore.createLinkedIdentity).toHaveBeenCalledWith(
          env,
          expect.objectContaining({ userId: 'existing-user-by-email' }),
          accountContext.piiDb
        );
        expect(publishExternalIdpRoute).toHaveBeenCalledOnce();
      });

      it('should not stitch if stitching is disabled', async () => {
        const env = createMockEnv({
          ENABLE_IDENTITY_STITCHING: 'false',
        });
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('new-linked-id');

        // No user found in PII DB (falls through to JIT provisioning)
        mockPiiQueryOne.mockResolvedValueOnce(null);

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          tenantId: 'default',
        });

        // Should JIT provision instead of stitching
        expect(result.isNewUser).toBe(true);
      });

      it('should not stitch if provider autoLinkEmail is disabled', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('new-linked-id');

        const providerNoAutoLink = { ...mockProvider, autoLinkEmail: false };

        // No user found in PII DB (falls through to JIT provisioning)
        mockPiiQueryOne.mockResolvedValueOnce(null);

        const result = await handleIdentity(env as never, {
          provider: providerNoAutoLink,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          tenantId: 'default',
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

        // Should throw error because email is not verified
        await expect(
          handleIdentity(env as never, {
            provider: mockProvider,
            userInfo: unverifiedUserInfo,
            tokens: mockTokens,
            tenantId: 'default',
          })
        ).rejects.toThrow('email from your external account is not verified');
      });

      it('should not stitch if existing user email is not verified', async () => {
        const env = createMockEnv();
        mockResolveAccountContext
          .mockRejectedValueOnce(new Error('account_data_route_not_found'))
          .mockResolvedValueOnce({
            tenantId: 'default',
            accountId: 'account:existing-user-unverified',
            legacyUserId: 'existing-user-unverified',
            coreDb: env.DB,
            piiDb: env.DB_PII,
          });
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);

        // Mock findUserByEmail - canonical runtime store preserves the PII/Non-PII DB split:
        // 1. DB_PII resolves the email to a runtime user owner (PII DB)
        mockPiiQueryOne.mockResolvedValueOnce({
          id: 'existing-user-unverified',
          email: 'test@example.com',
        });
        // 2. DB resolves non-PII account state (Core DB)
        mockCoreQueryOne.mockResolvedValueOnce({
          id: 'existing-user-unverified',
          email_verified: 0, // Not verified
        });

        // Should throw error because local email is not verified
        await expect(
          handleIdentity(env as never, {
            provider: mockProvider,
            userInfo: mockUserInfo,
            tokens: mockTokens,
            tenantId: 'default',
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
        mockPiiQueryOne.mockResolvedValueOnce(null);

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          tenantId: 'default',
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
        mockPiiQueryOne.mockResolvedValueOnce(null);

        await expect(
          handleIdentity(env as never, {
            provider: providerNoJIT,
            userInfo: mockUserInfo,
            tokens: mockTokens,
            tenantId: 'default',
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

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: userInfoNoEmail,
          tokens: mockTokens,
          tenantId: 'default',
        });

        expect(result.isNewUser).toBe(true);
      });

      it('should reject JIT provisioning when required custom claims are missing', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);

        mockPiiQueryOne.mockResolvedValueOnce(null);
        mockValidateCustomClaimWrite.mockResolvedValueOnce({
          ok: false,
          error: 'Department is required',
          missingRequiredFields: [
            {
              fieldKey: 'department',
              label: 'Department',
              fieldType: 'string',
            },
          ],
        });

        await expect(
          handleIdentity(env as never, {
            provider: mockProvider,
            userInfo: mockUserInfo,
            tokens: mockTokens,
            tenantId: 'default',
          })
        ).rejects.toMatchObject({
          code: 'required_custom_claims_missing',
          details: expect.objectContaining({
            validationError: 'Department is required',
            missingRequiredFields: [
              {
                fieldKey: 'department',
                label: 'Department',
                fieldType: 'string',
              },
            ],
          }),
        });
      });

      it('should map provider claims into custom claims during JIT provisioning', async () => {
        const env = createMockEnv();
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValueOnce(null);
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('new-linked-id');

        const providerWithCustomMapping: UpstreamProvider = {
          ...mockProvider,
          attributeMapping: {
            sub: 'sub',
            email: 'email',
            'custom_claims.department': 'profile.department',
            'custom_fields.employee_number': 'profile.employee_number',
          },
        };

        const mappedUserInfo: UserInfo = {
          ...mockUserInfo,
          profile: {
            department: 'Engineering',
            employee_number: 'E-100',
          },
        };

        await handleIdentity(env as never, {
          provider: providerWithCustomMapping,
          userInfo: mappedUserInfo,
          tokens: mockTokens,
          tenantId: 'default',
        });

        expect(mockValidateCustomClaimWrite).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: 'default',
            submitted: {
              department: 'Engineering',
              employee_number: 'E-100',
            },
          })
        );
        expect(mockProvisionExternalIdpAccount).toHaveBeenCalledWith(
          expect.objectContaining({
            runtimeUser: expect.objectContaining({
              sensitiveValues: expect.objectContaining({ email: 'test@example.com' }),
            }),
          })
        );
      });

      it('returns a durable pending result without exposing provider tokens to Lookup routing', async () => {
        mockResolveAccountContext.mockRejectedValue(new Error('account_data_route_not_found'));
        const tenantMetadataDb = { _isPii: false, role: 'tenant_core/default' };
        mockResolveTenantMetadataContext.mockResolvedValue({
          tenantId: 'default',
          coreDb: tenantMetadataDb,
          route: {},
        });
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
        const provisionExternalIdpAccount = vi.fn().mockResolvedValue({
          status: 202,
          operationId: 'account-create-operation-a',
          accountId: 'account:user-a',
          userId: 'user-a',
        });
        const env = createMockEnv({
          RP_TOKEN_ENCRYPTION_KEY:
            '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
          EXTERNAL_IDP_ACCOUNT_PROVISIONER: { provisionExternalIdpAccount },
        });

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          tenantId: 'default',
        });

        expect(result).toMatchObject({
          status: 'pending',
          userId: 'user-a',
          accountId: 'account:user-a',
          operationId: 'account-create-operation-a',
        });
        expect(mockCreateRuleEvaluator).toHaveBeenCalledWith(tenantMetadataDb, env.SETTINGS);
        const request = provisionExternalIdpAccount.mock.calls[0][0];
        expect(request.externalSubject).toEqual({
          issuer: mockProvider.id,
          subject: mockUserInfo.sub,
        });
        expect(request.externalIdentity.accessTokenEncrypted).not.toContain(
          mockTokens.access_token
        );
        expect(request.externalIdentity.refreshTokenEncrypted).toBeNull();
      });

      it('activates linked identity only after the account route and JIT plan are reflected', async () => {
        const accountContext = {
          accountId: 'account:user-a',
          legacyUserId: 'user-a',
          coreDb: { _isPii: false },
          piiDb: { _isPii: true },
        };
        mockResolveAccountContext
          .mockRejectedValueOnce(new Error('account_data_route_not_found'))
          .mockRejectedValueOnce(new Error('account_data_route_not_found'))
          .mockResolvedValue(accountContext);
        vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
        let authority: Record<string, unknown> | undefined;
        const provisionExternalIdpAccount = vi.fn().mockImplementation(async (request) => {
          authority = request.externalIdentity;
          return {
            status: 201,
            operationId: request.operationId,
            accountId: 'account:user-a',
            userId: 'user-a',
          };
        });
        mockFindPendingIdentity.mockImplementation(async () => ({
          id: authority?.id,
          tenantId: 'default',
          userId: 'user-a',
          providerId: mockProvider.id,
          providerUserId: mockUserInfo.sub,
          profileDataEncrypted: authority?.profileDataEncrypted,
        }));
        const env = createMockEnv({
          RP_TOKEN_ENCRYPTION_KEY:
            '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
          EXTERNAL_IDP_ACCOUNT_PROVISIONER: { provisionExternalIdpAccount },
          SETTINGS: {
            get: vi.fn(async (key: string) =>
              key === 'jit_provisioning_config'
                ? JSON.stringify({
                    enabled: true,
                    join_all_matching_orgs: false,
                    allow_user_without_org: true,
                    default_role_id: null,
                    allow_unverified_domain_mappings: false,
                  })
                : null
            ),
          },
        });

        const result = await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          tenantId: 'default',
        });

        expect(result).toMatchObject({ status: 'ready', userId: 'user-a', isNewUser: true });
        expect(mockPersistCustomClaimWrite).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 'user-a', db: accountContext.coreDb })
        );
        expect(mockSyncUserLifecycleState).toHaveBeenCalled();
        expect(mockActivatePendingIdentity).toHaveBeenCalledWith(
          env,
          expect.objectContaining({ userId: 'user-a' }),
          accountContext.piiDb
        );
      });

      it('rejects a decrypted JIT plan with an incomplete persistence shape', async () => {
        const encryptionKey = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
        const accountContext = {
          accountId: 'account:user-a',
          legacyUserId: 'user-a',
          coreDb: { _isPii: false },
          piiDb: { _isPii: true },
        };
        mockResolveAccountContext.mockResolvedValue(accountContext);
        mockFindPendingIdentity.mockResolvedValue({
          id: 'external-link-a',
          tenantId: 'default',
          userId: 'user-a',
          providerId: mockProvider.id,
          providerUserId: mockUserInfo.sub,
          profileDataEncrypted: await encrypt(
            JSON.stringify({
              schemaVersion: 1,
              customClaimValidation: { ok: true },
              organizationIds: [],
              roleAssignments: [],
              defaultRoleId: null,
              matchedRules: [],
              attributesSet: [],
            }),
            encryptionKey
          ),
        });
        const env = createMockEnv({ RP_TOKEN_ENCRYPTION_KEY: encryptionKey });

        await expect(
          completeExternalIdpJIT(env as never, {
            tenantId: 'default',
            userId: 'user-a',
            providerId: mockProvider.id,
            providerUserId: mockUserInfo.sub,
          })
        ).rejects.toThrow('external_idp_jit_plan_invalid');
        expect(mockPersistCustomClaimWrite).not.toHaveBeenCalled();
        expect(mockActivatePendingIdentity).not.toHaveBeenCalled();
      });
    });

    describe('Audit Logging', () => {
      it('should log audit event for explicit linking', async () => {
        const env = createMockEnv();
        mockResolveAccountContext.mockResolvedValue({
          tenantId: 'default',
          accountId: 'account:existing-user-456',
          legacyUserId: 'existing-user-456',
          coreDb: env.DB,
          piiDb: env.DB_PII,
        });
        vi.mocked(linkedIdentityStore.createLinkedIdentity).mockResolvedValueOnce('linked-id-123');

        await handleIdentity(env as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokens,
          tenantId: 'default',
          linkingUserId: 'existing-user-456',
        });

        expect(mockCreateAuditLog).toHaveBeenCalledWith(
          env,
          expect.objectContaining({
            userId: 'existing-user-456',
            action: 'identity_linked',
            resource: 'linked_identity',
            resourceId: 'linked-id-123',
          })
        );
      });
    });
  });

  describe('hasPasskeyCredential', () => {
    it('should return true if user has passkey', async () => {
      const env = createMockEnv();
      mockCoreQueryOne.mockResolvedValueOnce({ count: 1 });

      const result = await hasPasskeyCredential(env as never, 'default', 'user-123', {
        coreDb: env.DB,
        piiDb: env.DB_PII,
      } as never);

      expect(result).toBe(true);
    });

    it('should return false if user has no passkey', async () => {
      const env = createMockEnv();
      mockCoreQueryOne.mockResolvedValueOnce({ count: 0 });

      const result = await hasPasskeyCredential(env as never, 'default', 'user-123', {
        coreDb: env.DB,
        piiDb: env.DB_PII,
      } as never);

      expect(result).toBe(false);
    });

    it('should return false if query returns null', async () => {
      const env = createMockEnv();
      mockCoreQueryOne.mockResolvedValueOnce(null);

      const result = await hasPasskeyCredential(env as never, 'default', 'user-123', {
        coreDb: env.DB,
        piiDb: env.DB_PII,
      } as never);

      expect(result).toBe(false);
    });
  });
});
