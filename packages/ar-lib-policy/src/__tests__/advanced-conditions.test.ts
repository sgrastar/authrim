/**
 * Advanced Condition Evaluators Unit Tests
 *
 * Tests for Phase 4+ condition types:
 * - Time-based conditions (time_in_range, day_of_week, valid_during)
 * - Numeric comparisons (numeric_gt, numeric_gte, numeric_lt, numeric_lte, numeric_eq, numeric_between)
 * - Geographic conditions (country_in, country_not_in, ip_in_range)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PolicyEngine } from '../engine';
import type { PolicyContext, PolicyRule, PolicySubjectWithAttributes } from '../types';

describe('Advanced Condition Evaluators', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  // ===========================================================================
  // Time-based Conditions
  // ===========================================================================

  describe('Time-based conditions', () => {
    describe('time_in_range', () => {
      it('should allow access during business hours', () => {
        // Mock current time to 14:00 UTC
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:00:00Z'));

        engine.addRule({
          id: 'business_hours',
          name: 'Business Hours Only',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'time_in_range', params: { startHour: 9, endHour: 18, timezone: 'UTC' } },
          ],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(true);

        vi.useRealTimers();
      });

      it('should deny access outside business hours', () => {
        // Mock current time to 22:00 UTC
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T22:00:00Z'));

        engine.addRule({
          id: 'business_hours',
          name: 'Business Hours Only',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'time_in_range', params: { startHour: 9, endHour: 18, timezone: 'UTC' } },
          ],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(false);

        vi.useRealTimers();
      });

      it('should handle overnight ranges (e.g., 22:00-06:00)', () => {
        // Mock current time to 02:00 UTC
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

        engine.addRule({
          id: 'night_shift',
          name: 'Night Shift Hours',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'time_in_range', params: { startHour: 22, endHour: 6, timezone: 'UTC' } },
          ],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(true);

        vi.useRealTimers();
      });

      it('should handle timezone-aware time checks', () => {
        // Mock current time to 14:00 UTC
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:00:00Z'));

        engine.addRule({
          id: 'tokyo_business_hours',
          name: 'Tokyo Business Hours',
          priority: 100,
          effect: 'allow',
          conditions: [
            {
              type: 'time_in_range',
              params: { startHour: 9, endHour: 18, timezone: 'Asia/Tokyo' },
            },
          ],
        });

        const context = createTestContext({});
        // 14:00 UTC = 23:00 Tokyo, outside business hours
        expect(engine.evaluate(context).allowed).toBe(false);

        vi.useRealTimers();
      });
    });

    describe('day_of_week', () => {
      it('should allow access on weekdays', () => {
        // Monday = 1
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T10:00:00')); // Monday

        engine.addRule({
          id: 'weekdays_only',
          name: 'Weekdays Only',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'day_of_week', params: { allowedDays: [1, 2, 3, 4, 5] } }],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(true);

        vi.useRealTimers();
      });

      it('should deny access on weekends', () => {
        // Sunday = 0
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-14T10:00:00')); // Sunday

        engine.addRule({
          id: 'weekdays_only',
          name: 'Weekdays Only',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'day_of_week', params: { allowedDays: [1, 2, 3, 4, 5] } }],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(false);

        vi.useRealTimers();
      });
    });

    describe('valid_during', () => {
      it('should allow access within valid period', () => {
        vi.useFakeTimers();
        const now = Math.floor(Date.now() / 1000);
        vi.setSystemTime(new Date(now * 1000));

        engine.addRule({
          id: 'valid_period',
          name: 'Valid During Period',
          priority: 100,
          effect: 'allow',
          conditions: [
            {
              type: 'valid_during',
              params: { from: now - 3600, to: now + 3600 },
            },
          ],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(true);

        vi.useRealTimers();
      });

      it('should deny access before valid period', () => {
        vi.useFakeTimers();
        const now = Math.floor(Date.now() / 1000);
        vi.setSystemTime(new Date(now * 1000));

        engine.addRule({
          id: 'future_access',
          name: 'Future Access',
          priority: 100,
          effect: 'allow',
          conditions: [
            {
              type: 'valid_during',
              params: { from: now + 3600 },
            },
          ],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(false);

        vi.useRealTimers();
      });

      it('should deny access after valid period', () => {
        vi.useFakeTimers();
        const now = Math.floor(Date.now() / 1000);
        vi.setSystemTime(new Date(now * 1000));

        engine.addRule({
          id: 'expired_access',
          name: 'Expired Access',
          priority: 100,
          effect: 'allow',
          conditions: [
            {
              type: 'valid_during',
              params: { to: now - 3600 },
            },
          ],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(false);

        vi.useRealTimers();
      });
    });
  });

  // ===========================================================================
  // Numeric Comparisons
  // ===========================================================================

  describe('Numeric comparisons', () => {
    describe('numeric_gt', () => {
      it('should match when attribute is greater than value', () => {
        engine.addRule({
          id: 'high_score',
          name: 'High Score Access',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_gt', params: { name: 'score', value: 80 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'score', value: '95', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should not match when attribute equals value', () => {
        engine.addRule({
          id: 'high_score',
          name: 'High Score Access',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_gt', params: { name: 'score', value: 80 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'score', value: '80', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });

    describe('numeric_gte', () => {
      it('should match when attribute equals value', () => {
        engine.addRule({
          id: 'min_age',
          name: 'Minimum Age',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_gte', params: { name: 'age', value: 18 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'age', value: '18', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });
    });

    describe('numeric_lt', () => {
      it('should match when attribute is less than value', () => {
        engine.addRule({
          id: 'low_risk',
          name: 'Low Risk',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_lt', params: { name: 'risk_score', value: 50 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'risk_score', value: '25', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });
    });

    describe('numeric_lte', () => {
      it('should match when attribute equals value', () => {
        engine.addRule({
          id: 'max_attempts',
          name: 'Max Attempts',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_lte', params: { name: 'attempts', value: 3 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'attempts', value: '3', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });
    });

    describe('numeric_eq', () => {
      it('should match when attribute equals value', () => {
        engine.addRule({
          id: 'exact_tier',
          name: 'Exact Tier',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_eq', params: { name: 'tier', value: 2 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'tier', value: '2', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should not match when attribute differs from value', () => {
        engine.addRule({
          id: 'exact_tier',
          name: 'Exact Tier',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_eq', params: { name: 'tier', value: 2 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'tier', value: '3', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });

    describe('numeric_between', () => {
      it('should match when attribute is within range', () => {
        engine.addRule({
          id: 'valid_range',
          name: 'Valid Range',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_between', params: { name: 'credits', min: 10, max: 100 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'credits', value: '50', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should match when attribute equals min boundary', () => {
        engine.addRule({
          id: 'valid_range',
          name: 'Valid Range',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_between', params: { name: 'credits', min: 10, max: 100 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'credits', value: '10', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should match when attribute equals max boundary', () => {
        engine.addRule({
          id: 'valid_range',
          name: 'Valid Range',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_between', params: { name: 'credits', min: 10, max: 100 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'credits', value: '100', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should not match when attribute is outside range', () => {
        engine.addRule({
          id: 'valid_range',
          name: 'Valid Range',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_between', params: { name: 'credits', min: 10, max: 100 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'credits', value: '5', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });

    describe('missing attribute handling', () => {
      it('should return false when attribute is missing', () => {
        engine.addRule({
          id: 'score_check',
          name: 'Score Check',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_gt', params: { name: 'score', value: 50 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [], // No attributes
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });

      it('should return false when attribute value is non-numeric', () => {
        engine.addRule({
          id: 'score_check',
          name: 'Score Check',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_gt', params: { name: 'score', value: 50 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'score', value: 'not-a-number', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });
  });

  // ===========================================================================
  // Geographic Conditions
  // ===========================================================================

  describe('Geographic conditions', () => {
    describe('country_in', () => {
      it('should allow access from allowed countries', () => {
        engine.addRule({
          id: 'allowed_countries',
          name: 'Allowed Countries',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'country_in', params: { countries: ['US', 'CA', 'JP'] } }],
        });

        const context = createTestContextWithEnvironment({
          countryCode: 'JP',
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should deny access from disallowed countries', () => {
        engine.addRule({
          id: 'allowed_countries',
          name: 'Allowed Countries',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'country_in', params: { countries: ['US', 'CA', 'JP'] } }],
        });

        const context = createTestContextWithEnvironment({
          countryCode: 'RU',
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });

      it('should handle case-insensitive country codes', () => {
        engine.addRule({
          id: 'allowed_countries',
          name: 'Allowed Countries',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'country_in', params: { countries: ['US', 'CA', 'JP'] } }],
        });

        const context = createTestContextWithEnvironment({
          countryCode: 'jp', // lowercase
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });
    });

    describe('country_not_in', () => {
      it('should deny access from blocked countries', () => {
        engine.addRule({
          id: 'blocked_countries',
          name: 'Blocked Countries',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'country_not_in', params: { countries: ['RU', 'CN', 'KP'] } }],
        });

        const context = createTestContextWithEnvironment({
          countryCode: 'RU',
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });

      it('should allow access from non-blocked countries', () => {
        engine.addRule({
          id: 'blocked_countries',
          name: 'Blocked Countries',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'country_not_in', params: { countries: ['RU', 'CN', 'KP'] } }],
        });

        const context = createTestContextWithEnvironment({
          countryCode: 'US',
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });
    });

    describe('ip_in_range', () => {
      it('should allow access from IP within CIDR range', () => {
        engine.addRule({
          id: 'office_ip',
          name: 'Office IP Range',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'ip_in_range', params: { ranges: ['192.168.1.0/24'] } }],
        });

        const context = createTestContextWithEnvironment({
          clientIp: '192.168.1.100',
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should deny access from IP outside CIDR range', () => {
        engine.addRule({
          id: 'office_ip',
          name: 'Office IP Range',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'ip_in_range', params: { ranges: ['192.168.1.0/24'] } }],
        });

        const context = createTestContextWithEnvironment({
          clientIp: '192.168.2.100',
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });

      it('should support multiple CIDR ranges', () => {
        engine.addRule({
          id: 'allowed_networks',
          name: 'Allowed Networks',
          priority: 100,
          effect: 'allow',
          conditions: [
            {
              type: 'ip_in_range',
              params: { ranges: ['192.168.1.0/24', '10.0.0.0/8', '172.16.0.0/12'] },
            },
          ],
        });

        const context = createTestContextWithEnvironment({
          clientIp: '10.20.30.40',
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should handle /32 (single IP) CIDR', () => {
        engine.addRule({
          id: 'specific_ip',
          name: 'Specific IP',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'ip_in_range', params: { ranges: ['203.0.113.42/32'] } }],
        });

        const context = createTestContextWithEnvironment({
          clientIp: '203.0.113.42',
        });
        expect(engine.evaluate(context).allowed).toBe(true);

        const context2 = createTestContextWithEnvironment({
          clientIp: '203.0.113.43',
        });
        expect(engine.evaluate(context2).allowed).toBe(false);
      });
    });

    describe('missing environment handling', () => {
      it('should return false when countryCode is missing', () => {
        engine.addRule({
          id: 'country_check',
          name: 'Country Check',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'country_in', params: { countries: ['US'] } }],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(false);
      });

      it('should return false when clientIp is missing', () => {
        engine.addRule({
          id: 'ip_check',
          name: 'IP Check',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'ip_in_range', params: { ranges: ['192.168.1.0/24'] } }],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });
  });

  // ===========================================================================
  // Combined Conditions
  // ===========================================================================

  describe('Combined conditions', () => {
    it('should combine time and geo conditions', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T10:00:00Z')); // Monday 10 AM UTC

      engine.addRule({
        id: 'office_access',
        name: 'Office Access',
        priority: 100,
        effect: 'allow',
        conditions: [
          { type: 'time_in_range', params: { startHour: 9, endHour: 18, timezone: 'UTC' } },
          { type: 'day_of_week', params: { allowedDays: [1, 2, 3, 4, 5], timezone: 'UTC' } },
          { type: 'country_in', params: { countries: ['JP'] } },
        ],
      });

      const context = createTestContextWithEnvironment({
        countryCode: 'JP',
      });
      expect(engine.evaluate(context).allowed).toBe(true);

      const contextWrongCountry = createTestContextWithEnvironment({
        countryCode: 'US',
      });
      expect(engine.evaluate(contextWrongCountry).allowed).toBe(false);

      vi.useRealTimers();
    });

    it('should combine numeric and role conditions', () => {
      engine.addRule({
        id: 'premium_feature',
        name: 'Premium Feature Access',
        priority: 100,
        effect: 'allow',
        conditions: [
          { type: 'has_role', params: { role: 'subscriber' } },
          { type: 'numeric_gte', params: { name: 'subscription_tier', value: 2 } },
        ],
      });

      const context: PolicyContext = {
        subject: {
          id: 'user_123',
          roles: [{ name: 'subscriber', scope: 'global' }],
          verifiedAttributes: [{ name: 'subscription_tier', value: '3', source: 'db' }],
        } as PolicySubjectWithAttributes,
        resource: { type: 'feature', id: 'premium_dashboard' },
        action: { name: 'access' },
        timestamp: Date.now(),
      };

      expect(engine.evaluate(context).allowed).toBe(true);
    });
  });

  // ===========================================================================
  // Edge Cases and Boundary Tests
  // ===========================================================================

  describe('Edge cases and boundary tests', () => {
    describe('time_in_range boundaries', () => {
      it('should handle exact start hour boundary (inclusive)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T09:00:00Z')); // Exactly 9:00

        engine.addRule({
          id: 'boundary_test',
          name: 'Boundary Test',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'time_in_range', params: { startHour: 9, endHour: 18, timezone: 'UTC' } },
          ],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(true);

        vi.useRealTimers();
      });

      it('should handle exact end hour boundary (exclusive)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T18:00:00Z')); // Exactly 18:00

        engine.addRule({
          id: 'boundary_test',
          name: 'Boundary Test',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'time_in_range', params: { startHour: 9, endHour: 18, timezone: 'UTC' } },
          ],
        });

        const context = createTestContext({});
        // 18:00 is exclusive (< endHour), so should be denied
        expect(engine.evaluate(context).allowed).toBe(false);

        vi.useRealTimers();
      });

      it('should handle minute before end hour', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T17:59:59Z')); // 17:59:59

        engine.addRule({
          id: 'boundary_test',
          name: 'Boundary Test',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'time_in_range', params: { startHour: 9, endHour: 18, timezone: 'UTC' } },
          ],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(true);

        vi.useRealTimers();
      });

      it('should handle invalid timezone gracefully (fallback to UTC)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T14:00:00Z'));

        engine.addRule({
          id: 'invalid_tz',
          name: 'Invalid Timezone',
          priority: 100,
          effect: 'allow',
          conditions: [
            {
              type: 'time_in_range',
              params: { startHour: 9, endHour: 18, timezone: 'Invalid/Timezone' },
            },
          ],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(true); // Falls back to UTC

        vi.useRealTimers();
      });
    });

    describe('numeric comparison edge cases', () => {
      it('should handle zero value', () => {
        engine.addRule({
          id: 'zero_check',
          name: 'Zero Check',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_gte', params: { name: 'balance', value: 0 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'balance', value: '0', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should handle negative values', () => {
        engine.addRule({
          id: 'negative_check',
          name: 'Negative Check',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_gt', params: { name: 'temperature', value: -10 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'temperature', value: '-5', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should handle decimal values', () => {
        engine.addRule({
          id: 'decimal_check',
          name: 'Decimal Check',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_between', params: { name: 'rating', min: 3.5, max: 5.0 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'rating', value: '4.2', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should handle very large numbers', () => {
        engine.addRule({
          id: 'large_number',
          name: 'Large Number Check',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_gt', params: { name: 'bytes', value: 1000000000 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'bytes', value: '5000000000', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should handle numeric_between with same min and max', () => {
        engine.addRule({
          id: 'exact_value',
          name: 'Exact Value',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'numeric_between', params: { name: 'level', min: 5, max: 5 } }],
        });

        const context = createTestContextWithAttributes({
          attributes: [{ name: 'level', value: '5', source: 'db' }],
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });
    });

    describe('IP range edge cases', () => {
      it('should handle /0 CIDR (all IPs)', () => {
        engine.addRule({
          id: 'all_ips',
          name: 'All IPs',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'ip_in_range', params: { ranges: ['0.0.0.0/0'] } }],
        });

        const context = createTestContextWithEnvironment({
          clientIp: '192.168.1.1',
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should handle Class A network', () => {
        engine.addRule({
          id: 'class_a',
          name: 'Class A Network',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'ip_in_range', params: { ranges: ['10.0.0.0/8'] } }],
        });

        const context = createTestContextWithEnvironment({
          clientIp: '10.255.255.255',
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should handle localhost', () => {
        engine.addRule({
          id: 'localhost',
          name: 'Localhost',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'ip_in_range', params: { ranges: ['127.0.0.0/8'] } }],
        });

        const context = createTestContextWithEnvironment({
          clientIp: '127.0.0.1',
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should handle invalid IP address gracefully', () => {
        engine.addRule({
          id: 'ip_check',
          name: 'IP Check',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'ip_in_range', params: { ranges: ['192.168.1.0/24'] } }],
        });

        const context = createTestContextWithEnvironment({
          clientIp: 'not-an-ip',
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });

    // ==========================================================================
    // IPv6 Support Tests
    // ==========================================================================

    describe('IPv6 support', () => {
      describe('basic IPv6 address matching', () => {
        it('should match IPv6 localhost (::1)', () => {
          engine.addRule({
            id: 'ipv6_localhost',
            name: 'IPv6 Localhost',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['::1/128'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '::1',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });

        it('should match full IPv6 address', () => {
          engine.addRule({
            id: 'ipv6_full',
            name: 'IPv6 Full Address',
            priority: 100,
            effect: 'allow',
            conditions: [
              {
                type: 'ip_in_range',
                params: { ranges: ['2001:0db8:0000:0000:0000:0000:0000:0001/128'] },
              },
            ],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '2001:db8::1',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });

        it('should match compressed IPv6 address', () => {
          engine.addRule({
            id: 'ipv6_compressed',
            name: 'IPv6 Compressed',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['2001:db8::1/128'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '2001:0db8:0000:0000:0000:0000:0000:0001',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });
      });

      describe('IPv6 CIDR range matching', () => {
        it('should match link-local range (fe80::/10)', () => {
          engine.addRule({
            id: 'ipv6_link_local',
            name: 'IPv6 Link Local',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['fe80::/10'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: 'fe80::1',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });

        it('should match unique local address range (fc00::/7)', () => {
          engine.addRule({
            id: 'ipv6_ula',
            name: 'IPv6 ULA',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['fc00::/7'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: 'fd00::1234:5678',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });

        it('should match /32 subnet', () => {
          engine.addRule({
            id: 'ipv6_32',
            name: 'IPv6 /32',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['2001:db8::/32'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '2001:db8:abcd:1234::1',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });

        it('should match /64 subnet (standard allocation)', () => {
          engine.addRule({
            id: 'ipv6_64',
            name: 'IPv6 /64',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['2001:db8:abcd:1234::/64'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '2001:db8:abcd:1234:5678:90ab:cdef:1234',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });

        it('should NOT match outside /64 subnet', () => {
          engine.addRule({
            id: 'ipv6_64_out',
            name: 'IPv6 /64 Out',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['2001:db8:abcd:1234::/64'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '2001:db8:abcd:5678::1', // Different /64
          });
          expect(engine.evaluate(context).allowed).toBe(false);
        });

        it('should handle /0 (all IPv6 addresses)', () => {
          engine.addRule({
            id: 'ipv6_all',
            name: 'All IPv6',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['::/0'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '2607:f8b0:4004:800::200e',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });
      });

      describe('IPv6 special addresses', () => {
        it('should handle unspecified address (::)', () => {
          engine.addRule({
            id: 'ipv6_unspecified',
            name: 'IPv6 Unspecified',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['::/128'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '::',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });

        it('should handle IPv6 with zone ID (stripped)', () => {
          engine.addRule({
            id: 'ipv6_zone',
            name: 'IPv6 Zone ID',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['fe80::/10'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: 'fe80::1%eth0',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });

        it('should handle Google public DNS IPv6', () => {
          engine.addRule({
            id: 'google_dns',
            name: 'Google DNS',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['2001:4860:4860::/48'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '2001:4860:4860::8888',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });
      });

      describe('IPv4/IPv6 version mismatch', () => {
        it('should NOT match IPv4 address against IPv6 range', () => {
          engine.addRule({
            id: 'ipv6_only',
            name: 'IPv6 Only',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['2001:db8::/32'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '192.168.1.1',
          });
          expect(engine.evaluate(context).allowed).toBe(false);
        });

        it('should NOT match IPv6 address against IPv4 range', () => {
          engine.addRule({
            id: 'ipv4_only',
            name: 'IPv4 Only',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['192.168.1.0/24'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '::1',
          });
          expect(engine.evaluate(context).allowed).toBe(false);
        });
      });

      describe('dual-stack (mixed IPv4/IPv6 ranges)', () => {
        it('should match IPv4 when both ranges present', () => {
          engine.addRule({
            id: 'dual_stack',
            name: 'Dual Stack',
            priority: 100,
            effect: 'allow',
            conditions: [
              {
                type: 'ip_in_range',
                params: { ranges: ['10.0.0.0/8', '2001:db8::/32'] },
              },
            ],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '10.1.2.3',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });

        it('should match IPv6 when both ranges present', () => {
          engine.addRule({
            id: 'dual_stack_v6',
            name: 'Dual Stack V6',
            priority: 100,
            effect: 'allow',
            conditions: [
              {
                type: 'ip_in_range',
                params: { ranges: ['10.0.0.0/8', '2001:db8::/32'] },
              },
            ],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '2001:db8:1234::1',
          });
          expect(engine.evaluate(context).allowed).toBe(true);
        });

        it('should deny when IP matches neither range', () => {
          engine.addRule({
            id: 'dual_stack_deny',
            name: 'Dual Stack Deny',
            priority: 100,
            effect: 'allow',
            conditions: [
              {
                type: 'ip_in_range',
                params: { ranges: ['10.0.0.0/8', '2001:db8::/32'] },
              },
            ],
          });

          const contextV4 = createTestContextWithEnvironment({
            clientIp: '192.168.1.1', // Not in 10.0.0.0/8
          });
          expect(engine.evaluate(contextV4).allowed).toBe(false);

          engine.clearRules();
          engine.addRule({
            id: 'dual_stack_deny_2',
            name: 'Dual Stack Deny 2',
            priority: 100,
            effect: 'allow',
            conditions: [
              {
                type: 'ip_in_range',
                params: { ranges: ['10.0.0.0/8', '2001:db8::/32'] },
              },
            ],
          });

          const contextV6 = createTestContextWithEnvironment({
            clientIp: '2607:f8b0:4004::1', // Not in 2001:db8::/32
          });
          expect(engine.evaluate(contextV6).allowed).toBe(false);
        });
      });

      describe('IPv6 edge cases', () => {
        it('should handle invalid IPv6 address gracefully', () => {
          engine.addRule({
            id: 'ipv6_invalid',
            name: 'IPv6 Invalid',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['2001:db8::/32'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: 'not:valid:ipv6',
          });
          expect(engine.evaluate(context).allowed).toBe(false);
        });

        it('should handle too many IPv6 groups', () => {
          engine.addRule({
            id: 'ipv6_too_many',
            name: 'IPv6 Too Many',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['2001:db8::/32'] } }],
          });

          const context = createTestContextWithEnvironment({
            clientIp: '2001:db8:0:0:0:0:0:0:0', // 9 groups
          });
          expect(engine.evaluate(context).allowed).toBe(false);
        });

        it('should handle /128 (single host)', () => {
          engine.addRule({
            id: 'ipv6_single',
            name: 'IPv6 Single Host',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['2001:db8::1234:5678/128'] } }],
          });

          const contextMatch = createTestContextWithEnvironment({
            clientIp: '2001:db8::1234:5678',
          });
          expect(engine.evaluate(contextMatch).allowed).toBe(true);

          engine.clearRules();
          engine.addRule({
            id: 'ipv6_single_2',
            name: 'IPv6 Single Host 2',
            priority: 100,
            effect: 'allow',
            conditions: [{ type: 'ip_in_range', params: { ranges: ['2001:db8::1234:5678/128'] } }],
          });

          const contextNoMatch = createTestContextWithEnvironment({
            clientIp: '2001:db8::1234:5679', // Off by one
          });
          expect(engine.evaluate(contextNoMatch).allowed).toBe(false);
        });
      });
    });

    describe('country code edge cases', () => {
      it('should handle 3-letter country codes', () => {
        engine.addRule({
          id: 'country_3_letter',
          name: 'Country 3 Letter',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'country_in', params: { countries: ['USA', 'JPN'] } }],
        });

        // Note: Implementation may need to handle both 2-letter and 3-letter codes
        const context = createTestContextWithEnvironment({
          countryCode: 'USA',
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should handle empty country code', () => {
        engine.addRule({
          id: 'country_check',
          name: 'Country Check',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'country_in', params: { countries: ['US'] } }],
        });

        const context = createTestContextWithEnvironment({
          countryCode: '',
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });

      it('should handle empty countries array in country_in', () => {
        engine.addRule({
          id: 'empty_countries',
          name: 'Empty Countries',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'country_in', params: { countries: [] } }],
        });

        const context = createTestContextWithEnvironment({
          countryCode: 'US',
        });
        expect(engine.evaluate(context).allowed).toBe(false);
      });

      it('should handle empty countries array in country_not_in (allows all)', () => {
        engine.addRule({
          id: 'no_blocked',
          name: 'No Blocked Countries',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'country_not_in', params: { countries: [] } }],
        });

        const context = createTestContextWithEnvironment({
          countryCode: 'RU',
        });
        expect(engine.evaluate(context).allowed).toBe(true);
      });
    });

    describe('day_of_week edge cases', () => {
      it('should handle Saturday (day 6)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-13T12:00:00Z')); // Saturday

        engine.addRule({
          id: 'weekend_only',
          name: 'Weekend Only',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'day_of_week', params: { allowedDays: [0, 6], timezone: 'UTC' } }],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(true);

        vi.useRealTimers();
      });

      it('should handle empty allowedDays array', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));

        engine.addRule({
          id: 'no_days',
          name: 'No Days Allowed',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'day_of_week', params: { allowedDays: [], timezone: 'UTC' } }],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(false);

        vi.useRealTimers();
      });

      it('should handle all days allowed', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));

        engine.addRule({
          id: 'all_days',
          name: 'All Days',
          priority: 100,
          effect: 'allow',
          conditions: [
            {
              type: 'day_of_week',
              params: { allowedDays: [0, 1, 2, 3, 4, 5, 6], timezone: 'UTC' },
            },
          ],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(true);

        vi.useRealTimers();
      });
    });

    describe('valid_during edge cases', () => {
      it('should handle only "from" specified (no end)', () => {
        vi.useFakeTimers();
        const now = Math.floor(Date.now() / 1000);
        vi.setSystemTime(new Date(now * 1000));

        engine.addRule({
          id: 'from_only',
          name: 'From Only',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'valid_during', params: { from: now - 3600 } }], // Started 1 hour ago
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(true);

        vi.useRealTimers();
      });

      it('should handle only "to" specified (no start)', () => {
        vi.useFakeTimers();
        const now = Math.floor(Date.now() / 1000);
        vi.setSystemTime(new Date(now * 1000));

        engine.addRule({
          id: 'to_only',
          name: 'To Only',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'valid_during', params: { to: now + 3600 } }], // Ends in 1 hour
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(true);

        vi.useRealTimers();
      });

      it('should handle exact boundary (from equals now)', () => {
        vi.useFakeTimers();
        const now = Math.floor(Date.now() / 1000);
        vi.setSystemTime(new Date(now * 1000));

        engine.addRule({
          id: 'exact_from',
          name: 'Exact From',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'valid_during', params: { from: now, to: now + 3600 } }],
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(true);

        vi.useRealTimers();
      });

      it('should handle exact boundary (to equals now - inclusive)', () => {
        vi.useFakeTimers();
        const now = Math.floor(Date.now() / 1000);
        vi.setSystemTime(new Date(now * 1000));

        engine.addRule({
          id: 'exact_to',
          name: 'Exact To',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'valid_during', params: { from: now - 3600, to: now } }],
        });

        const context = createTestContext({});
        // Boundary behavior: to is inclusive (now <= to returns true)
        expect(engine.evaluate(context).allowed).toBe(true);

        vi.useRealTimers();
      });

      it('should deny when now exceeds to boundary', () => {
        vi.useFakeTimers();
        const now = Math.floor(Date.now() / 1000);
        vi.setSystemTime(new Date(now * 1000));

        engine.addRule({
          id: 'past_to',
          name: 'Past To',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'valid_during', params: { from: now - 7200, to: now - 1 } }], // Ended 1 second ago
        });

        const context = createTestContext({});
        expect(engine.evaluate(context).allowed).toBe(false);

        vi.useRealTimers();
      });
    });
  });

  // ===========================================================================
  // Rate-based Conditions Tests
  // ===========================================================================

  describe('Rate-based conditions', () => {
    /**
     * Helper to create context with request counts
     */
    function createTestContextWithCounts(
      counts: Array<{ key: string; count: number; windowSeconds?: number; resetAt?: number }>
    ): PolicyContext {
      const now = Math.floor(Date.now() / 1000);
      return {
        subject: { id: 'user_123', roles: [] },
        resource: { type: 'api', id: 'endpoint_456' },
        action: { name: 'call' },
        timestamp: Date.now(),
        environment: {
          requestCounts: counts.map((c) => ({
            key: c.key,
            count: c.count,
            windowSeconds: c.windowSeconds ?? 3600,
            resetAt: c.resetAt ?? now + 3600,
          })),
        },
      };
    }

    describe('request_count_lt', () => {
      it('should allow when count is below limit', () => {
        engine.addRule({
          id: 'rate_limit',
          name: 'API Rate Limit',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'request_count_lt', params: { key: 'user:user_123:api', limit: 100 } },
          ],
        });

        const context = createTestContextWithCounts([{ key: 'user:user_123:api', count: 50 }]);
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should deny when count equals limit', () => {
        engine.addRule({
          id: 'rate_limit',
          name: 'API Rate Limit',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'request_count_lt', params: { key: 'user:user_123:api', limit: 100 } },
          ],
        });

        const context = createTestContextWithCounts([{ key: 'user:user_123:api', count: 100 }]);
        expect(engine.evaluate(context).allowed).toBe(false);
      });

      it('should deny when count exceeds limit', () => {
        engine.addRule({
          id: 'rate_limit',
          name: 'API Rate Limit',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'request_count_lt', params: { key: 'user:user_123:api', limit: 100 } },
          ],
        });

        const context = createTestContextWithCounts([{ key: 'user:user_123:api', count: 150 }]);
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });

    describe('request_count_lte', () => {
      it('should allow when count equals limit', () => {
        engine.addRule({
          id: 'rate_limit',
          name: 'API Rate Limit',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'request_count_lte', params: { key: 'user:user_123:api', limit: 100 } },
          ],
        });

        const context = createTestContextWithCounts([{ key: 'user:user_123:api', count: 100 }]);
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should deny when count exceeds limit', () => {
        engine.addRule({
          id: 'rate_limit',
          name: 'API Rate Limit',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'request_count_lte', params: { key: 'user:user_123:api', limit: 100 } },
          ],
        });

        const context = createTestContextWithCounts([{ key: 'user:user_123:api', count: 101 }]);
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });

    describe('request_count_gt and request_count_gte', () => {
      it('should allow power users with request_count_gt', () => {
        // Policy: Allow premium features for users with > 1000 requests (power users)
        engine.addRule({
          id: 'power_user',
          name: 'Power User Features',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'request_count_gt', params: { key: 'user:user_123:total', threshold: 1000 } },
          ],
        });

        const context = createTestContextWithCounts([{ key: 'user:user_123:total', count: 1500 }]);
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should deny when count does not exceed threshold', () => {
        engine.addRule({
          id: 'power_user',
          name: 'Power User Features',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'request_count_gt', params: { key: 'user:user_123:total', threshold: 1000 } },
          ],
        });

        const context = createTestContextWithCounts([{ key: 'user:user_123:total', count: 1000 }]);
        expect(engine.evaluate(context).allowed).toBe(false);
      });

      it('should allow with request_count_gte at exact threshold', () => {
        engine.addRule({
          id: 'verified_user',
          name: 'Verified User',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'request_count_gte', params: { key: 'user:user_123:logins', threshold: 5 } },
          ],
        });

        const context = createTestContextWithCounts([{ key: 'user:user_123:logins', count: 5 }]);
        expect(engine.evaluate(context).allowed).toBe(true);
      });
    });

    describe('wildcard key matching', () => {
      it('should match with * wildcard', () => {
        engine.addRule({
          id: 'wildcard_match',
          name: 'Wildcard Match',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'request_count_lt', params: { key: 'user:*:api', limit: 100 } }],
        });

        const context = createTestContextWithCounts([{ key: 'user:user_123:api', count: 50 }]);
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should match with multiple wildcards', () => {
        engine.addRule({
          id: 'multi_wildcard',
          name: 'Multi Wildcard',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'request_count_lt', params: { key: '*:*:api', limit: 100 } }],
        });

        const context = createTestContextWithCounts([{ key: 'org:org_456:api', count: 50 }]);
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should not match when pattern does not match', () => {
        engine.addRule({
          id: 'no_match',
          name: 'No Match',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'request_count_lt', params: { key: 'user:user_999:api', limit: 100 } },
          ],
        });

        const context = createTestContextWithCounts([{ key: 'user:user_123:api', count: 50 }]);
        // No matching count found, condition returns false
        expect(engine.evaluate(context).allowed).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should handle missing requestCounts (return false)', () => {
        engine.addRule({
          id: 'no_counts',
          name: 'No Counts',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'request_count_lt', params: { key: 'user:user_123:api', limit: 100 } },
          ],
        });

        const context: PolicyContext = {
          subject: { id: 'user_123', roles: [] },
          resource: { type: 'api', id: 'endpoint_456' },
          action: { name: 'call' },
          timestamp: Date.now(),
          // No environment.requestCounts
        };
        expect(engine.evaluate(context).allowed).toBe(false);
      });

      it('should handle empty requestCounts array', () => {
        engine.addRule({
          id: 'empty_counts',
          name: 'Empty Counts',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'request_count_lt', params: { key: 'user:user_123:api', limit: 100 } },
          ],
        });

        const context = createTestContextWithCounts([]);
        expect(engine.evaluate(context).allowed).toBe(false);
      });

      it('should handle zero count', () => {
        engine.addRule({
          id: 'zero_count',
          name: 'Zero Count',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'request_count_lt', params: { key: 'user:user_123:api', limit: 1 } },
          ],
        });

        const context = createTestContextWithCounts([{ key: 'user:user_123:api', count: 0 }]);
        expect(engine.evaluate(context).allowed).toBe(true);
      });

      it('should use first matching count when multiple match', () => {
        engine.addRule({
          id: 'first_match',
          name: 'First Match',
          priority: 100,
          effect: 'allow',
          conditions: [{ type: 'request_count_lt', params: { key: 'user:*:api', limit: 100 } }],
        });

        // First matching entry (user_123) has count 50 < 100
        const context = createTestContextWithCounts([
          { key: 'user:user_123:api', count: 50 },
          { key: 'user:user_456:api', count: 150 },
        ]);
        expect(engine.evaluate(context).allowed).toBe(true);
      });
    });

    describe('integration with other conditions', () => {
      it('should combine rate limit with role check', () => {
        engine.addRule({
          id: 'premium_rate_limit',
          name: 'Premium Rate Limit',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'has_role', params: { role: 'premium' } },
            { type: 'request_count_lte', params: { key: 'user:user_123:api', limit: 1000 } },
          ],
        });

        // Non-premium user below limit - denied (missing role)
        const nonPremiumContext: PolicyContext = {
          subject: { id: 'user_123', roles: [{ name: 'basic', scope: 'global' }] },
          resource: { type: 'api', id: 'endpoint_456' },
          action: { name: 'call' },
          timestamp: Date.now(),
          environment: {
            requestCounts: [
              {
                key: 'user:user_123:api',
                count: 100,
                windowSeconds: 3600,
                resetAt: Date.now() / 1000 + 3600,
              },
            ],
          },
        };
        expect(engine.evaluate(nonPremiumContext).allowed).toBe(false);

        engine.clearRules();
        engine.addRule({
          id: 'premium_rate_limit_2',
          name: 'Premium Rate Limit 2',
          priority: 100,
          effect: 'allow',
          conditions: [
            { type: 'has_role', params: { role: 'premium' } },
            { type: 'request_count_lte', params: { key: 'user:user_123:api', limit: 1000 } },
          ],
        });

        // Premium user below limit - allowed
        const premiumContext: PolicyContext = {
          subject: { id: 'user_123', roles: [{ name: 'premium', scope: 'global' }] },
          resource: { type: 'api', id: 'endpoint_456' },
          action: { name: 'call' },
          timestamp: Date.now(),
          environment: {
            requestCounts: [
              {
                key: 'user:user_123:api',
                count: 100,
                windowSeconds: 3600,
                resetAt: Date.now() / 1000 + 3600,
              },
            ],
          },
        };
        expect(engine.evaluate(premiumContext).allowed).toBe(true);
      });
    });
  });

  // ===========================================================================
  // Complex Integration Scenarios
  // ===========================================================================

  describe('Complex integration scenarios', () => {
    it('should handle enterprise access policy (RBAC + ABAC + Time + Geo)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T10:00:00Z')); // Monday 10 AM UTC

      engine.addRule({
        id: 'enterprise_policy',
        name: 'Enterprise Access Policy',
        description: 'Full enterprise access with all conditions',
        priority: 100,
        effect: 'allow',
        conditions: [
          { type: 'has_role', params: { role: 'enterprise_user' } },
          { type: 'numeric_gte', params: { name: 'clearance_level', value: 3 } },
          { type: 'time_in_range', params: { startHour: 8, endHour: 20, timezone: 'UTC' } },
          { type: 'country_in', params: { countries: ['US', 'CA', 'GB', 'JP'] } },
          { type: 'ip_in_range', params: { ranges: ['10.0.0.0/8', '192.168.0.0/16'] } },
        ],
      });

      // All conditions met
      const validContext: PolicyContext = {
        subject: {
          id: 'user_123',
          roles: [{ name: 'enterprise_user', scope: 'global' }],
          verifiedAttributes: [{ name: 'clearance_level', value: '5', source: 'db' }],
        } as PolicySubjectWithAttributes,
        resource: { type: 'secret_document', id: 'doc_456' },
        action: { name: 'read' },
        timestamp: Date.now(),
        environment: {
          countryCode: 'US',
          clientIp: '10.20.30.40',
        },
      };
      expect(engine.evaluate(validContext).allowed).toBe(true);

      // Missing role
      const noRoleContext: PolicyContext = {
        ...validContext,
        subject: {
          id: 'user_123',
          roles: [{ name: 'basic_user', scope: 'global' }],
          verifiedAttributes: [{ name: 'clearance_level', value: '5', source: 'db' }],
        } as PolicySubjectWithAttributes,
      };
      expect(engine.evaluate(noRoleContext).allowed).toBe(false);

      // Wrong country
      const wrongCountryContext: PolicyContext = {
        ...validContext,
        environment: { countryCode: 'RU', clientIp: '10.20.30.40' },
      };
      expect(engine.evaluate(wrongCountryContext).allowed).toBe(false);

      // Wrong IP range
      const wrongIpContext: PolicyContext = {
        ...validContext,
        environment: { countryCode: 'US', clientIp: '203.0.113.50' },
      };
      expect(engine.evaluate(wrongIpContext).allowed).toBe(false);

      vi.useRealTimers();
    });

    it('should handle tiered access with multiple rules (fallback)', () => {
      // Premium tier - full access
      engine.addRule({
        id: 'premium_access',
        name: 'Premium Tier Access',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'numeric_eq', params: { name: 'tier', value: 3 } }],
      });

      // Standard tier - limited access with time restriction
      engine.addRule({
        id: 'standard_access',
        name: 'Standard Tier Access',
        priority: 90,
        effect: 'allow',
        conditions: [
          { type: 'numeric_eq', params: { name: 'tier', value: 2 } },
          { type: 'time_in_range', params: { startHour: 9, endHour: 17, timezone: 'UTC' } },
        ],
      });

      // Basic tier - deny
      engine.addRule({
        id: 'basic_deny',
        name: 'Basic Tier Deny',
        priority: 80,
        effect: 'deny',
        conditions: [{ type: 'numeric_lte', params: { name: 'tier', value: 1 } }],
      });

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T10:00:00Z'));

      // Premium user - allowed
      const premiumContext = createTestContextWithAttributes({
        attributes: [{ name: 'tier', value: '3', source: 'db' }],
      });
      expect(engine.evaluate(premiumContext).allowed).toBe(true);

      // Standard user during business hours - allowed
      const standardContext = createTestContextWithAttributes({
        attributes: [{ name: 'tier', value: '2', source: 'db' }],
      });
      expect(engine.evaluate(standardContext).allowed).toBe(true);

      // Basic user - denied
      const basicContext = createTestContextWithAttributes({
        attributes: [{ name: 'tier', value: '1', source: 'db' }],
      });
      expect(engine.evaluate(basicContext).allowed).toBe(false);

      vi.useRealTimers();
    });

    it('should handle compliance policy (geographic + time restrictions)', () => {
      vi.useFakeTimers();

      // GDPR-like: Only allow EU access during EU business hours
      engine.addRule({
        id: 'gdpr_compliance',
        name: 'GDPR Compliance Policy',
        priority: 100,
        effect: 'allow',
        conditions: [
          { type: 'country_in', params: { countries: ['DE', 'FR', 'IT', 'ES', 'NL'] } },
          {
            type: 'time_in_range',
            params: { startHour: 8, endHour: 18, timezone: 'Europe/Berlin' },
          },
          {
            type: 'day_of_week',
            params: { allowedDays: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' },
          },
        ],
      });

      // 10:00 UTC = 11:00 Berlin (CET), Monday
      vi.setSystemTime(new Date('2024-01-15T10:00:00Z'));

      const euContext = createTestContextWithEnvironment({
        countryCode: 'DE',
      });
      expect(engine.evaluate(euContext).allowed).toBe(true);

      // Non-EU country
      const nonEuContext = createTestContextWithEnvironment({
        countryCode: 'US',
      });
      expect(engine.evaluate(nonEuContext).allowed).toBe(false);

      vi.useRealTimers();
    });

    it('should handle deny rules taking precedence', () => {
      // Allow all internal IPs
      engine.addRule({
        id: 'internal_allow',
        name: 'Internal Network Allow',
        priority: 100,
        effect: 'allow',
        conditions: [{ type: 'ip_in_range', params: { ranges: ['10.0.0.0/8'] } }],
      });

      // But deny blocked countries even from internal
      engine.addRule({
        id: 'blocked_country_deny',
        name: 'Blocked Country Deny',
        priority: 200, // Higher priority
        effect: 'deny',
        conditions: [{ type: 'country_in', params: { countries: ['KP', 'IR'] } }],
      });

      // Internal IP from allowed country
      const allowedContext = createTestContextWithEnvironment({
        clientIp: '10.20.30.40',
        countryCode: 'US',
      });
      expect(engine.evaluate(allowedContext).allowed).toBe(true);

      // Internal IP but blocked country - denied (higher priority deny)
      const blockedContext = createTestContextWithEnvironment({
        clientIp: '10.20.30.40',
        countryCode: 'KP',
      });
      expect(engine.evaluate(blockedContext).allowed).toBe(false);
    });
  });
});

