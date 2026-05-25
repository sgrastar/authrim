import { describe, it, expect } from 'vitest';
import { remapShardIndex, getTenantIdFromHost, resolveTenantFromRequest } from '../tenant-context';
import type { Env } from '../../types/env';

describe('getTenantIdFromHost', () => {
  describe('multi-tenant mode', () => {
    const multiTenantEnv: Partial<Env> = {
      BASE_DOMAIN: 'authrim.com',
      DEFAULT_TENANT_ID: 'default',
    };

    it('should extract tenant from subdomain', () => {
      const result = getTenantIdFromHost('acme.authrim.com', multiTenantEnv);
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('acme');
    });

    it('should handle hyphenated tenant names', () => {
      const result = getTenantIdFromHost('acme-corp.authrim.com', multiTenantEnv);
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('acme-corp');
    });

    it('should reject naked domain when tenant omission is disabled', () => {
      const result = getTenantIdFromHost('authrim.com', multiTenantEnv);
      expect(result.success).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('should return error for missing host', () => {
      const result = getTenantIdFromHost(undefined, multiTenantEnv);
      expect(result.success).toBe(false);
      expect(result.error).toBe('missing_host');
      expect(result.statusCode).toBe(400);
    });
  });

  describe('PRIMARY_TENANT_ID', () => {
    const envWithPrimary: Partial<Env> = {
      BASE_DOMAIN: 'authrim.com',
      DEFAULT_TENANT_ID: 'default',
      PRIMARY_TENANT_ID: 'tenantA',
    };

    it('should use PRIMARY_TENANT_ID for naked domain', () => {
      const result = getTenantIdFromHost('authrim.com', {
        ...envWithPrimary,
        NAKED_DOMAIN_AS_ISSUER: 'true',
      });
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('tenantA');
    });

    it('should still reject naked domain when PRIMARY_TENANT_ID is set but omission is disabled', () => {
      const result = getTenantIdFromHost('authrim.com', envWithPrimary);
      expect(result.success).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('should use explicit tenant over PRIMARY_TENANT_ID', () => {
      const result = getTenantIdFromHost('widget.authrim.com', envWithPrimary);
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('widget');
    });
  });

  describe('single-tenant mode', () => {
    it('should return default tenant when BASE_DOMAIN is not set', () => {
      const result = getTenantIdFromHost('any.example.com', {});
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('default');
    });
  });
});

describe('resolveTenantFromRequest', () => {
  describe('multi-tenant mode', () => {
    const multiTenantEnv: Partial<Env> = {
      BASE_DOMAIN: 'test.authrim.com',
      DEFAULT_TENANT_ID: 'default',
    };

    it('should reject forwarded naked domain when tenant omission is disabled', () => {
      const request = new Request(
        'https://test-ar-router.sgrastar.workers.dev/api/auth/login-methods',
        {
          headers: {
            Host: 'test-ar-router.sgrastar.workers.dev',
            'X-Authrim-Forwarded-Host': 'test.authrim.com',
          },
        }
      );

      const result = resolveTenantFromRequest(request, multiTenantEnv);
      expect(result.success).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('should resolve tenant subdomain from X-Forwarded-Host when Host is workers.dev', () => {
      const request = new Request(
        'https://test-ar-router.sgrastar.workers.dev/api/auth/login-methods',
        {
          headers: {
            Host: 'test-ar-router.sgrastar.workers.dev',
            'X-Forwarded-Host': 'acme.test.authrim.com',
          },
        }
      );

      const result = resolveTenantFromRequest(request, multiTenantEnv);
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('acme');
    });

    it('should prefer a valid forwarded tenant host over an invalid naked-domain host', () => {
      const request = new Request(
        'https://test-ar-router.sgrastar.workers.dev/api/auth/login-methods',
        {
          headers: {
            Host: 'test-ar-router.sgrastar.workers.dev',
            'X-Authrim-Forwarded-Host': 'test.authrim.com',
            'X-Forwarded-Host': 'acme.test.authrim.com',
          },
        }
      );

      const result = resolveTenantFromRequest(request, multiTenantEnv);
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('acme');
    });

    it('should resolve forwarded naked domain when tenant omission is enabled', () => {
      const request = new Request(
        'https://test-ar-router.sgrastar.workers.dev/api/auth/login-methods',
        {
          headers: {
            Host: 'test-ar-router.sgrastar.workers.dev',
            'X-Authrim-Forwarded-Host': 'test.authrim.com',
          },
        }
      );

      const result = resolveTenantFromRequest(request, {
        ...multiTenantEnv,
        NAKED_DOMAIN_AS_ISSUER: 'true',
      });
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('default');
    });

    it('should prefer Host when it already resolves to a tenant', () => {
      const request = new Request('https://acme.test.authrim.com/api/auth/login-methods', {
        headers: {
          Host: 'acme.test.authrim.com',
          'X-Forwarded-Host': 'test.authrim.com',
        },
      });

      const result = resolveTenantFromRequest(request, multiTenantEnv);
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('acme');
    });
  });
});

describe('remapShardIndex', () => {
  it('should keep shard index within range', () => {
    expect(remapShardIndex(15, 32)).toBe(15); // No remap
    expect(remapShardIndex(45, 32)).toBe(13); // Remap: 45 % 32 = 13
    expect(remapShardIndex(63, 32)).toBe(31); // Remap: 63 % 32 = 31
  });

  it('should handle scale-down scenarios', () => {
    // 64 → 32
    expect(remapShardIndex(0, 32)).toBe(0);
    expect(remapShardIndex(31, 32)).toBe(31);
    expect(remapShardIndex(32, 32)).toBe(0);
    expect(remapShardIndex(63, 32)).toBe(31);
  });

  it('should be idempotent for in-range shards', () => {
    for (let i = 0; i < 32; i++) {
      expect(remapShardIndex(i, 32)).toBe(i);
    }
  });

  it('should handle various scale-down ratios', () => {
    // 128 → 64
    expect(remapShardIndex(0, 64)).toBe(0);
    expect(remapShardIndex(64, 64)).toBe(0);
    expect(remapShardIndex(127, 64)).toBe(63);

    // 64 → 16
    expect(remapShardIndex(0, 16)).toBe(0);
    expect(remapShardIndex(16, 16)).toBe(0);
    expect(remapShardIndex(48, 16)).toBe(0);
    expect(remapShardIndex(63, 16)).toBe(15);

    // 96 → 32
    expect(remapShardIndex(0, 32)).toBe(0);
    expect(remapShardIndex(32, 32)).toBe(0);
    expect(remapShardIndex(64, 32)).toBe(0);
    expect(remapShardIndex(95, 32)).toBe(31);
  });

  it('should throw error for invalid shard count', () => {
    expect(() => remapShardIndex(10, 0)).toThrow('Invalid shard count: must be greater than 0');
    expect(() => remapShardIndex(10, -1)).toThrow('Invalid shard count: must be greater than 0');
    expect(() => remapShardIndex(10, -100)).toThrow('Invalid shard count: must be greater than 0');
  });

  it('should handle edge cases', () => {
    // Shard index 0 always maps to 0
    expect(remapShardIndex(0, 1)).toBe(0);
    expect(remapShardIndex(0, 64)).toBe(0);
    expect(remapShardIndex(0, 128)).toBe(0);

    // Single shard (all codes go to shard 0)
    expect(remapShardIndex(0, 1)).toBe(0);
    expect(remapShardIndex(10, 1)).toBe(0);
    expect(remapShardIndex(100, 1)).toBe(0);

    // Very large shard indices
    expect(remapShardIndex(1000, 32)).toBe(8); // 1000 % 32 = 8
    expect(remapShardIndex(999, 64)).toBe(39); // 999 % 64 = 39
  });

  it('should maintain distribution properties', () => {
    // When scaling down by half, each new shard should get codes from exactly 2 old shards
    const shardCount = 32;
    const oldShardCount = 64;

    // Check that old shards map to new shards correctly
    for (let oldShard = 0; oldShard < oldShardCount; oldShard++) {
      const newShard = remapShardIndex(oldShard, shardCount);
      expect(newShard).toBeGreaterThanOrEqual(0);
      expect(newShard).toBeLessThan(shardCount);

      // Verify the relationship: oldShard % shardCount === newShard
      expect(oldShard % shardCount).toBe(newShard);
    }
  });
});
