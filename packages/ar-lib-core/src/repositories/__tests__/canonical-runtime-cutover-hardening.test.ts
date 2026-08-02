import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { canonicalProjectionToOIDCClaimsUser } from '../../utils/canonical-runtime-claims';
import {
  CanonicalIdentityRepository,
  CanonicalRuntimeUserProjectionRepository,
  CanonicalRuntimeUserWriter,
  CanonicalSensitiveValueResolver,
  type CanonicalRuntimeValueResolver,
} from '../identity';
import { MockDatabaseAdapter } from './mock-adapter';

const CANONICAL_TABLES = [
  'identity_subjects',
  'identity_accounts',
  'subject_account_links',
  'profiles',
  'profile_attribute_values',
  'structured_attribute_values',
  'contact_points',
  'contact_verifications',
  'identity_bindings',
  'identity_resolution_events',
  'identity_resolution_candidates',
  'assurance_evidence',
];

function createCanonicalAdapter(): MockDatabaseAdapter {
  const adapter = new MockDatabaseAdapter();
  for (const tableName of CANONICAL_TABLES) {
    adapter.initTable(tableName, 'id');
  }
  return adapter;
}

function percentile(values: number[], percentileRank: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileRank / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function activateDirectoryPublication(adapter: MockDatabaseAdapter, accountId: string): void {
  adapter.seed('identity_accounts', [
    {
      ...adapter.getById('identity_accounts', accountId),
      id: accountId,
      directory_publication_state: 'active',
    },
  ]);
}

describe('canonical runtime cutover hardening', () => {
  it('keeps SCIM/Admin writes and SAML/OIDC-style reads on the same canonical graph', async () => {
    const adapter = createCanonicalAdapter();
    const piiAdapter = new MockDatabaseAdapter();
    piiAdapter.initTable('identity_sensitive_values', 'id');
    const writer = new CanonicalRuntimeUserWriter(
      new CanonicalIdentityRepository(adapter, 'tenant-a'),
      piiAdapter
    );
    await writer.createFromRuntimeUser({
      userId: 'user-1',
      tenantId: 'tenant-a',
      active: true,
      emailVerified: true,
      phoneNumberVerified: false,
      userType: 'end_user',
      displayName: 'Example Person',
      locale: 'ja-JP',
      zoneinfo: 'Asia/Tokyo',
      sourceRef: 'scim:/Users',
      piiFields: {
        email: true,
        name: true,
        preferred_username: true,
      },
      sensitiveValues: {
        email: 'person@example.test',
        name: 'Example Person',
        preferred_username: 'person',
      },
    });
    activateDirectoryPublication(adapter, 'account:user-1');

    const valueResolver: CanonicalRuntimeValueResolver = {
      async resolveValue(valueStorageRef) {
        const values: Record<string, unknown> = {
          'canonical-sensitive://tenant-a/user-1/email': 'person@example.test',
          'canonical-sensitive://tenant-a/user-1/name': 'Example Person',
          'canonical-sensitive://tenant-a/user-1/preferred_username': 'person',
        };
        return values[valueStorageRef] ?? null;
      },
    };
    const projectionRepository = new CanonicalRuntimeUserProjectionRepository(
      adapter,
      'tenant-a',
      valueResolver
    );

    const projection = await projectionRepository.findByLegacyUserId('user-1');
    expect(projection).not.toBeNull();
    const claimsUser = canonicalProjectionToOIDCClaimsUser(projection!);

    expect(projection).toMatchObject({
      id: 'user-1',
      subject_id: 'subject:user-1',
      account_id: 'account:user-1',
      email: 'person@example.test',
      email_verified: 1,
      name: 'Example Person',
      preferred_username: 'person',
      active: 1,
    });
    expect(claimsUser).toMatchObject({
      email: 'person@example.test',
      email_verified: true,
      name: 'Example Person',
      preferred_username: 'person',
    });

    const queriedSql = adapter
      .getQueryLog()
      .map((entry) => entry.sql)
      .join('\n');
    expect(queriedSql).toContain('identity_accounts');
    expect(queriedSql).toContain('identity_subjects');
    expect(queriedSql).toContain('contact_points');
    expect(queriedSql).not.toMatch(/\busers_core\b/u);
    expect(queriedSql).not.toMatch(/\busers_pii\b/u);
  });

  it('rejects malformed or cross-tenant legacy PII refs before querying PII storage', async () => {
    const piiAdapter = new MockDatabaseAdapter();
    piiAdapter.initTable('identity_sensitive_values', 'id');
    piiAdapter.seed('identity_sensitive_values', [
      {
        id: 'sensitive-value:user-1:email',
        tenant_id: 'tenant-a',
        owner_type: 'runtime_user',
        owner_id: 'user-1',
        value_key: 'email',
        value_json: JSON.stringify('person@example.test'),
        lifecycle_state: 'active',
      },
    ]);
    const resolver = new CanonicalSensitiveValueResolver(piiAdapter);

    await expect(
      resolver.resolveValue('canonical-sensitive://tenant-a/user-1/email%2Cpassword_hash', {
        tenantId: 'tenant-a',
        subjectId: 'subject:user-1',
        accountId: 'account:user-1',
      })
    ).rejects.toThrow(/Unsupported canonical sensitive value ref field/);
    await expect(
      resolver.resolveValue('canonical-sensitive://tenant-b/user-1/email', {
        tenantId: 'tenant-a',
        subjectId: 'subject:user-1',
        accountId: 'account:user-1',
      })
    ).rejects.toThrow(/tenant mismatch/);

    expect(piiAdapter.getQueryLog()).toHaveLength(0);
  });

  it('reports a hot-path projection smoke budget for p95 latency and read-count', async () => {
    const adapter = createCanonicalAdapter();
    const piiAdapter = new MockDatabaseAdapter();
    piiAdapter.initTable('identity_sensitive_values', 'id');
    const writer = new CanonicalRuntimeUserWriter(
      new CanonicalIdentityRepository(adapter, 'tenant-a'),
      piiAdapter
    );
    await writer.createFromRuntimeUser({
      userId: 'user-1',
      tenantId: 'tenant-a',
      active: true,
      emailVerified: true,
      displayName: 'Example Person',
      locale: 'ja-JP',
      sourceRef: 'admin:/users',
      inlineProfileFields: {
        'field.canonical.name': 'Example Person',
        'field.canonical.preferred_username': 'person',
      },
    });
    activateDirectoryPublication(adapter, 'account:user-1');
    const projectionRepository = new CanonicalRuntimeUserProjectionRepository(adapter, 'tenant-a', {
      async resolveValue() {
        return null;
      },
    });

    const durationsMs: number[] = [];
    const readCounts: number[] = [];
    for (let index = 0; index < 50; index++) {
      const queryCountBefore = adapter.getQueryLog().length;
      const startedAt = performance.now();
      const projection = await projectionRepository.findByLegacyUserId('user-1');
      durationsMs.push(performance.now() - startedAt);
      readCounts.push(adapter.getQueryLog().length - queryCountBefore);
      expect(projection?.email).toBeNull();
      expect(projection?.name).toBe('Example Person');
    }

    const report = {
      iterations: durationsMs.length,
      p95Ms: percentile(durationsMs, 95),
      maxReadCount: Math.max(...readCounts),
    };
    console.info('canonical-runtime-hot-path-smoke', report);

    expect(report.maxReadCount).toBeLessThanOrEqual(6);
    expect(report.p95Ms).toBeLessThan(50);
  });
});
