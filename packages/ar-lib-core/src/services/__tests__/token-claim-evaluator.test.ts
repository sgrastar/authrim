/**
 * Token Claim Evaluator Service Unit Tests
 *
 * Tests for the custom claim embedding rule evaluation engine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  TokenClaimRule,
  TokenClaimCondition,
  TokenClaimCompoundCondition,
  TokenClaimAction,
  TokenClaimEvaluationContext,
} from '../../types/token-claim-rules';

// Mock the D1 database
const mockD1 = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn(),
  first: vi.fn(),
};

// Mock KV namespace for caching
const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
};

// Import after setting up mocks
import {
  TokenClaimEvaluator,
  createTokenClaimEvaluator,
  testTokenClaimRule,
} from '../token-claim-evaluator';

describe('Token Claim Evaluator Service', () => {
  let evaluator: TokenClaimEvaluator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockD1.all.mockResolvedValue({ results: [] });
    mockKV.get.mockResolvedValue(null);
    evaluator = new TokenClaimEvaluator(mockD1 as unknown as D1Database);
  });

  describe('Basic Rule Evaluation', () => {
    const baseContext: TokenClaimEvaluationContext = {
      tenant_id: 'default',
      subject_id: 'user_123',
      client_id: 'client_abc',
      scope: 'openid profile',
      roles: ['admin'],
      permissions: ['users:read', 'users:write'],
      org_id: 'org_456',
      org_type: 'enterprise',
      user_type: 'employee',
    };

    it('should return empty result when no rules exist', async () => {
      mockD1.all.mockResolvedValue({ results: [] });

      const result = await evaluator.evaluate(baseContext, 'access');

      expect(result.claims_to_add).toEqual({});
      expect(result.matched_rules).toEqual([]);
    });

    it('should match rule with has_role condition', async () => {
      const ruleRow = {
        id: 'rule-1',
        tenant_id: 'default',
        name: 'Admin Tier Rule',
        description: 'Add tier claim for admin users',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'has_role',
          operator: 'contains',
          value: 'admin',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'tier', claim_value: 'premium' },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(baseContext, 'access');

      expect(result.claims_to_add).toEqual({ tier: 'premium' });
      expect(result.matched_rules).toHaveLength(1);
      expect(result.matched_rules[0]).toBe('rule-1');
    });

    it('should match rule with has_permission condition (contains)', async () => {
      // Update context to have the permission we're checking for
      const contextWithWritePerm: TokenClaimEvaluationContext = {
        ...baseContext,
        permissions: ['users:read', 'users:write'],
      };
      const ruleRow = {
        id: 'rule-2',
        tenant_id: 'default',
        name: 'User Writer Rule',
        description: 'Add can_write claim for users with write permission',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'has_permission',
          operator: 'contains',
          value: 'users:write',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'can_write_users', claim_value: true },
        ]),
        priority: 50,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(contextWithWritePerm, 'access');

      expect(result.claims_to_add).toEqual({ can_write_users: true });
    });

    it('should match rule with org_type condition', async () => {
      const ruleRow = {
        id: 'rule-3',
        tenant_id: 'default',
        name: 'Enterprise Org Rule',
        description: 'Add enterprise feature flag for enterprise orgs',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'org_type',
          operator: 'eq',
          value: 'enterprise',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'enterprise_features', claim_value: true },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(baseContext, 'access');

      expect(result.claims_to_add).toEqual({ enterprise_features: true });
    });

    it('should match rule with scope_contains condition', async () => {
      const ruleRow = {
        id: 'rule-4',
        tenant_id: 'default',
        name: 'Profile Scope Rule',
        description: 'Add profile_access claim when profile scope is present',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'scope_contains',
          operator: 'contains',
          value: 'profile',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'profile_access', claim_value: true },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(baseContext, 'access');

      expect(result.claims_to_add).toEqual({ profile_access: true });
    });
  });

  describe('Compound Conditions', () => {
    const baseContext: TokenClaimEvaluationContext = {
      tenant_id: 'default',
      subject_id: 'user_123',
      client_id: 'client_abc',
      scope: 'openid',
      roles: ['admin', 'manager'],
      permissions: ['users:read'],
      org_id: 'org_456',
      org_type: 'enterprise',
    };

    it('should match AND compound condition', async () => {
      const ruleRow = {
        id: 'rule-and',
        tenant_id: 'default',
        name: 'Admin + Enterprise Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          type: 'and',
          conditions: [
            { field: 'has_role', operator: 'contains', value: 'admin' },
            { field: 'org_type', operator: 'eq', value: 'enterprise' },
          ],
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'super_admin', claim_value: true },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(baseContext, 'access');

      expect(result.claims_to_add).toEqual({ super_admin: true });
    });

    it('should not match AND condition when one part fails', async () => {
      const contextWithoutAdmin: TokenClaimEvaluationContext = {
        ...baseContext,
        roles: ['user'],
      };

      const ruleRow = {
        id: 'rule-and',
        tenant_id: 'default',
        name: 'Admin + Enterprise Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          type: 'and',
          conditions: [
            { field: 'has_role', operator: 'contains', value: 'admin' },
            { field: 'org_type', operator: 'eq', value: 'enterprise' },
          ],
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'super_admin', claim_value: true },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(contextWithoutAdmin, 'access');

      expect(result.claims_to_add).toEqual({});
    });

    it('should match OR compound condition', async () => {
      const ruleRow = {
        id: 'rule-or',
        tenant_id: 'default',
        name: 'Admin or Manager Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          type: 'or',
          conditions: [
            { field: 'has_role', operator: 'contains', value: 'admin' },
            { field: 'has_role', operator: 'contains', value: 'superuser' },
          ],
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'elevated_user', claim_value: true },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(baseContext, 'access');

      expect(result.claims_to_add).toEqual({ elevated_user: true });
    });
  });

  describe('Action Types', () => {
    const baseContext: TokenClaimEvaluationContext = {
      tenant_id: 'default',
      subject_id: 'user_123',
      client_id: 'client_abc',
      scope: 'openid',
      roles: ['admin'],
      permissions: [],
      org_id: 'org_456',
      user_type: 'employee',
    };

    it('should handle add_claim action with various types', async () => {
      const ruleRow = {
        id: 'rule-types',
        tenant_id: 'default',
        name: 'Multi-type Claims Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'has_role',
          operator: 'eq',
          value: 'admin',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'string_claim', claim_value: 'hello' },
          { type: 'add_claim', claim_name: 'number_claim', claim_value: 42 },
          { type: 'add_claim', claim_name: 'bool_claim', claim_value: true },
          { type: 'add_claim', claim_name: 'array_claim', claim_value: ['a', 'b', 'c'] },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(baseContext, 'access');

      expect(result.claims_to_add).toEqual({
        string_claim: 'hello',
        number_claim: 42,
        bool_claim: true,
        array_claim: ['a', 'b', 'c'],
      });
    });

    it('should handle add_claim_template action', async () => {
      const ruleRow = {
        id: 'rule-template',
        tenant_id: 'default',
        name: 'Template Claim Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'has_role',
          operator: 'eq',
          value: 'admin',
        }),
        actions_json: JSON.stringify([
          {
            type: 'add_claim_template',
            claim_name: 'user_info',
            template: 'User {{subject_id}} from org {{org_id}}',
          },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(baseContext, 'access');

      expect(result.claims_to_add).toEqual({
        user_info: 'User user_123 from org org_456',
      });
    });

    it('should handle copy_from_context action', async () => {
      const ruleRow = {
        id: 'rule-copy',
        tenant_id: 'default',
        name: 'Copy Context Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'has_role',
          operator: 'eq',
          value: 'admin',
        }),
        actions_json: JSON.stringify([
          { type: 'copy_from_context', claim_name: 'user_org', context_field: 'org_id' },
          { type: 'copy_from_context', claim_name: 'account_type', context_field: 'user_type' },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(baseContext, 'access');

      expect(result.claims_to_add).toEqual({
        user_org: 'org_456',
        account_type: 'employee',
      });
    });
  });

  describe('Priority and Stop Processing', () => {
    const baseContext: TokenClaimEvaluationContext = {
      tenant_id: 'default',
      subject_id: 'user_123',
      client_id: 'client_abc',
      scope: 'openid',
      roles: ['admin'],
      permissions: [],
    };

    it('should evaluate rules in priority order (DESC)', async () => {
      const lowPriorityRule = {
        id: 'rule-low',
        tenant_id: 'default',
        name: 'Low Priority Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'has_role',
          operator: 'eq',
          value: 'admin',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'tier', claim_value: 'basic' },
        ]),
        priority: 10,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };

      const highPriorityRule = {
        id: 'rule-high',
        tenant_id: 'default',
        name: 'High Priority Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'has_role',
          operator: 'eq',
          value: 'admin',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'tier', claim_value: 'premium' },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };

      // Return rules in priority DESC order (high first)
      mockD1.all.mockResolvedValue({ results: [highPriorityRule, lowPriorityRule] });

      const result = await evaluator.evaluate(baseContext, 'access');

      // Last-write-wins: low priority rule overwrites high priority
      expect(result.claims_to_add).toEqual({ tier: 'basic' });
      expect(result.matched_rules).toEqual(['rule-high', 'rule-low']);
    });

    it('should stop processing when stop_processing is true', async () => {
      const highPriorityRule = {
        id: 'rule-high',
        tenant_id: 'default',
        name: 'High Priority Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'has_role',
          operator: 'eq',
          value: 'admin',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'tier', claim_value: 'premium' },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 1, // Stop processing after this rule
        created_at: 1700000000,
        updated_at: 1700000000,
      };

      const lowPriorityRule = {
        id: 'rule-low',
        tenant_id: 'default',
        name: 'Low Priority Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'has_role',
          operator: 'eq',
          value: 'admin',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'tier', claim_value: 'basic' },
          { type: 'add_claim', claim_name: 'extra', claim_value: 'value' },
        ]),
        priority: 10,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };

      mockD1.all.mockResolvedValue({ results: [highPriorityRule, lowPriorityRule] });

      const result = await evaluator.evaluate(baseContext, 'access');

      // Only high priority rule should be applied
      expect(result.claims_to_add).toEqual({ tier: 'premium' });
      expect(result.matched_rules).toEqual(['rule-high']);
    });
  });

  describe('Token Type Filtering', () => {
    const baseContext: TokenClaimEvaluationContext = {
      tenant_id: 'default',
      subject_id: 'user_123',
      client_id: 'client_abc',
      scope: 'openid',
      roles: ['admin'],
      permissions: [],
    };

    it('should match access token rules for access tokens', async () => {
      const accessRule = {
        id: 'rule-access',
        tenant_id: 'default',
        name: 'Access Token Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'has_role',
          operator: 'eq',
          value: 'admin',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'access_claim', claim_value: true },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [accessRule] });

      const result = await evaluator.evaluate(baseContext, 'access');

      expect(result.claims_to_add).toEqual({ access_claim: true });
    });

    it('should match "both" token type rules for any token', async () => {
      const bothRule = {
        id: 'rule-both',
        tenant_id: 'default',
        name: 'Both Token Types Rule',
        token_type: 'both',
        conditions_json: JSON.stringify({
          field: 'has_role',
          operator: 'eq',
          value: 'admin',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'shared_claim', claim_value: true },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [bothRule] });

      const accessResult = await evaluator.evaluate(baseContext, 'access');
      expect(accessResult.claims_to_add).toEqual({ shared_claim: true });

      const idResult = await evaluator.evaluate(baseContext, 'id');
      expect(idResult.claims_to_add).toEqual({ shared_claim: true });
    });
  });

  describe('Reserved Claims Protection', () => {
    const baseContext: TokenClaimEvaluationContext = {
      tenant_id: 'default',
      subject_id: 'user_123',
      client_id: 'client_abc',
      scope: 'openid',
      roles: ['admin'],
      permissions: [],
    };

    it('should skip reserved claims', async () => {
      const ruleRow = {
        id: 'rule-reserved',
        tenant_id: 'default',
        name: 'Reserved Claims Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'has_role',
          operator: 'eq',
          value: 'admin',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'sub', claim_value: 'hacked_sub' },
          { type: 'add_claim', claim_name: 'iss', claim_value: 'hacked_iss' },
          { type: 'add_claim', claim_name: 'scope', claim_value: 'openid admin:all' },
          { type: 'add_claim', claim_name: 'client_id', claim_value: 'other-client' },
          { type: 'add_claim', claim_name: 'cnf', claim_value: { jkt: 'attacker' } },
          { type: 'add_claim', claim_name: 'sid', claim_value: 'other-session' },
          { type: 'add_claim', claim_name: 'token_use', claim_value: 'refresh' },
          { type: 'add_claim', claim_name: 'valid_claim', claim_value: 'allowed' },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(baseContext, 'access');

      // Reserved claims should be skipped
      expect(result.claims_to_add).toEqual({ valid_claim: 'allowed' });
      expect(result.claims_to_add).not.toHaveProperty('sub');
      expect(result.claims_to_add).not.toHaveProperty('iss');
      expect(result.claims_to_add).not.toHaveProperty('scope');
      expect(result.claims_to_add).not.toHaveProperty('client_id');
      expect(result.claims_to_add).not.toHaveProperty('cnf');
      expect(result.claims_to_add).not.toHaveProperty('sid');
      expect(result.claims_to_add).not.toHaveProperty('token_use');
    });
  });

  describe('IdP Claims Conditions', () => {
    const contextWithIdpClaims: TokenClaimEvaluationContext = {
      tenant_id: 'default',
      subject_id: 'user_123',
      client_id: 'client_abc',
      scope: 'openid',
      roles: [],
      permissions: [],
      idp_claims: {
        groups: ['engineering', 'devops'],
        department: 'tech',
        custom: {
          nested: 'value',
        },
      },
    };

    it('should match idp_claim condition', async () => {
      const ruleRow = {
        id: 'rule-idp',
        tenant_id: 'default',
        name: 'IdP Claim Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'idp_claim',
          claim_path: 'department',
          operator: 'eq',
          value: 'tech',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'tech_team', claim_value: true },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(contextWithIdpClaims, 'access');

      expect(result.claims_to_add).toEqual({ tech_team: true });
    });

    it('should match idp_claim array contains condition', async () => {
      const ruleRow = {
        id: 'rule-idp-array',
        tenant_id: 'default',
        name: 'IdP Array Claim Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'idp_claim',
          claim_path: 'groups',
          operator: 'contains',
          value: 'engineering',
        }),
        actions_json: JSON.stringify([
          { type: 'add_claim', claim_name: 'is_engineer', claim_value: true },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(contextWithIdpClaims, 'access');

      expect(result.claims_to_add).toEqual({ is_engineer: true });
    });

    it('should handle transform_idp_claim action', async () => {
      const ruleRow = {
        id: 'rule-transform',
        tenant_id: 'default',
        name: 'Transform IdP Claim Rule',
        token_type: 'access',
        conditions_json: JSON.stringify({
          field: 'idp_claim',
          claim_path: 'groups',
          operator: 'exists',
        }),
        actions_json: JSON.stringify([
          {
            type: 'transform_idp_claim',
            claim_name: 'teams',
            source_path: 'groups',
          },
        ]),
        priority: 100,
        is_active: 1,
        stop_processing: 0,
        created_at: 1700000000,
        updated_at: 1700000000,
      };
      mockD1.all.mockResolvedValue({ results: [ruleRow] });

      const result = await evaluator.evaluate(contextWithIdpClaims, 'access');

      expect(result.claims_to_add).toEqual({ teams: ['engineering', 'devops'] });
    });
  });

  describe('Caching', () => {
    const baseContext: TokenClaimEvaluationContext = {
      tenant_id: 'default',
      subject_id: 'user_123',
      client_id: 'client_abc',
      scope: 'openid',
      roles: ['admin'],
      permissions: [],
    };

    it('should use cached rules when available', async () => {
      const cachedRules = [
        {
          id: 'cached-rule',
          tenant_id: 'default',
          name: 'Cached Rule',
          token_type: 'access',
          condition: { field: 'has_role', operator: 'contains', value: 'admin' },
          actions: [{ type: 'add_claim', claim_name: 'cached', claim_value: true }],
          priority: 100,
          is_active: true,
          stop_processing: false,
          created_at: 1700000000,
          updated_at: 1700000000,
        },
      ];
      mockKV.get.mockResolvedValue(JSON.stringify(cachedRules));

      const evaluatorWithCache = new TokenClaimEvaluator(
        mockD1 as unknown as D1Database,
        mockKV as unknown as KVNamespace
      );

      const result = await evaluatorWithCache.evaluate(baseContext, 'access');

      expect(result.claims_to_add).toEqual({ cached: true });
      expect(mockD1.prepare).not.toHaveBeenCalled();
    });
  });

  describe('createTokenClaimEvaluator Factory', () => {
    it('should create evaluator with correct dependencies', () => {
      const evaluator = createTokenClaimEvaluator(mockD1 as unknown as D1Database);

      expect(evaluator).toBeInstanceOf(TokenClaimEvaluator);
    });
  });

  describe('testTokenClaimRule Helper', () => {
    const testContext: TokenClaimEvaluationContext = {
      tenant_id: 'default',
      subject_id: 'user_123',
      client_id: 'client_abc',
      scope: 'openid',
      roles: ['admin'],
      permissions: [],
    };

    it('should return detailed test results for matching rule', () => {
      const rule: TokenClaimRule = {
        id: 'test-rule',
        tenant_id: 'default',
        name: 'Test Rule',
        token_type: 'access',
        condition: { field: 'has_role', operator: 'contains', value: 'admin' },
        actions: [{ type: 'add_claim', claim_name: 'test', claim_value: true }],
        priority: 100,
        is_active: true,
        stop_processing: false,
        created_at: 1700000000,
        updated_at: 1700000000,
      };

      const result = testTokenClaimRule(rule, testContext);

      expect(result.matched).toBe(true);
      expect(result.would_add_claims).toEqual({ test: true });
    });

    it('should return detailed test results for non-matching rule', () => {
      const rule: TokenClaimRule = {
        id: 'test-rule',
        tenant_id: 'default',
        name: 'Test Rule',
        token_type: 'access',
        condition: { field: 'has_role', operator: 'contains', value: 'superuser' },
        actions: [{ type: 'add_claim', claim_name: 'test', claim_value: true }],
        priority: 100,
        is_active: true,
        stop_processing: false,
        created_at: 1700000000,
        updated_at: 1700000000,
      };

      const result = testTokenClaimRule(rule, testContext);

      expect(result.matched).toBe(false);
      expect(result.would_add_claims).toEqual({});
    });
  });
});
