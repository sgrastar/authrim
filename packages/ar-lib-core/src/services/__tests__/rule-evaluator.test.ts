/**
 * Rule Evaluator Service Unit Tests
 *
 * Tests for the policy rule evaluation engine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  RuleCondition,
  CompoundCondition,
  RuleAction,
  RoleAssignmentRule,
  RuleEvaluationContext,
  RuleEvaluationResult,
} from '../../types/policy-rules';

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
import { RuleEvaluator, createRuleEvaluator } from '../rule-evaluator';

describe('Rule Evaluator Service', () => {
  let evaluator: RuleEvaluator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockD1.all.mockResolvedValue({ results: [] });
    mockKV.get.mockResolvedValue(null);
    evaluator = new RuleEvaluator(mockD1 as unknown as D1Database);
  });

  describe('createRuleEvaluator Factory', () => {
    it('accepts a DatabaseAdapter source', () => {
      const mockAdapter = {
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn(),
        transaction: vi.fn(),
        batch: vi.fn(),
        isHealthy: vi.fn(),
        getType: vi.fn().mockReturnValue('mock'),
        close: vi.fn(),
      };

      const evaluator = createRuleEvaluator(mockAdapter as never);

      expect(evaluator).toBeInstanceOf(RuleEvaluator);
    });
  });

  describe('Basic Rule Evaluation', () => {
    const baseContext: RuleEvaluationContext = {
      email_domain_hash: 'abc123hash',
      email_verified: true,
      idp_claims: {},
      provider_id: 'google',
      tenant_id: 'default',
    };

    it('should return empty result when no rules exist', async () => {
      mockD1.all.mockResolvedValue({ results: [] });

      const result = await evaluator.evaluate(baseContext);

      expect(result.matched_rules).toEqual([]);
      expect(result.roles_to_assign).toEqual([]);
      expect(result.orgs_to_join).toEqual([]);
      expect(result.denied).toBe(false);
    });

    it('should match rule with email_domain_hash condition', async () => {
      const rule: Partial<RoleAssignmentRule> = {
        id: 'rule-1',
        name: 'Company Domain Rule',
        role_id: 'role_admin',
        scope_type: 'global',
        scope_target: '',
        condition: {
          field: 'email_domain_hash',
          operator: 'eq',
          value: 'abc123hash',
        },
        actions: [
          { type: 'assign_role', role_id: 'role_admin', scope_type: 'global', scope_target: '' },
        ],
        priority: 100,
        is_active: true,
        stop_processing: false,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(rule)],
      });

      const result = await evaluator.evaluate(baseContext);

      expect(result.matched_rules).toContain('rule-1');
      expect(result.roles_to_assign).toContainEqual({
        role_id: 'role_admin',
        scope_type: 'global',
        scope_target: '',
      });
    });

    it('should not match rule when condition fails', async () => {
      const rule: Partial<RoleAssignmentRule> = {
        id: 'rule-1',
        name: 'Different Domain Rule',
        role_id: 'role_admin',
        scope_type: 'global',
        scope_target: '',
        condition: {
          field: 'email_domain_hash',
          operator: 'eq',
          value: 'different-hash',
        },
        actions: [
          { type: 'assign_role', role_id: 'role_admin', scope_type: 'global', scope_target: '' },
        ],
        priority: 100,
        is_active: true,
        stop_processing: false,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(rule)],
      });

      const result = await evaluator.evaluate(baseContext);

      expect(result.matched_rules).not.toContain('rule-1');
      expect(result.roles_to_assign).toEqual([]);
    });
  });

  describe('Compound Conditions', () => {
    const baseContext: RuleEvaluationContext = {
      email_domain_hash: 'company-hash',
      email_verified: true,
      idp_claims: { groups: ['admin', 'developers'] },
      provider_id: 'google',
      tenant_id: 'default',
    };

    it('should match AND compound condition when all sub-conditions match', async () => {
      const rule: Partial<RoleAssignmentRule> = {
        id: 'rule-and',
        name: 'AND Rule',
        role_id: 'role_admin',
        scope_type: 'global',
        scope_target: '',
        condition: {
          type: 'and',
          conditions: [
            { field: 'email_domain_hash', operator: 'eq', value: 'company-hash' },
            { field: 'email_verified', operator: 'eq', value: true },
          ],
        },
        actions: [
          { type: 'assign_role', role_id: 'role_admin', scope_type: 'global', scope_target: '' },
        ],
        priority: 100,
        is_active: true,
        stop_processing: false,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(rule)],
      });

      const result = await evaluator.evaluate(baseContext);

      expect(result.matched_rules).toContain('rule-and');
    });

    it('should not match AND condition when any sub-condition fails', async () => {
      const rule: Partial<RoleAssignmentRule> = {
        id: 'rule-and',
        name: 'AND Rule',
        role_id: 'role_admin',
        scope_type: 'global',
        scope_target: '',
        condition: {
          type: 'and',
          conditions: [
            { field: 'email_domain_hash', operator: 'eq', value: 'company-hash' },
            { field: 'email_verified', operator: 'eq', value: false }, // This won't match
          ],
        },
        actions: [
          { type: 'assign_role', role_id: 'role_admin', scope_type: 'global', scope_target: '' },
        ],
        priority: 100,
        is_active: true,
        stop_processing: false,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(rule)],
      });

      const result = await evaluator.evaluate(baseContext);

      expect(result.matched_rules).not.toContain('rule-and');
    });

    it('should match OR compound condition when any sub-condition matches', async () => {
      const rule: Partial<RoleAssignmentRule> = {
        id: 'rule-or',
        name: 'OR Rule',
        role_id: 'role_admin',
        scope_type: 'global',
        scope_target: '',
        condition: {
          type: 'or',
          conditions: [
            { field: 'email_domain_hash', operator: 'eq', value: 'wrong-hash' },
            { field: 'email_verified', operator: 'eq', value: true }, // This matches
          ],
        },
        actions: [
          { type: 'assign_role', role_id: 'role_admin', scope_type: 'global', scope_target: '' },
        ],
        priority: 100,
        is_active: true,
        stop_processing: false,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(rule)],
      });

      const result = await evaluator.evaluate(baseContext);

      expect(result.matched_rules).toContain('rule-or');
    });
  });

  describe('IdP Claim Conditions', () => {
    it('should match idp_claim condition with claim_path', async () => {
      const context: RuleEvaluationContext = {
        email_domain_hash: 'hash',
        email_verified: true,
        idp_claims: { groups: ['admin', 'users'] },
        provider_id: 'google',
        tenant_id: 'default',
      };

      const rule: Partial<RoleAssignmentRule> = {
        id: 'rule-claim',
        name: 'Admin Group Rule',
        role_id: 'role_admin',
        scope_type: 'global',
        scope_target: '',
        condition: {
          field: 'idp_claim',
          claim_path: 'groups',
          operator: 'contains',
          value: 'admin',
        },
        actions: [
          { type: 'assign_role', role_id: 'role_admin', scope_type: 'global', scope_target: '' },
        ],
        priority: 100,
        is_active: true,
        stop_processing: false,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(rule)],
      });

      const result = await evaluator.evaluate(context);

      expect(result.matched_rules).toContain('rule-claim');
    });

    it('should match nested claim path', async () => {
      const context: RuleEvaluationContext = {
        email_domain_hash: 'hash',
        email_verified: true,
        idp_claims: {
          address: {
            country: 'US',
            city: 'San Francisco',
          },
        },
        provider_id: 'azure',
        tenant_id: 'default',
      };

      const rule: Partial<RoleAssignmentRule> = {
        id: 'rule-nested',
        name: 'US Users Rule',
        role_id: 'role_us_user',
        scope_type: 'global',
        scope_target: '',
        condition: {
          field: 'idp_claim',
          claim_path: 'address.country',
          operator: 'eq',
          value: 'US',
        },
        actions: [
          { type: 'assign_role', role_id: 'role_us_user', scope_type: 'global', scope_target: '' },
        ],
        priority: 100,
        is_active: true,
        stop_processing: false,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(rule)],
      });

      const result = await evaluator.evaluate(context);

      expect(result.matched_rules).toContain('rule-nested');
    });
  });

  describe('Priority and Stop Processing', () => {
    const baseContext: RuleEvaluationContext = {
      email_domain_hash: 'hash',
      email_verified: true,
      idp_claims: {},
      provider_id: 'google',
      tenant_id: 'default',
    };

    it('should evaluate rules in priority order (DESC)', async () => {
      const lowPriorityRule: Partial<RoleAssignmentRule> = {
        id: 'rule-low',
        name: 'Low Priority',
        role_id: 'role_user',
        scope_type: 'global',
        scope_target: '',
        condition: { field: 'email_verified', operator: 'eq', value: true },
        actions: [
          { type: 'assign_role', role_id: 'role_user', scope_type: 'global', scope_target: '' },
        ],
        priority: 10,
        is_active: true,
        stop_processing: false,
      };

      const highPriorityRule: Partial<RoleAssignmentRule> = {
        id: 'rule-high',
        name: 'High Priority',
        role_id: 'role_admin',
        scope_type: 'global',
        scope_target: '',
        condition: { field: 'email_verified', operator: 'eq', value: true },
        actions: [
          { type: 'assign_role', role_id: 'role_admin', scope_type: 'global', scope_target: '' },
        ],
        priority: 100,
        is_active: true,
        stop_processing: false,
      };

      // Return in priority DESC order (as the query would)
      mockD1.all.mockResolvedValue({
        results: [ruleToRow(highPriorityRule), ruleToRow(lowPriorityRule)],
      });

      const result = await evaluator.evaluate(baseContext);

      // Both rules should match
      expect(result.matched_rules).toContain('rule-high');
      expect(result.matched_rules).toContain('rule-low');
      expect(result.roles_to_assign).toHaveLength(2);
    });

    it('should stop evaluation when stop_processing=true rule matches', async () => {
      const stopRule: Partial<RoleAssignmentRule> = {
        id: 'rule-stop',
        name: 'Stop Rule',
        role_id: 'role_vip',
        scope_type: 'global',
        scope_target: '',
        condition: { field: 'email_verified', operator: 'eq', value: true },
        actions: [
          { type: 'assign_role', role_id: 'role_vip', scope_type: 'global', scope_target: '' },
        ],
        priority: 100,
        is_active: true,
        stop_processing: true, // Stop after this rule
      };

      const afterStopRule: Partial<RoleAssignmentRule> = {
        id: 'rule-after',
        name: 'After Stop Rule',
        role_id: 'role_user',
        scope_type: 'global',
        scope_target: '',
        condition: { field: 'email_verified', operator: 'eq', value: true },
        actions: [
          { type: 'assign_role', role_id: 'role_user', scope_type: 'global', scope_target: '' },
        ],
        priority: 50,
        is_active: true,
        stop_processing: false,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(stopRule), ruleToRow(afterStopRule)],
      });

      const result = await evaluator.evaluate(baseContext);

      // Only the stop rule should be processed
      expect(result.matched_rules).toContain('rule-stop');
      expect(result.matched_rules).not.toContain('rule-after');
      expect(result.roles_to_assign).toHaveLength(1);
      expect(result.roles_to_assign[0].role_id).toBe('role_vip');
    });
  });

  describe('Deny Actions', () => {
    const baseContext: RuleEvaluationContext = {
      email_domain_hash: 'blocked-domain-hash',
      email_verified: true,
      idp_claims: {},
      provider_id: 'google',
      tenant_id: 'default',
    };

    it('should return denied=true when deny action matches', async () => {
      const denyRule: Partial<RoleAssignmentRule> = {
        id: 'rule-deny',
        name: 'Block Domain Rule',
        role_id: '',
        scope_type: 'global',
        scope_target: '',
        condition: {
          field: 'email_domain_hash',
          operator: 'eq',
          value: 'blocked-domain-hash',
        },
        actions: [
          {
            type: 'deny',
            deny_code: 'access_denied',
            deny_description: 'Domain not allowed',
          },
        ],
        priority: 1000, // High priority
        is_active: true,
        stop_processing: true,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(denyRule)],
      });

      const result = await evaluator.evaluate(baseContext);

      expect(result.denied).toBe(true);
      expect(result.deny_code).toBe('access_denied');
      expect(result.deny_description).toBe('Domain not allowed');
    });

    it('should map deny_code to OIDC error codes', async () => {
      const testCases: Array<{ deny_code: string; expected_error: string }> = [
        { deny_code: 'access_denied', expected_error: 'access_denied' },
        { deny_code: 'interaction_required', expected_error: 'interaction_required' },
        { deny_code: 'login_required', expected_error: 'login_required' },
      ];

      for (const tc of testCases) {
        const denyRule: Partial<RoleAssignmentRule> = {
          id: 'rule-deny',
          name: 'Deny Rule',
          role_id: '',
          scope_type: 'global',
          scope_target: '',
          condition: { field: 'email_verified', operator: 'eq', value: true },
          actions: [{ type: 'deny', deny_code: tc.deny_code as any }],
          priority: 100,
          is_active: true,
          stop_processing: true,
        };

        mockD1.all.mockResolvedValue({
          results: [ruleToRow(denyRule)],
        });

        const result = await evaluator.evaluate(baseContext);

        expect(result.deny_code).toBe(tc.expected_error);
      }
    });
  });

  describe('Organization Join Actions', () => {
    const baseContext: RuleEvaluationContext = {
      email_domain_hash: 'company-hash',
      email_verified: true,
      idp_claims: {},
      provider_id: 'google',
      tenant_id: 'default',
    };

    it('should collect org IDs to join from matched rules', async () => {
      const orgRule: Partial<RoleAssignmentRule> = {
        id: 'rule-org',
        name: 'Auto Join Org Rule',
        role_id: 'role_member',
        scope_type: 'organization',
        scope_target: 'org-123',
        condition: {
          field: 'email_domain_hash',
          operator: 'eq',
          value: 'company-hash',
        },
        actions: [
          { type: 'join_org', org_id: 'org-123' },
          {
            type: 'assign_role',
            role_id: 'role_member',
            scope_type: 'organization',
            scope_target: 'org-123',
          },
        ],
        priority: 100,
        is_active: true,
        stop_processing: false,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(orgRule)],
      });

      const result = await evaluator.evaluate(baseContext);

      expect(result.orgs_to_join).toContain('org-123');
    });

    it('should handle org_id=auto for domain-based resolution', async () => {
      const autoOrgRule: Partial<RoleAssignmentRule> = {
        id: 'rule-auto-org',
        name: 'Auto Org Resolution',
        role_id: 'role_member',
        scope_type: 'organization',
        scope_target: 'auto',
        condition: { field: 'email_verified', operator: 'eq', value: true },
        actions: [{ type: 'join_org', org_id: 'auto' }],
        priority: 100,
        is_active: true,
        stop_processing: false,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(autoOrgRule)],
      });

      const result = await evaluator.evaluate(baseContext);

      // 'auto' should be included to signal domain-based resolution
      expect(result.orgs_to_join).toContain('auto');
    });
  });

  describe('Rule Validity Period', () => {
    const baseContext: RuleEvaluationContext = {
      email_domain_hash: 'hash',
      email_verified: true,
      idp_claims: {},
      provider_id: 'google',
      tenant_id: 'default',
    };

    it('should skip rules outside valid period', async () => {
      const now = Date.now();
      const expiredRule: Partial<RoleAssignmentRule> = {
        id: 'rule-expired',
        name: 'Expired Rule',
        role_id: 'role_temp',
        scope_type: 'global',
        scope_target: '',
        condition: { field: 'email_verified', operator: 'eq', value: true },
        actions: [
          { type: 'assign_role', role_id: 'role_temp', scope_type: 'global', scope_target: '' },
        ],
        priority: 100,
        is_active: true,
        stop_processing: false,
        valid_from: now - 86400000 * 30, // 30 days ago
        valid_until: now - 86400000, // Expired yesterday
      };

      // The DB query should filter these out, but evaluator should double-check
      mockD1.all.mockResolvedValue({
        results: [ruleToRow(expiredRule)],
      });

      const result = await evaluator.evaluate(baseContext);

      // Rule should not match due to expired valid_until
      expect(result.matched_rules).not.toContain('rule-expired');
    });

    it('should match rules with null validity period (always valid)', async () => {
      const alwaysValidRule: Partial<RoleAssignmentRule> = {
        id: 'rule-always',
        name: 'Always Valid Rule',
        role_id: 'role_default',
        scope_type: 'global',
        scope_target: '',
        condition: { field: 'email_verified', operator: 'eq', value: true },
        actions: [
          { type: 'assign_role', role_id: 'role_default', scope_type: 'global', scope_target: '' },
        ],
        priority: 100,
        is_active: true,
        stop_processing: false,
        valid_from: undefined,
        valid_until: undefined,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(alwaysValidRule)],
      });

      const result = await evaluator.evaluate(baseContext);

      expect(result.matched_rules).toContain('rule-always');
    });
  });

  describe('Caching', () => {
    it('should use cached rules when cache is valid', async () => {
      const evaluatorWithCache = new RuleEvaluator(
        mockD1 as unknown as D1Database,
        mockKV as unknown as KVNamespace
      );

      // Cache stores RoleAssignmentRule[] objects, not DB rows
      const cachedRules: Partial<RoleAssignmentRule>[] = [
        {
          id: 'cached-rule',
          tenant_id: 'default',
          name: 'Cached Rule',
          role_id: 'role_cached',
          scope_type: 'global',
          scope_target: '',
          condition: { field: 'email_verified', operator: 'eq', value: true },
          actions: [
            { type: 'assign_role', role_id: 'role_cached', scope_type: 'global', scope_target: '' },
          ],
          priority: 100,
          is_active: true,
          stop_processing: false,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ];

      mockKV.get.mockResolvedValue(JSON.stringify(cachedRules));

      const context: RuleEvaluationContext = {
        email_domain_hash: 'hash',
        email_verified: true,
        idp_claims: {},
        provider_id: 'google',
        tenant_id: 'default',
      };

      const result = await evaluatorWithCache.evaluate(context);

      // Should use cached rules, not query DB
      expect(mockD1.all).not.toHaveBeenCalled();
      expect(result.matched_rules).toContain('cached-rule');
    });

    it('should refresh rules from DB when cache is empty', async () => {
      const evaluatorWithCache = new RuleEvaluator(
        mockD1 as unknown as D1Database,
        mockKV as unknown as KVNamespace
      );

      mockKV.get.mockResolvedValue(null);

      const dbRule: Partial<RoleAssignmentRule> = {
        id: 'db-rule',
        name: 'DB Rule',
        role_id: 'role_db',
        scope_type: 'global',
        scope_target: '',
        condition: { field: 'email_verified', operator: 'eq', value: true },
        actions: [
          { type: 'assign_role', role_id: 'role_db', scope_type: 'global', scope_target: '' },
        ],
        priority: 100,
        is_active: true,
        stop_processing: false,
      };

      mockD1.all.mockResolvedValue({
        results: [ruleToRow(dbRule)],
      });

      const context: RuleEvaluationContext = {
        email_domain_hash: 'hash',
        email_verified: true,
        idp_claims: {},
        provider_id: 'google',
        tenant_id: 'default',
      };

      const result = await evaluatorWithCache.evaluate(context);

      // Should query DB and cache the result
      expect(mockD1.all).toHaveBeenCalled();
      expect(mockKV.put).toHaveBeenCalled();
      expect(result.matched_rules).toContain('db-rule');
    });
  });
});

// Helper function to convert rule object to DB row format
function ruleToRow(rule: Partial<RoleAssignmentRule>): Record<string, unknown> {
  return {
    id: rule.id,
    tenant_id: 'default',
    name: rule.name,
    description: rule.description || null,
    role_id: rule.role_id,
    scope_type: rule.scope_type,
    scope_target: rule.scope_target,
    conditions_json: JSON.stringify(rule.condition),
    actions_json: JSON.stringify(rule.actions),
    priority: rule.priority,
    stop_processing: rule.stop_processing ? 1 : 0,
    is_active: rule.is_active ? 1 : 0,
    valid_from: rule.valid_from || null,
    valid_until: rule.valid_until || null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}
