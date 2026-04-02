/**
 * Comprehensive Domain Pattern Validation Tests
 *
 * Tests all expected domain patterns across different environments
 * to ensure the architecture correctly handles:
 * - Environment separation (each env = separate instance)
 * - Tenant isolation within each environment
 * - Sub-subdomain rejection
 */

import { describe, it, expect } from 'vitest';
import { validateHostHeader, extractSubdomain } from '../issuer';

describe('Domain Pattern Validation - Production Environment', () => {
  const prodEnv = {
    BASE_DOMAIN: 'authrim.com',
    DEFAULT_TENANT_ID: 'default',
    PRIMARY_TENANT_ID: 'main',
    NAKED_DOMAIN_AS_ISSUER: 'true',
  };

  describe('Valid patterns', () => {
    it('should accept naked domain → PRIMARY_TENANT_ID', () => {
      const result = validateHostHeader('authrim.com', prodEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('main');
    });

    it('should accept simple tenant', () => {
      const result = validateHostHeader('acme.authrim.com', prodEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme');
    });

    it('should accept hyphenated tenant', () => {
      const result = validateHostHeader('acme-corp.authrim.com', prodEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme-corp');
    });

    it('should accept tenant with environment-like suffix', () => {
      const result = validateHostHeader('acme-prod.authrim.com', prodEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme-prod');
    });

    it('should accept tenant with numbers', () => {
      const result = validateHostHeader('tenant123.authrim.com', prodEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('tenant123');
    });

    it('should accept single character tenant', () => {
      const result = validateHostHeader('a.authrim.com', prodEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('a');
    });

    it('should accept multiple hyphens', () => {
      const result = validateHostHeader('a-b-c-d.authrim.com', prodEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('a-b-c-d');
    });

    it('should accept with port number', () => {
      const result = validateHostHeader('acme.authrim.com:8080', prodEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme');
    });

    it('should accept naked domain with port', () => {
      const result = validateHostHeader('authrim.com:443', prodEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('main');
    });
  });

  describe('Invalid patterns - sub-subdomain (MUST be rejected)', () => {
    it('should reject dev.acme.authrim.com', () => {
      const result = validateHostHeader('dev.acme.authrim.com', prodEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
      expect(result.statusCode).toBe(400);
    });

    it('should reject api.acme.authrim.com', () => {
      const result = validateHostHeader('api.acme.authrim.com', prodEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });

    it('should reject auth.tenant.authrim.com', () => {
      const result = validateHostHeader('auth.tenant.authrim.com', prodEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });

    it('should reject sub-subdomain with port', () => {
      const result = validateHostHeader('api.tenant.authrim.com:8080', prodEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });
  });

  describe('Invalid patterns - other reasons', () => {
    it('should reject different base domain', () => {
      const result = validateHostHeader('acme.other.com', prodEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('tenant_not_found');
      expect(result.statusCode).toBe(404);
    });

    it('should reject tenant starting with hyphen', () => {
      const result = validateHostHeader('-acme.authrim.com', prodEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });

    it('should reject tenant ending with hyphen', () => {
      const result = validateHostHeader('acme-.authrim.com', prodEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });

    it('should reject tenant with special characters', () => {
      const result = validateHostHeader('tenant_name.authrim.com', prodEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });

    it('should reject missing host header', () => {
      const result = validateHostHeader(undefined, prodEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('missing_host');
      expect(result.statusCode).toBe(400);
    });
  });
});

describe('Domain Pattern Validation - Staging Environment', () => {
  const stagingEnv = {
    BASE_DOMAIN: 'staging.authrim.com',
    DEFAULT_TENANT_ID: 'default',
  };

  describe('Valid patterns', () => {
    it('should reject naked domain when omission is disabled', () => {
      const result = validateHostHeader('staging.authrim.com', stagingEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('should accept simple tenant', () => {
      const result = validateHostHeader('acme.staging.authrim.com', stagingEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme');
    });

    it('should accept hyphenated tenant', () => {
      const result = validateHostHeader('acme-test.staging.authrim.com', stagingEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme-test');
    });
  });

  describe('Invalid patterns', () => {
    it('should reject sub-subdomain', () => {
      const result = validateHostHeader('dev.acme.staging.authrim.com', stagingEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });

    it('should reject production domain', () => {
      const result = validateHostHeader('acme.authrim.com', stagingEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });
  });
});

describe('Domain Pattern Validation - Test Environment', () => {
  const testEnv = {
    BASE_DOMAIN: 'test.authrim.com',
    DEFAULT_TENANT_ID: 'default',
  };

  describe('Valid patterns', () => {
    it('should reject naked domain when omission is disabled', () => {
      const result = validateHostHeader('test.authrim.com', testEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('should accept simple tenant', () => {
      const result = validateHostHeader('acme.test.authrim.com', testEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme');
    });

    it('should accept widget-co tenant', () => {
      const result = validateHostHeader('widget-co.test.authrim.com', testEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('widget-co');
    });
  });

  describe('Invalid patterns', () => {
    it('should reject sub-subdomain', () => {
      const result = validateHostHeader('api.acme.test.authrim.com', testEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });
  });
});

describe('Domain Pattern Validation - Dev Environment', () => {
  const devEnv = {
    BASE_DOMAIN: 'dev.authrim.com',
    DEFAULT_TENANT_ID: 'default',
  };

  describe('Valid patterns', () => {
    it('should reject naked domain when omission is disabled', () => {
      const result = validateHostHeader('dev.authrim.com', devEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('should accept tenant', () => {
      const result = validateHostHeader('acme.dev.authrim.com', devEnv);
      expect(result.valid).toBe(true);
      expect(result.tenantId).toBe('acme');
    });
  });

  describe('Invalid patterns', () => {
    it('should reject sub-subdomain', () => {
      const result = validateHostHeader('local.acme.dev.authrim.com', devEnv);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_format');
    });
  });
});

describe('extractSubdomain - Legacy function', () => {
  it('should extract simple subdomain', () => {
    expect(extractSubdomain('acme.authrim.com', 'authrim.com')).toBe('acme');
  });

  it('should extract hyphenated subdomain', () => {
    expect(extractSubdomain('acme-corp.authrim.com', 'authrim.com')).toBe('acme-corp');
  });

  it('should handle port', () => {
    expect(extractSubdomain('acme.authrim.com:8080', 'authrim.com')).toBe('acme');
  });

  it('should return null for naked domain', () => {
    expect(extractSubdomain('authrim.com', 'authrim.com')).toBeNull();
  });

  it('should return null for different base domain', () => {
    expect(extractSubdomain('acme.other.com', 'authrim.com')).toBeNull();
  });

  it('should return null for sub-subdomain', () => {
    expect(extractSubdomain('dev.acme.authrim.com', 'authrim.com')).toBeNull();
  });

  it('should return null for empty hostname', () => {
    expect(extractSubdomain('', 'authrim.com')).toBeNull();
  });

  it('should handle complex base domain', () => {
    expect(extractSubdomain('acme.api.authrim.app', 'api.authrim.app')).toBe('acme');
  });

  it('should reject sub-subdomain even with complex base domain', () => {
    expect(extractSubdomain('dev.acme.api.authrim.app', 'api.authrim.app')).toBeNull();
  });
});
