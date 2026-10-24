/**
 * Rich Authorization Requests (RAR) Validation Tests
 *
 * Tests for RFC 9396 authorization_details validation
 */

import { describe, it, expect } from 'vitest';
import { validateAuthorizationDetails } from '../utils/rar-validation';

const securityRegressionIt =
  process.env.AUTHRIM_SECURITY_REGRESSION_SUITE === 'true' ? it : it.skip;

/** The types /authorize and PAR accept. */
const ENDPOINT_ALLOWED_TYPES = ['ai_agent_action', 'payment_initiation', 'account_information'];

describe('RAR Validation', () => {
  describe('Basic Validation', () => {
    it('should validate a valid authorization_details array', () => {
      const input = [{ type: 'custom_type' }];
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['custom_type'],
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.sanitized).toEqual(input);
    });

    it('should accept JSON string input', () => {
      const input = JSON.stringify([{ type: 'custom_type' }]);
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['custom_type'],
      });

      expect(result.valid).toBe(true);
    });

    it('should reject non-array input', () => {
      const result = validateAuthorizationDetails({ type: 'payment_initiation' });

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('not_array');
    });

    it('should reject empty array', () => {
      const result = validateAuthorizationDetails([]);

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('empty_array');
    });

    it('should reject invalid JSON string', () => {
      const result = validateAuthorizationDetails('not valid json');

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('invalid_json');
    });

    it('should reject entries without type field', () => {
      const result = validateAuthorizationDetails([{ foo: 'bar' }]);

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('missing_type');
    });
  });

  describe('Size Limits', () => {
    it('should reject oversized input', () => {
      const input = JSON.stringify([{ type: 'a'.repeat(20000) }]);
      const result = validateAuthorizationDetails(input);

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('size_exceeded');
    });

    it('should respect custom maxSize option', () => {
      const input = JSON.stringify([{ type: 'test' }]);
      const result = validateAuthorizationDetails(input, { maxSize: 10 });

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('size_exceeded');
    });

    it('should reject too many entries', () => {
      const input = Array(20)
        .fill(null)
        .map((_, i) => ({ type: `type_${i}` }));
      const result = validateAuthorizationDetails(input);

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('size_exceeded');
    });
  });

  describe('Type Filtering', () => {
    it('should allow all types when allowedTypes is empty', () => {
      const input = [{ type: 'custom_type' }];
      const result = validateAuthorizationDetails(input);

      expect(result.valid).toBe(true);
    });

    it('should allow only specified types', () => {
      const input = [{ type: 'my_custom_type' }];
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['my_custom_type'],
      });

      expect(result.valid).toBe(true);
    });

    it('should reject types not in allowedTypes', () => {
      const input = [{ type: 'custom_type' }];
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['payment_initiation'],
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('type_not_allowed');
    });

    it('should reject types in deniedTypes', () => {
      const input = [{ type: 'forbidden_type' }];
      const result = validateAuthorizationDetails(input, {
        deniedTypes: ['forbidden_type'],
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('type_not_allowed');
    });
  });

  describe('AI Agent Action Validation', () => {
    it('should validate valid ai_agent_action', () => {
      const input = [
        {
          type: 'ai_agent_action',
          agent_id: 'agent-123',
          capabilities: ['read', 'write'],
        },
      ];
      const result = validateAuthorizationDetails(input);

      expect(result.valid).toBe(true);
    });

    it('should reject ai_agent_action without agent_id', () => {
      const input = [
        {
          type: 'ai_agent_action',
          capabilities: ['read'],
        },
      ];
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['ai_agent_action'],
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('missing_required_field');
    });

    it('should reject ai_agent_action without capabilities', () => {
      const input = [
        {
          type: 'ai_agent_action',
          agent_id: 'agent-123',
        },
      ];
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['ai_agent_action'],
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('missing_required_field');
    });

    it('should accept ai_agent_action with session_context', () => {
      const input = [
        {
          type: 'ai_agent_action',
          agent_id: 'agent-123',
          capabilities: ['read'],
          session_context: {
            parent_session_id: 'session-456',
            conversation_id: 'conv-789',
          },
        },
      ];
      const result = validateAuthorizationDetails(input);

      expect(result.valid).toBe(true);
    });
  });

  describe('Payment Initiation Validation', () => {
    it('should validate valid payment_initiation with all required fields', () => {
      const input = [
        {
          type: 'payment_initiation',
          instructedAmount: { amount: '100.00', currency: 'USD' },
          creditorAccount: { iban: 'DE89370400440532013000' },
        },
      ];
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['payment_initiation'],
      });

      expect(result.valid).toBe(true);
    });

    it('should reject payment_initiation without instructedAmount', () => {
      const input = [
        {
          type: 'payment_initiation',
          creditorAccount: { iban: 'DE89370400440532013000' },
        },
      ];
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['payment_initiation'],
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'instructedAmount')).toBe(true);
    });
  });

  describe('Account Information Validation', () => {
    it('should validate valid account_information with actions', () => {
      const input = [
        {
          type: 'account_information',
          actions: ['read', 'write'],
        },
      ];
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['account_information'],
      });

      expect(result.valid).toBe(true);
    });

    it('should reject account_information without actions', () => {
      const input = [{ type: 'account_information' }];
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['account_information'],
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('actions');
    });

    it('should reject account_information with invalid action values', () => {
      const input = [
        {
          type: 'account_information',
          actions: ['invalid_action'],
        },
      ];
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['account_information'],
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('actions');
    });
  });

  describe('Multiple Entries', () => {
    it('should validate multiple valid entries with correct types', () => {
      const input = [{ type: 'generic_type_1' }, { type: 'generic_type_2' }];
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['generic_type_1', 'generic_type_2'],
      });

      expect(result.valid).toBe(true);
      expect(result.sanitized).toHaveLength(2);
    });

    it('should validate ai_agent_action with payment_initiation', () => {
      const input = [
        {
          type: 'ai_agent_action',
          agent_id: 'agent-123',
          capabilities: ['read'],
        },
        {
          type: 'payment_initiation',
          instructedAmount: { amount: '100.00', currency: 'USD' },
          creditorAccount: { iban: 'DE89370400440532013000' },
        },
      ];
      const result = validateAuthorizationDetails(input, {
        allowedTypes: ['ai_agent_action', 'payment_initiation'],
      });

      expect(result.valid).toBe(true);
      expect(result.sanitized).toHaveLength(2);
    });

    it('should collect errors from multiple invalid entries', () => {
      const input = [{ type: 123 }, { noType: true }];
      const result = validateAuthorizationDetails(input);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Sanitize option', () => {
    securityRegressionIt(
      'rejects an invalid known-type entry whether or not sanitize is on',
      () => {
        const input = [{ type: 'payment_initiation', creditorAccount: { iban: 'DE89' } }];

        for (const sanitize of [true, false]) {
          const result = validateAuthorizationDetails(input, { sanitize });
          expect(result.valid).toBe(false);
          expect(result.sanitized).toBeUndefined();
          expect(result.errors[0].field).toBe('instructedAmount');
        }
      }
    );

    securityRegressionIt(
      'strips fields a known type does not define only when sanitize is on',
      () => {
        const input = [{ type: 'account_information', actions: ['read'], injected: 'x' }];

        expect(validateAuthorizationDetails(input, { sanitize: true }).sanitized).toEqual([
          { type: 'account_information', actions: ['read'] },
        ]);
        expect(validateAuthorizationDetails(input, { sanitize: false }).sanitized).toEqual(input);
      }
    );

    securityRegressionIt(
      'passes an unknown type through even with sanitize on, so allowedTypes is what keeps it out',
      () => {
        const input = [{ type: 'custom_type', injected: 'x' }];

        const passed = validateAuthorizationDetails(input, { sanitize: true });
        expect(passed.valid).toBe(true);
        expect(passed.sanitized).toEqual(input);

        const restricted = validateAuthorizationDetails(input, {
          sanitize: true,
          allowedTypes: ENDPOINT_ALLOWED_TYPES,
        });
        expect(restricted.valid).toBe(false);
        expect(restricted.sanitized).toBeUndefined();
        expect(restricted.errors[0].code).toBe('type_not_allowed');
      }
    );
  });
});
