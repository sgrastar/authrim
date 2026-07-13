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
    for (const users of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveLocalUserScaleBenchmarkPlan({ users })).toThrow('invalid_users');
    }
    for (const tenantCount of [0, -1, 1.5]) {
      expect(() => resolveLocalUserScaleBenchmarkPlan({ tenantCount })).toThrow(
        'invalid_tenant_count'
      );
    }
    for (const queryIterations of [0, -1, 1.5]) {
      expect(() => resolveLocalUserScaleBenchmarkPlan({ queryIterations })).toThrow(
        'invalid_query_iterations'
      );
    }
    expect(() => resolveLocalUserScaleBenchmarkPlan({ scenario: 'unknown' as never })).toThrow(
      'invalid_local_user_scale_scenario:unknown'
    );
    expect(() => resolveLocalUserScaleBenchmarkPlan({ targetTenant: '-tenant' })).toThrow(
      'invalid_target_tenant'
    );
    expect(() => resolveLocalUserScaleBenchmarkPlan({ targetTenant: 'a'.repeat(64) })).toThrow(
      'invalid_target_tenant'
    );
  });

  it('preserves explicit setup targeting and local execution options', () => {
    expect(
      resolveLocalUserScaleBenchmarkPlan({
        env: 'prod',
        baseDir: '/repo',
        configPath: '/repo/.authrim/prod/config.json',
        users: 50,
        tenantCount: 2,
        targetTenant: 'tenant-custom',
        dbPath: './benchmark.sqlite',
        fresh: true,
        queryIterations: 3,
        scenario: 'domain-lookup',
      })
    ).toMatchObject({
      env: 'prod',
      baseDir: '/repo',
      configPath: '/repo/.authrim/prod/config.json',
      users: 50,
      tenantCount: 2,
      targetTenant: 'tenant-custom',
      fresh: true,
      queryIterations: 3,
      scenario: 'domain-lookup',
    });
  });
});