// ===========================================================================
// Helper Functions
// ===========================================================================

/**
 * Create basic test context
 */
function createTestContext(options: {
  subjectId?: string;
  roles?: Array<{ name: string; scope: 'global' | 'group' | 'resource' }>;
}): PolicyContext {
  return {
    subject: {
      id: options.subjectId || 'test_user',
      roles: options.roles || [],
    },
    resource: {
      type: 'test_resource',
      id: 'resource_1',
    },
    action: {
      name: 'read',
    },
    timestamp: Date.now(),
  };
}

/**
 * Create test context with verified attributes (for numeric conditions)
 */
function createTestContextWithAttributes(options: {
  attributes: Array<{ name: string; value: string; source: string }>;
}): PolicyContext {
  return {
    subject: {
      id: 'test_user',
      roles: [],
      verifiedAttributes: options.attributes.map((attr) => ({
        name: attr.name,
        value: attr.value,
        source: attr.source,
      })),
    } as PolicySubjectWithAttributes,
    resource: {
      type: 'test_resource',
      id: 'resource_1',
    },
    action: {
      name: 'read',
    },
    timestamp: Date.now(),
  };
}

/**
 * Create test context with environment (for geographic conditions)
 */
function createTestContextWithEnvironment(options: {
  clientIp?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  timezone?: string;
}): PolicyContext {
  return {
    subject: {
      id: 'test_user',
      roles: [],
    },
    resource: {
      type: 'test_resource',
      id: 'resource_1',
    },
    action: {
      name: 'read',
    },
    timestamp: Date.now(),
    environment: {
      clientIp: options.clientIp,
      countryCode: options.countryCode,
      region: options.region,
      city: options.city,
      timezone: options.timezone,
    },
  };
}
