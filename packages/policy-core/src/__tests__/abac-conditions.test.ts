/**
 * ABAC Condition Evaluation Tests
 *
 * Tests for Attribute-Based Access Control conditions:
 * - attribute_equals: Match attribute name and value
 * - attribute_exists: Check if attribute exists (any value)
 * - attribute_in: Check if attribute value is in allowed list
 *
 * Key validations:
 * - Expiration checking (UNIX seconds)
 * - Missing attributes handling
 * - Null value handling
 * - Source and issuer verification (for documentation)
 *
 * @see Zanzibar: Google's Consistent, Global Authorization System
 * @see RFC 9396: OAuth 2.0 Rich Authorization Requests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PolicyEngine } from '../engine';
import type { PolicyContext, VerifiedAttribute, PolicySubjectWithAttributes } from '../types';

describe('ABAC Condition Evaluation', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
    vi.useFakeTimers();
    // Set current time to a known value (2025-01-01 00:00:00 UTC)
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Helper to create context with verified attributes
   * Uses type assertion since PolicyContext.subject is PolicySubject,
   * but engine.evaluate() handles PolicySubjectWithAttributes at runtime
   */
  function createContextWithAttributes(
    attributes: VerifiedAttribute[],
    options?: {
      subjectId?: string;
      resourceType?: string;
      action?: string;
    }
  ): PolicyContext {
    const subject: PolicySubjectWithAttributes = {
      id: options?.subjectId ?? 'test_user',
      roles: [],
      verifiedAttributes: attributes,
    };
    return {
      subject: subject as PolicyContext['subject'],
      resource: {
        type: options?.resourceType ?? 'document',
        id: 'doc_123',
      },
      action: {
        name: options?.action ?? 'read',
      },
      timestamp: Date.now(),
    };
  }

  describe('attribute_equals', () => {
    beforeEach(() => {
      engine.addRule({
        id: 'premium_access',
        name: 'Premium Subscription Access',
        priority: 100,
        effect: 'allow',
        conditions: [
          {
            type: 'attribute_equals',
            params: { name: 'subscription_tier', value: 'premium' },
          },
        ],
      });
    });

    it('should allow when attribute matches exactly', () => {
      const context = createContextWithAttributes([
        {
          name: 'subscription_tier',
          value: 'premium',
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
      expect(decision.decidedBy).toBe('premium_access');
    });

    it('should deny when attribute value does not match', () => {
      const context = createContextWithAttributes([
        {
          name: 'subscription_tier',
          value: 'basic',
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when attribute name does not match', () => {
      const context = createContextWithAttributes([
        {
          name: 'plan_type',
          value: 'premium',
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when no attributes present', () => {
      const context = createContextWithAttributes([]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when verifiedAttributes is undefined', () => {
      const context: PolicyContext = {
        subject: {
          id: 'test_user',
          roles: [],
          // No verifiedAttributes
        },
        resource: { type: 'document', id: 'doc_123' },
        action: { name: 'read' },
        timestamp: Date.now(),
      };

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when attribute has expired', () => {
      const now = Math.floor(Date.now() / 1000);
      const context = createContextWithAttributes([
        {
          name: 'subscription_tier',
          value: 'premium',
          source: 'vc',
          issuer: 'did:web:issuer.example.com',
          expiresAt: now - 3600, // Expired 1 hour ago
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should allow when attribute has not yet expired', () => {
      const now = Math.floor(Date.now() / 1000);
      const context = createContextWithAttributes([
        {
          name: 'subscription_tier',
          value: 'premium',
          source: 'vc',
          expiresAt: now + 3600, // Valid for 1 more hour
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should allow when attribute has no expiration', () => {
      const context = createContextWithAttributes([
        {
          name: 'subscription_tier',
          value: 'premium',
          source: 'manual',
          // No expiresAt
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should allow expired attribute when checkExpiry is false', () => {
      engine.clearRules();
      engine.addRule({
        id: 'premium_no_expiry_check',
        name: 'Premium Access (No Expiry Check)',
        priority: 100,
        effect: 'allow',
        conditions: [
          {
            type: 'attribute_equals',
            params: {
              name: 'subscription_tier',
              value: 'premium',
              checkExpiry: false,
            },
          },
        ],
      });

      const now = Math.floor(Date.now() / 1000);
      const context = createContextWithAttributes([
        {
          name: 'subscription_tier',
          value: 'premium',
          source: 'vc',
          expiresAt: now - 3600, // Expired
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should match first matching attribute from multiple', () => {
      const context = createContextWithAttributes([
        {
          name: 'department',
          value: 'engineering',
          source: 'manual',
        },
        {
          name: 'subscription_tier',
          value: 'premium',
          source: 'vc',
        },
        {
          name: 'region',
          value: 'us-west',
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should handle attribute with null value', () => {
      const context = createContextWithAttributes([
        {
          name: 'subscription_tier',
          value: null,
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should be case-sensitive for value matching', () => {
      const context = createContextWithAttributes([
        {
          name: 'subscription_tier',
          value: 'Premium', // Different case
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });
  });

  describe('attribute_exists', () => {
    beforeEach(() => {
      engine.addRule({
        id: 'medical_license_required',
        name: 'Requires Medical License',
        priority: 100,
        effect: 'allow',
        conditions: [
          {
            type: 'attribute_exists',
            params: { name: 'medical_license' },
          },
        ],
      });
    });

    it('should allow when attribute exists with any value', () => {
      const context = createContextWithAttributes([
        {
          name: 'medical_license',
          value: 'MD-12345',
          source: 'vc',
          issuer: 'did:web:medical-board.gov',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should allow when attribute exists with null value', () => {
      // attribute_exists only checks name, not value
      const context = createContextWithAttributes([
        {
          name: 'medical_license',
          value: null,
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should deny when attribute does not exist', () => {
      const context = createContextWithAttributes([
        {
          name: 'drivers_license',
          value: 'DL-67890',
          source: 'vc',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when no attributes present', () => {
      const context = createContextWithAttributes([]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when attribute has expired', () => {
      const now = Math.floor(Date.now() / 1000);
      const context = createContextWithAttributes([
        {
          name: 'medical_license',
          value: 'MD-12345',
          source: 'vc',
          expiresAt: now - 86400, // Expired 1 day ago
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should allow when attribute exists and not expired', () => {
      const now = Math.floor(Date.now() / 1000);
      const context = createContextWithAttributes([
        {
          name: 'medical_license',
          value: 'MD-12345',
          source: 'vc',
          expiresAt: now + 86400 * 365, // Valid for 1 year
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should allow expired attribute when checkExpiry is false', () => {
      engine.clearRules();
      engine.addRule({
        id: 'license_no_expiry',
        name: 'License Check (No Expiry)',
        priority: 100,
        effect: 'allow',
        conditions: [
          {
            type: 'attribute_exists',
            params: { name: 'medical_license', checkExpiry: false },
          },
        ],
      });

      const now = Math.floor(Date.now() / 1000);
      const context = createContextWithAttributes([
        {
          name: 'medical_license',
          value: 'MD-EXPIRED',
          source: 'vc',
          expiresAt: now - 86400,
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('attribute_in', () => {
    beforeEach(() => {
      engine.addRule({
        id: 'senior_access',
        name: 'Senior Level Access',
        priority: 100,
        effect: 'allow',
        conditions: [
          {
            type: 'attribute_in',
            params: {
              name: 'role_level',
              values: ['senior', 'lead', 'manager', 'director'],
            },
          },
        ],
      });
    });

    it('should allow when attribute value is in the list', () => {
      const context = createContextWithAttributes([
        {
          name: 'role_level',
          value: 'senior',
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should allow when attribute value matches any in list', () => {
      const context = createContextWithAttributes([
        {
          name: 'role_level',
          value: 'director',
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should deny when attribute value is not in the list', () => {
      const context = createContextWithAttributes([
        {
          name: 'role_level',
          value: 'junior',
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when attribute value is null', () => {
      const context = createContextWithAttributes([
        {
          name: 'role_level',
          value: null,
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when attribute does not exist', () => {
      const context = createContextWithAttributes([
        {
          name: 'department',
          value: 'senior',
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when no attributes present', () => {
      const context = createContextWithAttributes([]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when attribute has expired', () => {
      const now = Math.floor(Date.now() / 1000);
      const context = createContextWithAttributes([
        {
          name: 'role_level',
          value: 'manager',
          source: 'vc',
          expiresAt: now - 3600,
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should allow when attribute not expired and in list', () => {
      const now = Math.floor(Date.now() / 1000);
      const context = createContextWithAttributes([
        {
          name: 'role_level',
          value: 'lead',
          source: 'vc',
          expiresAt: now + 3600,
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should allow expired attribute when checkExpiry is false', () => {
      engine.clearRules();
      engine.addRule({
        id: 'senior_no_expiry',
        name: 'Senior Access (No Expiry)',
        priority: 100,
        effect: 'allow',
        conditions: [
          {
            type: 'attribute_in',
            params: {
              name: 'role_level',
              values: ['senior', 'lead'],
              checkExpiry: false,
            },
          },
        ],
      });

      const now = Math.floor(Date.now() / 1000);
      const context = createContextWithAttributes([
        {
          name: 'role_level',
          value: 'senior',
          source: 'vc',
          expiresAt: now - 86400,
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should be case-sensitive for value matching in list', () => {
      const context = createContextWithAttributes([
        {
          name: 'role_level',
          value: 'Senior', // Different case
          source: 'manual',
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });
  });

  describe('Combined ABAC + RBAC Conditions', () => {
    beforeEach(() => {
      engine.addRule({
        id: 'admin_or_premium',
        name: 'Admin OR Premium Access',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'has_role', params: { role: 'admin' } }],
      });

      engine.addRule({
        id: 'premium_user',
        name: 'Premium User Access',
        priority: 50,
        effect: 'allow',
        conditions: [
          {
            type: 'attribute_equals',
            params: { name: 'subscription', value: 'premium' },
          },
        ],
      });
    });

    it('should allow admin regardless of subscription', () => {
      const subject: PolicySubjectWithAttributes = {
        id: 'admin_user',
        roles: [{ name: 'admin', scope: 'global' }],
        verifiedAttributes: [{ name: 'subscription', value: 'basic', source: 'manual' }],
      };
      const context: PolicyContext = {
        subject: subject as PolicyContext['subject'],
        resource: { type: 'document', id: 'doc_123' },
        action: { name: 'read' },
        timestamp: Date.now(),
      };

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
      expect(decision.decidedBy).toBe('admin_or_premium');
    });

    it('should allow premium user without admin role', () => {
      const subject: PolicySubjectWithAttributes = {
        id: 'premium_user',
        roles: [{ name: 'user', scope: 'global' }],
        verifiedAttributes: [{ name: 'subscription', value: 'premium', source: 'vc' }],
      };
      const context: PolicyContext = {
        subject: subject as PolicyContext['subject'],
        resource: { type: 'document', id: 'doc_123' },
        action: { name: 'read' },
        timestamp: Date.now(),
      };

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
      expect(decision.decidedBy).toBe('premium_user');
    });

    it('should deny basic user without admin role', () => {
      const subject: PolicySubjectWithAttributes = {
        id: 'basic_user',
        roles: [{ name: 'user', scope: 'global' }],
        verifiedAttributes: [{ name: 'subscription', value: 'basic', source: 'manual' }],
      };
      const context: PolicyContext = {
        subject: subject as PolicyContext['subject'],
        resource: { type: 'document', id: 'doc_123' },
        action: { name: 'read' },
        timestamp: Date.now(),
      };

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });
  });

  describe('Multiple ABAC Conditions (AND logic)', () => {
    beforeEach(() => {
      engine.addRule({
        id: 'verified_senior_engineer',
        name: 'Verified Senior Engineer Access',
        priority: 100,
        effect: 'allow',
        conditions: [
          {
            type: 'attribute_equals',
            params: { name: 'department', value: 'engineering' },
          },
          {
            type: 'attribute_in',
            params: { name: 'level', values: ['senior', 'staff', 'principal'] },
          },
          {
            type: 'attribute_exists',
            params: { name: 'security_clearance' },
          },
        ],
      });
    });

    it('should allow when all conditions are met', () => {
      const context = createContextWithAttributes([
        { name: 'department', value: 'engineering', source: 'manual' },
        { name: 'level', value: 'staff', source: 'vc' },
        { name: 'security_clearance', value: 'secret', source: 'vc' },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should deny when one condition fails (wrong department)', () => {
      const context = createContextWithAttributes([
        { name: 'department', value: 'marketing', source: 'manual' },
        { name: 'level', value: 'staff', source: 'vc' },
        { name: 'security_clearance', value: 'secret', source: 'vc' },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when one condition fails (wrong level)', () => {
      const context = createContextWithAttributes([
        { name: 'department', value: 'engineering', source: 'manual' },
        { name: 'level', value: 'junior', source: 'vc' },
        { name: 'security_clearance', value: 'secret', source: 'vc' },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when one condition fails (missing security clearance)', () => {
      const context = createContextWithAttributes([
        { name: 'department', value: 'engineering', source: 'manual' },
        { name: 'level', value: 'senior', source: 'vc' },
        // No security_clearance
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });

    it('should deny when one attribute is expired', () => {
      const now = Math.floor(Date.now() / 1000);
      const context = createContextWithAttributes([
        { name: 'department', value: 'engineering', source: 'manual' },
        { name: 'level', value: 'senior', source: 'vc' },
        {
          name: 'security_clearance',
          value: 'secret',
          source: 'vc',
          expiresAt: now - 3600, // Expired
        },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false);
    });
  });

  describe('Attribute Sources and Issuers', () => {
    it('should accept attributes from different sources', () => {
      engine.addRule({
        id: 'any_source',
        name: 'Accept Any Source',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'attribute_equals', params: { name: 'verified', value: 'true' } }],
      });

      // Manual source
      let context = createContextWithAttributes([
        { name: 'verified', value: 'true', source: 'manual' },
      ]);
      expect(engine.evaluate(context).allowed).toBe(true);

      // VC source
      context = createContextWithAttributes([
        {
          name: 'verified',
          value: 'true',
          source: 'vc',
          issuer: 'did:web:issuer.example.com',
        },
      ]);
      expect(engine.evaluate(context).allowed).toBe(true);

      // JWT-SD source
      context = createContextWithAttributes([
        { name: 'verified', value: 'true', source: 'jwt_sd' },
      ]);
      expect(engine.evaluate(context).allowed).toBe(true);
    });

    it('should document issuer information in attributes', () => {
      // This test documents that issuer is available for auditing
      // but not currently used in condition evaluation
      const context = createContextWithAttributes([
        {
          name: 'age_over_18',
          value: 'true',
          source: 'vc',
          issuer: 'did:web:government.example.com',
        },
      ]);

      // Verify attribute is accessible with issuer
      const attrs = (context.subject as PolicySubjectWithAttributes).verifiedAttributes;
      expect(attrs?.[0].issuer).toBe('did:web:government.example.com');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string attribute value', () => {
      engine.addRule({
        id: 'empty_value',
        name: 'Empty Value Check',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'attribute_equals', params: { name: 'tag', value: '' } }],
      });

      const context = createContextWithAttributes([{ name: 'tag', value: '', source: 'manual' }]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should handle attribute_in with single value array', () => {
      engine.clearRules();
      engine.addRule({
        id: 'single_value',
        name: 'Single Value Check',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'attribute_in', params: { name: 'role', values: ['admin'] } }],
      });

      const context = createContextWithAttributes([
        { name: 'role', value: 'admin', source: 'manual' },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true);
    });

    it('should handle attribute_in with empty values array', () => {
      engine.clearRules();
      engine.addRule({
        id: 'empty_values',
        name: 'Empty Values Check',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'attribute_in', params: { name: 'role', values: [] } }],
      });

      const context = createContextWithAttributes([
        { name: 'role', value: 'admin', source: 'manual' },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false); // No values to match
    });

    it('should handle duplicate attributes (first match wins)', () => {
      engine.clearRules();
      engine.addRule({
        id: 'first_attr',
        name: 'First Attribute',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'attribute_equals', params: { name: 'status', value: 'active' } }],
      });

      const context = createContextWithAttributes([
        { name: 'status', value: 'active', source: 'manual' },
        { name: 'status', value: 'inactive', source: 'vc' },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(true); // First 'status' matches
    });

    it('should handle expiration at exact boundary', () => {
      engine.clearRules();
      engine.addRule({
        id: 'boundary_check',
        name: 'Boundary Check',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'attribute_exists', params: { name: 'license' } }],
      });

      const now = Math.floor(Date.now() / 1000);

      // Exactly at expiration time (should be expired: expiresAt <= now)
      const context = createContextWithAttributes([
        { name: 'license', value: 'valid', source: 'vc', expiresAt: now },
      ]);

      const decision = engine.evaluate(context);
      expect(decision.allowed).toBe(false); // Expired at exact boundary
    });
  });
});
