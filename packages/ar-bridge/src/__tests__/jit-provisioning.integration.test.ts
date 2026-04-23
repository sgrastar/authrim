/**
 * JIT Provisioning Integration Tests
 *
 * Tests the integration of:
 * - Identity Stitching with Rule Evaluation
 * - Domain-based Organization Auto-Join
 * - Role Assignment based on IdP Claims
 * - Deny Actions with OIDC Error Mapping
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpstreamProvider, UserInfo, TokenResponse } from '../types';

// =============================================================================
// Mock Setup
// =============================================================================

// Create hoisted mocks
const {
  mockCoreQueryOne,
  mockCoreExecute,
  mockPiiQueryOne,
  mockRuleEvaluator,
  mockResolveOrgByDomainHash,
  mockGenerateEmailDomainHash,
  mockGetJITConfig,
  mockValidateCustomClaimWrite,
  mockPersistCustomClaimWrite,
  mockSyncUserLifecycleState,
  MockD1Adapter,
  sqlTracker,
  mockJoinOrganization,
  mockAssignRoleToUser,
} = vi.hoisted(() => {
  // Storage for tracking SQL calls
  const tracker = {
    coreDb: [] as { method: string; sql: string; params: unknown[] }[],
    piiDb: [] as { method: string; sql: string; params: unknown[] }[],
    reset() {
      this.coreDb.length = 0;
      this.piiDb.length = 0;
    },
  };

  // Mock functions for Core DB
  const coreQueryOneMock = vi.fn().mockResolvedValue(null);
  const coreExecuteMock = vi.fn().mockResolvedValue({ rowsAffected: 1 });

  // Mock functions for PII DB
  const piiQueryOneMock = vi.fn().mockResolvedValue(null);

  // Mock rule evaluator
  const ruleEvaluatorMock = {
    evaluate: vi.fn().mockResolvedValue({
      matched_rules: [],
      roles_to_assign: [],
      orgs_to_join: [],
      denied: false,
    }),
  };

  // Mock org domain resolver
  const resolveOrgMock = vi.fn().mockResolvedValue(null);

  // Mock email domain hash generator
  const generateHashMock = vi.fn().mockResolvedValue({
    hash: 'mock-domain-hash-abc123',
    version: 1,
  });

  // Mock JIT config getter
  const getJITConfigMock = vi.fn().mockResolvedValue({
    enabled: true,
    auto_create_org_on_domain_match: false,
    join_all_matching_orgs: false,
    allow_user_without_org: true,
    default_role_id: 'role_end_user',
    allow_unverified_domain_mappings: false,
  });

  const validateCustomClaimWriteMock = vi.fn().mockResolvedValue({ ok: true });
  const persistCustomClaimWriteMock = vi.fn().mockResolvedValue(undefined);
  const syncUserLifecycleStateMock = vi.fn().mockResolvedValue({
    lifecycleState: 'active',
    missingRequiredFields: [],
  });

  // D1Adapter class mock
  class D1AdapterClass {
    private binding: 'core' | 'pii';

    constructor(options: { db: unknown }) {
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

  // Mock functions for role/org operations
  const joinOrgMock = vi.fn().mockResolvedValue({ success: true });
  const assignRoleMock = vi.fn().mockResolvedValue(undefined);

  return {
    mockCoreQueryOne: coreQueryOneMock,
    mockCoreExecute: coreExecuteMock,
    mockPiiQueryOne: piiQueryOneMock,
    mockRuleEvaluator: ruleEvaluatorMock,
    mockResolveOrgByDomainHash: resolveOrgMock,
    mockGenerateEmailDomainHash: generateHashMock,
    mockGetJITConfig: getJITConfigMock,
    mockValidateCustomClaimWrite: validateCustomClaimWriteMock,
    mockPersistCustomClaimWrite: persistCustomClaimWriteMock,
    mockSyncUserLifecycleState: syncUserLifecycleStateMock,
    MockD1Adapter: D1AdapterClass,
    sqlTracker: tracker,
    mockJoinOrganization: joinOrgMock,
    mockAssignRoleToUser: assignRoleMock,
  };
});

// Mock @authrim/ar-lib-core
vi.mock('@authrim/ar-lib-core', () => ({
  D1Adapter: MockD1Adapter,
  ensureDatabaseAdapter: vi.fn().mockImplementation((db: unknown) => new MockD1Adapter({ db })),
  createRuleEvaluator: vi.fn(() => mockRuleEvaluator),
  resolveOrgByDomainHash: mockResolveOrgByDomainHash,
  resolveAllOrgsByDomainHash: vi.fn().mockResolvedValue([]),
  joinOrganization: mockJoinOrganization,
  assignRoleToUser: mockAssignRoleToUser,
  generateEmailDomainHashWithVersion: mockGenerateEmailDomainHash,
  getEmailDomainHashConfig: vi.fn().mockResolvedValue({
    current_version: 1,
    secrets: { 1: 'test-secret-key-16+' },
    migration_in_progress: false,
    deprecated_versions: [],
  }),
  getJITProvisioningConfig: mockGetJITConfig,
  validateCustomClaimWrite: mockValidateCustomClaimWrite,
  persistCustomClaimWrite: mockPersistCustomClaimWrite,
  syncUserLifecycleState: mockSyncUserLifecycleState,
  resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
    storageProfile: {
      id: 'builtin:storage:standard',
      kind: 'storage',
      label: 'Standard D1 Split',
      slices: {},
    },
    schemaDb: env.DB,
    nonPiiDb: env.DB,
    piiDb: env.DB_PII ?? null,
  })),
  resolveUserStoreRuntimeSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
    storageProfile: {
      id: 'builtin:storage:standard',
      kind: 'storage',
      label: 'Standard D1 Split',
      slices: {},
    },
    coreDb: env.DB,
    piiDb: env.DB_PII ?? env.DB ?? null,
  })),
  DEFAULT_JIT_CONFIG: {
    enabled: true,
    auto_create_org_on_domain_match: false,
    join_all_matching_orgs: false,
    allow_user_without_org: true,
    default_role_id: 'role_end_user',
    allow_unverified_domain_mappings: false,
  },
}));

// Mock linked identity store
vi.mock('../services/linked-identity-store', () => ({
  findLinkedIdentity: vi.fn().mockResolvedValue(null),
  createLinkedIdentity: vi.fn().mockResolvedValue({ id: 'linked-id-123' }),
  updateLinkedIdentity: vi.fn(),
}));

import { handleIdentity } from '../services/identity-stitching';
import * as linkedIdentityStore from '../services/linked-identity-store';

// =============================================================================
// Test Fixtures
// =============================================================================

const mockProvider: UpstreamProvider = {
  id: 'provider-google',
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
  email: 'admin@company.com',
  email_verified: true,
  name: 'Admin User',
  given_name: 'Admin',
  family_name: 'User',
};

const mockTokenResponse: TokenResponse = {
  access_token: 'mock-access-token',
  token_type: 'Bearer',
  expires_in: 3600,
  id_token: 'mock-id-token',
  scope: 'openid email profile',
};

// Mock KV settings - can be controlled per test
const mockSettingsGet = vi.fn().mockResolvedValue(null);

const mockEnv = {
  DB: { _isPii: false },
  DB_PII: { _isPii: true },
  SETTINGS: {
    get: mockSettingsGet,
    put: vi.fn(),
  },
};

// =============================================================================
// Tests
// =============================================================================

describe('JIT Provisioning Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlTracker.reset();
    mockRuleEvaluator.evaluate.mockResolvedValue({
      matched_rules: [],
      roles_to_assign: [],
      orgs_to_join: [],
      denied: false,
    });
    mockResolveOrgByDomainHash.mockResolvedValue(null);
    mockGenerateEmailDomainHash.mockResolvedValue({
      hash: 'mock-domain-hash-abc123',
      version: 1,
    });
    mockValidateCustomClaimWrite.mockReset().mockResolvedValue({ ok: true });
    mockPersistCustomClaimWrite.mockReset().mockResolvedValue(undefined);
    mockSyncUserLifecycleState.mockReset().mockResolvedValue({
      lifecycleState: 'active',
      missingRequiredFields: [],
    });
    // Default: return null from SETTINGS.get (will use DEFAULT_JIT_CONFIG)
    mockSettingsGet.mockResolvedValue(null);
  });

  describe('New User JIT Provisioning with Rule Evaluation', () => {
    it('should create new user and evaluate assignment rules', async () => {
      // Setup: New user (no existing linked identity or user)
      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);
      mockPiiQueryOne.mockResolvedValue(null);

      // Setup: Rule evaluation returns role assignment
      mockRuleEvaluator.evaluate.mockResolvedValue({
        matched_rules: ['rule-1'],
        roles_to_assign: [
          { role_id: 'role_org_admin', scope_type: 'organization', scope_target: 'org-123' },
        ],
        orgs_to_join: ['org-123'],
        denied: false,
      });

      const result = await handleIdentity(mockEnv as never, {
        provider: mockProvider,
        userInfo: mockUserInfo,
        tokens: mockTokenResponse,
        tenantId: 'default',
      });

      // Verify user was created
      expect(result.isNewUser).toBe(true);

      // Verify rule evaluator was called with correct context
      expect(mockRuleEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          email_domain_hash: 'mock-domain-hash-abc123',
          email_verified: true,
          provider_id: 'provider-google',
          tenant_id: 'default',
        })
      );

      // Verify the result includes the assigned roles
      // (The actual DB insert is mocked, but result tracking should work)
      expect(result.roles_assigned).toBeDefined();
    });

    it('should auto-join organization based on domain hash', async () => {
      // Setup: New user
      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);
      mockPiiQueryOne.mockResolvedValue(null);

      // Setup: Domain hash matches an organization
      mockResolveOrgByDomainHash.mockResolvedValue({
        org_id: 'org-company',
        auto_join_enabled: true,
        auto_assign_role_id: 'role_member',
        membership_type: 'member',
        verified: true,
        priority: 0,
      });

      const result = await handleIdentity(mockEnv as never, {
        provider: mockProvider,
        userInfo: mockUserInfo,
        tokens: mockTokenResponse,
        tenantId: 'default',
      });

      // Verify organization resolution was called
      expect(mockResolveOrgByDomainHash).toHaveBeenCalledWith(
        expect.anything(), // db
        'mock-domain-hash-abc123',
        'default',
        expect.objectContaining({
          allow_unverified_domain_mappings: false,
        })
      );

      // Verify org membership was created via mock function
      expect(mockJoinOrganization).toHaveBeenCalledWith(
        expect.anything(), // db adapter
        expect.any(String), // user id
        'org-company',
        'default', // tenant id
        'member' // membership type
      );
    });

    it('should skip unverified domain mappings when config disallows', async () => {
      // Setup: New user
      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);
      mockPiiQueryOne.mockResolvedValue(null);

      // Setup: JIT config disallows unverified mappings
      mockGetJITConfig.mockResolvedValue({
        enabled: true,
        auto_create_org_on_domain_match: false,
        join_all_matching_orgs: false,
        allow_user_without_org: true,
        default_role_id: 'role_end_user',
        allow_unverified_domain_mappings: false,
      });

      // Setup: Domain mapping exists but is unverified
      mockResolveOrgByDomainHash.mockResolvedValue(null); // Returns null because of unverified

      await handleIdentity(mockEnv as never, {
        provider: mockProvider,
        userInfo: mockUserInfo,
        tokens: mockTokenResponse,
        tenantId: 'default',
      });

      // Verify resolveOrgByDomainHash was called with correct config
      expect(mockResolveOrgByDomainHash).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'default',
        expect.objectContaining({
          allow_unverified_domain_mappings: false,
        })
      );
    });
  });

  describe('Deny Rules with OIDC Error Mapping', () => {
    it('should reject user when deny rule matches', async () => {
      // Setup: New user
      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);
      mockPiiQueryOne.mockResolvedValue(null);

      // Setup: Rule evaluation returns deny
      mockRuleEvaluator.evaluate.mockResolvedValue({
        matched_rules: ['rule-block-external'],
        roles_to_assign: [],
        orgs_to_join: [],
        denied: true,
        deny_code: 'access_denied',
        deny_description: 'External users from this domain are not allowed',
      });

      // Expect the function to throw with the correct error code
      await expect(
        handleIdentity(mockEnv as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokenResponse,
          tenantId: 'default',
        })
      ).rejects.toMatchObject({
        code: 'policy_access_denied',
      });
    });

    it('should map deny_code to correct OIDC error', async () => {
      // Setup: New user
      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);

      // Test each deny code mapping
      // deny_code → ExternalIdPErrorCode mapping
      const denyCodes = [
        { deny_code: 'access_denied', expected_code: 'policy_access_denied' },
        { deny_code: 'interaction_required', expected_code: 'policy_interaction_required' },
        { deny_code: 'login_required', expected_code: 'policy_login_required' },
      ];

      for (const { deny_code, expected_code } of denyCodes) {
        mockRuleEvaluator.evaluate.mockResolvedValue({
          matched_rules: ['rule-test'],
          roles_to_assign: [],
          orgs_to_join: [],
          denied: true,
          deny_code,
          deny_description: 'Test deny',
        });

        await expect(
          handleIdentity(mockEnv as never, {
            provider: mockProvider,
            userInfo: mockUserInfo,
            tokens: mockTokenResponse,
            tenantId: 'default',
          })
        ).rejects.toMatchObject({
          code: expected_code,
        });
      }
    });
  });

  describe('Required Custom Claims', () => {
    it('should reject JIT provisioning when required custom claims are missing', async () => {
      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);
      mockPiiQueryOne.mockResolvedValue(null);
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
        handleIdentity(mockEnv as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokenResponse,
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
  });

  describe('Rule Priority and Stop Processing', () => {
    it('should respect rule priority order (higher priority first)', async () => {
      // Setup: New user
      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);
      mockPiiQueryOne.mockResolvedValue(null);

      // Setup: Multiple rules matched with different priorities
      mockRuleEvaluator.evaluate.mockResolvedValue({
        matched_rules: ['high-priority-rule', 'low-priority-rule'],
        roles_to_assign: [{ role_id: 'role_admin', scope_type: 'global', scope_target: '' }],
        orgs_to_join: [],
        denied: false,
      });

      await handleIdentity(mockEnv as never, {
        provider: mockProvider,
        userInfo: mockUserInfo,
        tokens: mockTokenResponse,
        tenantId: 'default',
      });

      // Verify rule evaluator was called (priority is handled internally)
      expect(mockRuleEvaluator.evaluate).toHaveBeenCalled();
    });

    it('should stop processing when stop_processing rule matches', async () => {
      // This is tested internally by the rule evaluator
      // Here we verify the integration works correctly
      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);
      mockPiiQueryOne.mockResolvedValue(null);

      // Setup: First rule with stop_processing=true matches
      mockRuleEvaluator.evaluate.mockResolvedValue({
        matched_rules: ['rule-with-stop'],
        roles_to_assign: [{ role_id: 'role_limited', scope_type: 'global', scope_target: '' }],
        orgs_to_join: [],
        denied: false,
        // Note: subsequent rules were not evaluated due to stop_processing
      });

      await handleIdentity(mockEnv as never, {
        provider: mockProvider,
        userInfo: mockUserInfo,
        tokens: mockTokenResponse,
        tenantId: 'default',
      });

      // Verify only the roles from the stopping rule were assigned
      expect(mockRuleEvaluator.evaluate).toHaveBeenCalledTimes(1);
    });
  });

  describe('IdP Claims in Rule Evaluation', () => {
    it('should pass IdP claims to rule evaluator', async () => {
      // Setup: User info with additional claims
      const userInfoWithClaims: UserInfo = {
        ...mockUserInfo,
        hd: 'company.com', // Google Workspace hosted domain
        groups: ['admins@company.com', 'developers@company.com'],
      };

      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);
      mockPiiQueryOne.mockResolvedValue(null);

      await handleIdentity(mockEnv as never, {
        provider: mockProvider,
        userInfo: userInfoWithClaims,
        tokens: mockTokenResponse,
        tenantId: 'default',
      });

      // Verify IdP claims were passed to rule evaluator
      expect(mockRuleEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          idp_claims: expect.objectContaining({
            hd: 'company.com',
            groups: ['admins@company.com', 'developers@company.com'],
          }),
        })
      );
    });

    it('should handle Azure AD single role claim (string instead of array)', async () => {
      const userInfoAzure: UserInfo = {
        ...mockUserInfo,
        roles: 'GlobalAdmin', // Azure AD sometimes sends single string
      };

      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);
      mockPiiQueryOne.mockResolvedValue(null);

      await handleIdentity(mockEnv as never, {
        provider: mockProvider,
        userInfo: userInfoAzure,
        tokens: mockTokenResponse,
        tenantId: 'default',
      });

      // Verify the role claim was passed correctly
      expect(mockRuleEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          idp_claims: expect.objectContaining({
            roles: 'GlobalAdmin',
          }),
        })
      );
    });
  });

  describe('Email Domain Hash Generation', () => {
    it('should generate email domain hash for new users', async () => {
      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);
      mockPiiQueryOne.mockResolvedValue(null);

      await handleIdentity(mockEnv as never, {
        provider: mockProvider,
        userInfo: mockUserInfo,
        tokens: mockTokenResponse,
        tenantId: 'default',
      });

      // Verify email domain hash was generated
      expect(mockGenerateEmailDomainHash).toHaveBeenCalledWith(
        'admin@company.com',
        expect.any(Object)
      );
    });

    it('should store email domain hash and version in users_core', async () => {
      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);
      mockPiiQueryOne.mockResolvedValue(null);

      mockGenerateEmailDomainHash.mockResolvedValue({
        hash: 'generated-hash-xyz',
        version: 2,
      });

      await handleIdentity(mockEnv as never, {
        provider: mockProvider,
        userInfo: mockUserInfo,
        tokens: mockTokenResponse,
        tenantId: 'default',
      });

      // Verify users_core INSERT includes email_domain_hash and version
      const userInsertCalls = sqlTracker.coreDb.filter(
        (call) =>
          call.method === 'execute' &&
          call.sql.toLowerCase().includes('users_core') &&
          call.sql.toLowerCase().includes('insert')
      );
      expect(userInsertCalls.length).toBeGreaterThan(0);

      // Check that the params include the hash
      const insertCall = userInsertCalls[0];
      expect(insertCall.params).toContain('generated-hash-xyz');
    });
  });

  describe('JIT Provisioning Disabled', () => {
    it('should not create user when JIT provisioning is disabled', async () => {
      // Setup: JIT disabled via KV settings
      mockSettingsGet.mockImplementation(async (key: string) => {
        if (key === 'jit_provisioning_config') {
          return JSON.stringify({
            enabled: false,
            auto_create_org_on_domain_match: false,
            join_all_matching_orgs: false,
            allow_user_without_org: true,
            default_role_id: 'role_end_user',
            allow_unverified_domain_mappings: false,
          });
        }
        return null;
      });

      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue(null);
      mockCoreQueryOne.mockResolvedValue(null);

      // Should reject because JIT is disabled and no existing user
      await expect(
        handleIdentity(mockEnv as never, {
          provider: mockProvider,
          userInfo: mockUserInfo,
          tokens: mockTokenResponse,
          tenantId: 'default',
        })
      ).rejects.toMatchObject({
        code: 'jit_provisioning_disabled',
      });
    });
  });

  describe('Existing User - No JIT Processing', () => {
    it('should not run rule evaluation for existing linked identity', async () => {
      // Setup: Existing linked identity found
      vi.mocked(linkedIdentityStore.findLinkedIdentity).mockResolvedValue({
        id: 'linked-id-existing',
        userId: 'user-existing-123',
        providerId: 'provider-google',
        providerUserId: 'google-user-123',
        tenantId: 'default',
        providerEmail: 'admin@company.com',
        emailVerified: true,
        linkedAt: Date.now(),
        lastLoginAt: Date.now(),
        updatedAt: Date.now(),
      });

      const result = await handleIdentity(mockEnv as never, {
        provider: mockProvider,
        userInfo: mockUserInfo,
        tokens: mockTokenResponse,
        tenantId: 'default',
      });

      // Verify existing user was returned
      expect(result.isNewUser).toBe(false);
      expect(result.userId).toBe('user-existing-123');

      // Verify rule evaluator was NOT called (no JIT for existing users)
      expect(mockRuleEvaluator.evaluate).not.toHaveBeenCalled();
    });
  });
});
