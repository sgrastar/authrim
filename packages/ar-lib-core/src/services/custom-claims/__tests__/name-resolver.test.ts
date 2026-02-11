import { describe, it, expect } from 'vitest';
import { ClaimNameResolver } from '../name-resolver';

describe('ClaimNameResolver', () => {
  const resolver = new ClaimNameResolver();

  describe('resolve', () => {
    it('returns field_key when no namespace', () => {
      expect(resolver.resolve({ field_key: 'employee_id', claim_namespace: null })).toBe(
        'employee_id'
      );
    });

    it('returns field_key when namespace is empty', () => {
      expect(resolver.resolve({ field_key: 'employee_id', claim_namespace: '' })).toBe(
        'employee_id'
      );
    });

    it('prefixes with namespace', () => {
      expect(resolver.resolve({ field_key: 'employee_id', claim_namespace: 'custom:' })).toBe(
        'custom:employee_id'
      );
    });

    it('handles URI namespace', () => {
      expect(
        resolver.resolve({
          field_key: 'role',
          claim_namespace: 'https://example.com/claims/',
        })
      ).toBe('https://example.com/claims/role');
    });
  });

  describe('isStandardClaimCollision', () => {
    it('detects JWT reserved claims', () => {
      expect(resolver.isStandardClaimCollision('sub')).toBe(true);
      expect(resolver.isStandardClaimCollision('iss')).toBe(true);
      expect(resolver.isStandardClaimCollision('aud')).toBe(true);
      expect(resolver.isStandardClaimCollision('exp')).toBe(true);
      expect(resolver.isStandardClaimCollision('iat')).toBe(true);
    });

    it('detects OIDC standard claims', () => {
      expect(resolver.isStandardClaimCollision('email')).toBe(true);
      expect(resolver.isStandardClaimCollision('name')).toBe(true);
      expect(resolver.isStandardClaimCollision('phone_number')).toBe(true);
      expect(resolver.isStandardClaimCollision('address')).toBe(true);
      expect(resolver.isStandardClaimCollision('updated_at')).toBe(true);
    });

    it('allows custom claim names', () => {
      expect(resolver.isStandardClaimCollision('employee_id')).toBe(false);
      expect(resolver.isStandardClaimCollision('department')).toBe(false);
      expect(resolver.isStandardClaimCollision('custom:email')).toBe(false);
    });

    it('handles empty namespace + reserved name collision', () => {
      // If field_key is "email" and namespace is empty → "email" collides
      const claimName = resolver.resolve({ field_key: 'email', claim_namespace: '' });
      expect(resolver.isStandardClaimCollision(claimName)).toBe(true);
    });

    it('namespace prevents collision', () => {
      const claimName = resolver.resolve({ field_key: 'email', claim_namespace: 'ext:' });
      expect(resolver.isStandardClaimCollision(claimName)).toBe(false);
    });
  });
});
