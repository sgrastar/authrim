import { describe, expect, it } from 'vitest';
import { resolveLocalUserScaleBenchmarkPlan } from '../core/local-user-scale-benchmark';

describe('resolveLocalUserScaleBenchmarkPlan', () => {
  it('uses a bounded Mac-local user-scale default', () => {
    expect(resolveLocalUserScaleBenchmarkPlan({})).toMatchObject({
      users: 100_000,
      tenantCount: 200,
      targetTenant: 'tenant-001',
      fresh: false,
      queryIterations: 10,
      scenario: 'mixed',
    });
  });

  it('accepts 1M shared and 1M single-tenant shapes', () => {
    expect(
      resolveLocalUserScaleBenchmarkPlan({
        users: 1_000_000,
        tenantCount: 200,
        scenario: 'admin-list',
      })
    ).toMatchObject({
      users: 1_000_000,
      tenantCount: 200,
      scenario: 'admin-list',
    });

    expect(
      resolveLocalUserScaleBenchmarkPlan({
        users: 1_000_000,
        tenantCount: 1,
        targetTenant: 'tenant-001',
        scenario: 'pii-search',
      })
    ).toMatchObject({
      users: 1_000_000,
      tenantCount: 1,
      scenario: 'pii-search',
    });
  });

  it('rejects unbounded or malformed local scale settings', () => {
    expect(() => resolveLocalUserScaleBenchmarkPlan({ users: 10_000_001 })).toThrow(
      'invalid_users'
    );
    expect(() => resolveLocalUserScaleBenchmarkPlan({ tenantCount: 10_001 })).toThrow(
      'invalid_tenant_count'
    );
    expect(() => resolveLocalUserScaleBenchmarkPlan({ queryIterations: 1_001 })).toThrow(
      'invalid_query_iterations'
    );
    expect(() => resolveLocalUserScaleBenchmarkPlan({ targetTenant: 'bad tenant' })).toThrow(
      'invalid_target_tenant'
    );
  });
});
