import { describe, it, expect, vi } from 'vitest';
import {
  buildAuthCodeShardInstanceName,
  buildDOInstanceName,
  buildDOInstanceNameForTenant,
  buildDOKey,
  buildKVKey,
  buildKVKeyForTenant,
  buildSessionShardInstanceName,
  createShardedAuthCode,
  fnv1a32,
  getAuthCodeShardIndex,
  getSessionShardCount,
  getShardCount,
  getTenantId,
  getTenantIdFromHost,
  getTenantIdOrThrow,
  parseShardedAuthCode,
  remapShardIndex,
  resolveTenantFromRequest,
} from '../tenant-context';
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
        'https://test-ar-router.sgrastar.workers.dev/api/auth/authentication-methods',
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

    it('should reject generic X-Forwarded-Host when Host is workers.dev', () => {
      const request = new Request(
        'https://test-ar-router.sgrastar.workers.dev/api/auth/authentication-methods',
        {
          headers: {
            Host: 'test-ar-router.sgrastar.workers.dev',
            'X-Forwarded-Host': 'acme.test.authrim.com',
          },
        }
      );

      const result = resolveTenantFromRequest(request, multiTenantEnv);
      expect(result.success).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('should not let forwarded tenant host override an unrecognized Host', () => {
      const request = new Request(
        'https://test-ar-router.sgrastar.workers.dev/api/auth/authentication-methods',
        {
          headers: {
            Host: 'test-ar-router.sgrastar.workers.dev',
            'X-Authrim-Forwarded-Host': 'test.authrim.com',
            'X-Forwarded-Host': 'acme.test.authrim.com',
          },
        }
      );

      const result = resolveTenantFromRequest(request, multiTenantEnv);
      expect(result.success).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('should trust Authrim forwarded host when the worker is router-service-bound', () => {
      const request = new Request(
        'https://test-ar-auth.internal.cloudflare/authorize?client_id=test',
        {
          headers: {
            Host: 'test-ar-auth.internal.cloudflare',
            'X-Authrim-Forwarded-Host': 'first.test.authrim.com',
          },
        }
      );

      const result = resolveTenantFromRequest(request, {
        ...multiTenantEnv,
        AUTHRIM_TRUST_FORWARDED_HOST: 'true',
      });

      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('first');
    });

    it('should prefer trusted Authrim forwarded host over a service-binding host', () => {
      const request = new Request('https://test-ar-auth.sgrastar.workers.dev/authorize', {
        headers: {
          Host: 'test-ar-auth.sgrastar.workers.dev',
          'X-Authrim-Forwarded-Host': 'first.test.authrim.com',
        },
      });

      const result = resolveTenantFromRequest(request, {
        ...multiTenantEnv,
        AUTHRIM_TRUST_FORWARDED_HOST: 'yes',
      });

      expect(result.success).toBe(true);
      expect(result.tenantId).toBe('first');
    });

    it('should not let forwarded naked domain override an unrecognized Host', () => {
      const request = new Request(
        'https://test-ar-router.sgrastar.workers.dev/api/auth/authentication-methods',
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
      expect(result.success).toBe(false);
      expect(result.error).toBe('tenant_not_found');
    });

    it('should prefer Host when it already resolves to a tenant', () => {
      const request = new Request('https://acme.test.authrim.com/api/auth/authentication-methods', {
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

describe('tenant-prefixed storage keys', () => {
  it('builds unambiguous tenant-prefixed keys for every storage topology', () => {
    expect(getTenantId()).toBe('default');
    expect(buildDOKey('session', 's1', ' tenant-a ')).toBe('tenant:tenant-a:session:s1');
    expect(buildKVKey('client', 'c1', 'tenant-a')).toBe('tenant:tenant-a:client:c1');
    expect(buildDOInstanceName('key-manager', 'tenant-a')).toBe('tenant:tenant-a:key-manager');
    expect(buildDOInstanceNameForTenant('tenant-a', 'session')).toBe('tenant:tenant-a:session');
    expect(buildKVKeyForTenant('tenant-a', 'state', 'x')).toBe('tenant:tenant-a:state:x');
    expect(buildAuthCodeShardInstanceName(3, 'tenant-a')).toBe('tenant:tenant-a:auth-code:shard-3');
    expect(buildSessionShardInstanceName(2, 'tenant-a')).toBe('tenant:tenant-a:session:shard-2');
  });

  it.each([
    ['buildDOKey', () => buildDOKey('session', 's1', ' ')],
    ['buildKVKey', () => buildKVKey('state', 'x', '')],
    ['buildDOInstanceName', () => buildDOInstanceName('session', '\t')],
    ['buildDOInstanceNameForTenant', () => buildDOInstanceNameForTenant('', 'session')],
    ['buildKVKeyForTenant', () => buildKVKeyForTenant(' ', 'state', 'x')],
    ['buildAuthCodeShardInstanceName', () => buildAuthCodeShardInstanceName(0, '')],
    ['buildSessionShardInstanceName', () => buildSessionShardInstanceName(0, ' ')],
  ])('rejects an empty tenant in %s', (_label, operation) => {
    expect(operation).toThrow(/requires tenantId/);
  });
});

describe('tenant resolution failures', () => {
  const env: Partial<Env> = { BASE_DOMAIN: 'authrim.example', DEFAULT_TENANT_ID: 'fallback' };

  it.each([
    [undefined, 'Host header is required'],
    ['unknown.example', 'Tenant not found'],
  ])('throws a stable error for host %s', (host, message) => {
    expect(() => getTenantIdOrThrow(host, env)).toThrow(message);
  });

  it('returns a resolved tenant without modification', () => {
    expect(getTenantIdOrThrow('acme.authrim.example', env)).toBe('acme');
  });

  it('falls back to a valid Authrim forwarded host only when Host is missing', () => {
    const request = new Request('https://runtime.invalid/path', {
      headers: { 'X-Authrim-Forwarded-Host': 'acme.authrim.example' },
    });
    request.headers.delete('Host');

    const result = resolveTenantFromRequest(request, env);

    expect(result).toMatchObject({ success: true, tenantId: 'acme' });
  });

  it('ignores duplicate and empty forwarded host values', () => {
    const request = new Request('https://runtime.invalid/path', {
      headers: { Host: 'unknown.example', 'X-Authrim-Forwarded-Host': ' ,acme.authrim.example' },
    });

    const result = resolveTenantFromRequest(request, {
      ...env,
      AUTHRIM_TRUST_FORWARDED_HOST: 'true',
    });

    expect(result.success).toBe(false);
  });
});

describe('authorization-code sharding', () => {
  it('uses a deterministic unsigned FNV-1a hash and sticky shard', () => {
    expect(fnv1a32('hello')).toBe(1335831723);
    expect(getAuthCodeShardIndex('user-1', 'client-1', 16)).toBe(
      getAuthCodeShardIndex('user-1', 'client-1', 16)
    );
    expect(getAuthCodeShardIndex('user-1', 'client-1', 16)).toBeLessThan(16);
  });

  it.each([0, -1, 1.5])('rejects invalid shard count %s', (count) => {
    expect(() => getAuthCodeShardIndex('u', 'c', count)).toThrow('positive integer');
  });

  it('creates and strictly parses sharded authorization codes', () => {
    expect(createShardedAuthCode(3, 'opaque_value')).toBe('3_opaque_value');
    expect(parseShardedAuthCode('3_opaque_value')).toEqual({
      shardIndex: 3,
      opaqueCode: 'opaque_value',
    });
  });

  it.each(['legacy-code', '-1_token', '1junk_token', '1_', '_token'])(
    'rejects malformed sharded code %s',
    (code) => expect(parseShardedAuthCode(code)).toBeNull()
  );
});

describe('dynamic shard counts', () => {
  it('prefers valid KV values and caches them briefly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const get = vi.fn(async (key: string) => (key === 'code_shards' ? '32' : '16'));
    const env = { AUTHRIM_CONFIG: { get } } as unknown as Env;

    expect(await getShardCount(env)).toBe(32);
    expect(await getShardCount(env)).toBe(32);
    expect(await getSessionShardCount(env)).toBe(16);
    expect(await getSessionShardCount(env)).toBe(16);
    expect(get).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('refreshes after TTL and falls back through invalid KV to environment values', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:01:00Z'));
    const env = {
      AUTHRIM_CONFIG: { get: vi.fn(async () => 'invalid') },
      AUTHRIM_CODE_SHARDS: '8',
      AUTHRIM_SESSION_SHARDS: '12',
    } as unknown as Env;

    expect(await getShardCount(env)).toBe(8);
    expect(await getSessionShardCount(env)).toBe(12);
    vi.useRealTimers();
  });

  it('uses defaults when neither KV nor environment contains a positive count', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:02:00Z'));
    const env = {
      AUTHRIM_CONFIG: { get: vi.fn(async () => '-2') },
      AUTHRIM_CODE_SHARDS: '0',
      AUTHRIM_SESSION_SHARDS: 'NaN',
    } as unknown as Env;

    expect(await getShardCount(env)).toBe(4);
    expect(await getSessionShardCount(env)).toBe(4);
    vi.useRealTimers();
  });
});
