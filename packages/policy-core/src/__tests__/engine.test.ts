/**
 * Policy Engine Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyEngine, createDefaultPolicyEngine } from '../engine';
import type { PolicyContext, PolicyRule } from '../types';

describe('PolicyEngine', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  describe('addRule', () => {
    it('should add a rule', () => {
      const rule: PolicyRule = {
        id: 'test_rule',
        name: 'Test Rule',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'has_role', params: { role: 'admin' } }],
      };

      engine.addRule(rule);
      const context = createTestContext({ roles: [{ name: 'admin', scope: 'global' }] });
      const decision = engine.evaluate(context);

      expect(decision.allowed).toBe(true);
    });

    it('should sort rules by priority (higher first)', () => {
      engine.addRule({
        id: 'low_priority',
        name: 'Low Priority',
        priority: 10,
        effect: 'deny',
        conditions: [{ type: 'has_role', params: { role: 'user' } }],
      });

      engine.addRule({
        id: 'high_priority',
        name: 'High Priority',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'has_role', params: { role: 'user' } }],
      });

      const context = createTestContext({ roles: [{ name: 'user', scope: 'global' }] });
      const decision = engine.evaluate(context);

      expect(decision.allowed).toBe(true);
      expect(decision.decidedBy).toBe('high_priority');
    });
  });

  describe('addRules', () => {
    it('should add multiple rules', () => {
      const rules: PolicyRule[] = [
        {
          id: 'rule1',
          name: 'Rule 1',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'has_role', params: { role: 'admin' } }],
        },
        {
          id: 'rule2',
          name: 'Rule 2',
          priority: 50,
          effect: 'deny',
          conditions: [{ type: 'has_role', params: { role: 'guest' } }],
        },
      ];

      engine.addRules(rules);
      const context = createTestContext({ roles: [{ name: 'admin', scope: 'global' }] });
      const decision = engine.evaluate(context);

      expect(decision.allowed).toBe(true);
    });
  });

  describe('clearRules', () => {
    it('should clear all rules', () => {
      engine.addRule({
        id: 'test_rule',
        name: 'Test Rule',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'has_role', params: { role: 'admin' } }],
      });

      engine.clearRules();
      const context = createTestContext({ roles: [{ name: 'admin', scope: 'global' }] });
      const decision = engine.evaluate(context);

      expect(decision.allowed).toBe(false);
      expect(decision.decidedBy).toBe('default');
    });
  });

  describe('evaluate', () => {
    it('should return default deny when no rules match', () => {
      const context = createTestContext({ roles: [{ name: 'guest', scope: 'global' }] });
      const decision = engine.evaluate(context);

      expect(decision.allowed).toBe(false);
      expect(decision.decidedBy).toBe('default');
    });

    it('should return default allow when configured', () => {
      engine = new PolicyEngine({ defaultDecision: 'allow' });
      const context = createTestContext({ roles: [{ name: 'guest', scope: 'global' }] });
      const decision = engine.evaluate(context);

      expect(decision.allowed).toBe(true);
      expect(decision.decidedBy).toBe('default');
    });

    it('should include verbose details when configured', () => {
      engine = new PolicyEngine({ verbose: true });
      engine.addRule({
        id: 'test_rule',
        name: 'Test Rule',
        description: 'A test rule',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'has_role', params: { role: 'admin' } }],
      });

      const context = createTestContext({ roles: [{ name: 'admin', scope: 'global' }] });
      const decision = engine.evaluate(context);

      expect(decision.details).toBeDefined();
      expect(decision.details?.ruleName).toBe('Test Rule');
    });
  });

  describe('condition evaluators', () => {
    describe('has_role', () => {
      it('should match when subject has the role', () => {
        engine.addRule({
          id: 'has_role_test',
          name: 'Has Role Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'has_role', params: { role: 'admin' } }],
        });

        const context = createTestContext({ roles: [{ name: 'admin', scope: 'global' }] });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should not match when subject lacks the role', () => {
        engine.addRule({
          id: 'has_role_test',
          name: 'Has Role Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'has_role', params: { role: 'admin' } }],
        });

        const context = createTestContext({ roles: [{ name: 'user', scope: 'global' }] });
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });

    describe('has_any_role', () => {
      it('should match when subject has any of the roles', () => {
        engine.addRule({
          id: 'has_any_role_test',
          name: 'Has Any Role Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'has_any_role', params: { roles: ['admin', 'editor'] } }],
        });

        const context = createTestContext({ roles: [{ name: 'editor', scope: 'global' }] });
        expect(engine.evaluate(context).allowed).toBe(true);
      });
    });

    describe('has_all_roles', () => {
      it('should match when subject has all roles', () => {
        engine.addRule({
          id: 'has_all_roles_test',
          name: 'Has All Roles Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'has_all_roles', params: { roles: ['admin', 'auditor'] } }],
        });

        const context = createTestContext({
          roles: [
            { name: 'admin', scope: 'global' },
            { name: 'auditor', scope: 'global' },
          ],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should not match when subject is missing a role', () => {
        engine.addRule({
          id: 'has_all_roles_test',
          name: 'Has All Roles Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'has_all_roles', params: { roles: ['admin', 'auditor'] } }],
        });

        const context = createTestContext({ roles: [{ name: 'admin', scope: 'global' }] });
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });

    describe('is_resource_owner', () => {
      it('should match when subject owns the resource', () => {
        engine.addRule({
          id: 'owner_test',
          name: 'Owner Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'is_resource_owner', params: {} }],
        });

        const context = createTestContext({
          subjectId: 'user_123',
          resourceOwnerId: 'user_123',
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should not match when subject does not own the resource', () => {
        engine.addRule({
          id: 'owner_test',
          name: 'Owner Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'is_resource_owner', params: {} }],
        });

        const context = createTestContext({
          subjectId: 'user_123',
          resourceOwnerId: 'user_456',
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });

    describe('same_organization', () => {
      it('should match when subject and resource are in the same org', () => {
        engine.addRule({
          id: 'same_org_test',
          name: 'Same Org Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'same_organization', params: {} }],
        });

        const context = createTestContext({
          subjectOrgId: 'org_123',
          resourceOrgId: 'org_123',
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should not match when subject and resource are in different orgs', () => {
        engine.addRule({
          id: 'same_org_test',
          name: 'Same Org Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'same_organization', params: {} }],
        });

        const context = createTestContext({
          subjectOrgId: 'org_123',
          resourceOrgId: 'org_456',
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });

    describe('has_relationship', () => {
      it('should match when subject has the relationship with resource owner', () => {
        engine.addRule({
          id: 'relationship_test',
          name: 'Relationship Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'has_relationship', params: { types: ['parent_of'] } }],
        });

        const context = createTestContext({
          resourceOwnerId: 'child_123',
          relationships: [
            {
              relatedSubjectId: 'child_123',
              relationshipType: 'parent_of',
            },
          ],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should not match expired relationships', () => {
        engine.addRule({
          id: 'relationship_test',
          name: 'Relationship Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'has_relationship', params: { types: ['parent_of'] } }],
        });

        const context = createTestContext({
          resourceOwnerId: 'child_123',
          relationships: [
            {
              relatedSubjectId: 'child_123',
              relationshipType: 'parent_of',
              expiresAt: Date.now() - 1000, // Expired
            },
          ],
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });

    describe('user_type_is', () => {
      it('should match when user type matches', () => {
        engine.addRule({
          id: 'user_type_test',
          name: 'User Type Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'user_type_is', params: { types: ['enterprise_admin'] } }],
        });

        const context = createTestContext({ userType: 'enterprise_admin' });
        expect(engine.evaluate(context).allowed).toBe(true);
      });
    });

    describe('plan_allows', () => {
      it('should match when plan is in allowed list', () => {
        engine.addRule({
          id: 'plan_test',
          name: 'Plan Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'plan_allows', params: { plans: ['professional', 'enterprise'] } }],
        });

        const context = createTestContext({ plan: 'professional' });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should not match when plan is not in allowed list', () => {
        engine.addRule({
          id: 'plan_test',
          name: 'Plan Test',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'plan_allows', params: { plans: ['professional', 'enterprise'] } }],
        });

        const context = createTestContext({ plan: 'free' });
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });
  });

  describe('multiple conditions (AND logic)', () => {
    it('should require all conditions to match', () => {
      engine.addRule({
        id: 'multi_condition_test',
        name: 'Multi Condition Test',
        priority: 100,
        effect: 'allow',
        conditions: [
          { type: 'has_role', params: { role: 'org_admin' } },
          { type: 'same_organization', params: {} },
        ],
      });

      // Has role but not same org
      const context1 = createTestContext({
        roles: [{ name: 'org_admin', scope: 'global' }],
        subjectOrgId: 'org_123',
        resourceOrgId: 'org_456',
      });
      expect(engine.evaluate(context1).allowed).toBe(false);

      // Same org but no role
      const context2 = createTestContext({
        roles: [{ name: 'user', scope: 'global' }],
        subjectOrgId: 'org_123',
        resourceOrgId: 'org_123',
      });
      expect(engine.evaluate(context2).allowed).toBe(false);

      // Both conditions met
      const context3 = createTestContext({
        roles: [{ name: 'org_admin', scope: 'global' }],
        subjectOrgId: 'org_123',
        resourceOrgId: 'org_123',
      });
      expect(engine.evaluate(context3).allowed).toBe(true);
    });
  });
});

describe('createDefaultPolicyEngine', () => {
  it('should create an engine with default RBAC rules', () => {
    const engine = createDefaultPolicyEngine();

    // System admin should have access
    const adminContext = createTestContext({
      roles: [{ name: 'system_admin', scope: 'global' }],
    });
    expect(engine.evaluate(adminContext).allowed).toBe(true);

    // Resource owner should have access
    const ownerContext = createTestContext({
      subjectId: 'user_123',
      resourceOwnerId: 'user_123',
    });
    expect(engine.evaluate(ownerContext).allowed).toBe(true);

    // Regular user without matching rules should be denied
    const userContext = createTestContext({
      roles: [{ name: 'end_user', scope: 'global' }],
      subjectId: 'user_123',
      resourceOwnerId: 'user_456',
    });
    expect(engine.evaluate(userContext).allowed).toBe(false);
  });

  it('should allow guardian access', () => {
    const engine = createDefaultPolicyEngine();

    const guardianContext = createTestContext({
      roles: [{ name: 'end_user', scope: 'global' }],
      resourceOwnerId: 'child_123',
      relationships: [
        {
          relatedSubjectId: 'child_123',
          relationshipType: 'parent_of',
        },
      ],
    });
    expect(engine.evaluate(guardianContext).allowed).toBe(true);
  });
});

/**
 * Helper function to create test contexts
 */
function createTestContext(options: {
  subjectId?: string;
  roles?: Array<{ name: string; scope: 'global' | 'org' | 'resource'; scopeTarget?: string }>;
  userType?: string;
  plan?: string;
  subjectOrgId?: string;
  resourceOwnerId?: string;
  resourceOrgId?: string;
  relationships?: Array<{
    relatedSubjectId: string;
    relationshipType: string;
    expiresAt?: number;
  }>;
}): PolicyContext {
  return {
    subject: {
      id: options.subjectId || 'test_user',
      roles: options.roles || [],
      userType: options.userType as any,
      plan: options.plan as any,
      orgId: options.subjectOrgId,
      relationships: options.relationships as any,
    },
    resource: {
      type: 'test_resource',
      id: 'resource_1',
      ownerId: options.resourceOwnerId,
      orgId: options.resourceOrgId,
    },
    action: {
      name: 'read',
    },
    timestamp: Date.now(),
  };
}
