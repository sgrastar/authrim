import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';

const mockResolveTenantRuntimeProfilesFromEnv = vi.hoisted(() => vi.fn());

vi.mock('../../services/runtime-profile-resolver', () => ({
  resolveTenantRuntimeProfilesFromEnv: mockResolveTenantRuntimeProfilesFromEnv,
}));

import {
  createRuntimeLoggingPolicySnapshot,
  publishRuntimeLoggingPolicySnapshot,
} from '@authrim/ar-lib-logging/policies';
import { resolveTenantAuditRetentionFromEnv } from '../audit-log';

function env(get: (key: string) => Promise<string | null>): Env {
  return { AUTHRIM_CONFIG: { get: vi.fn(get) } } as unknown as Env;
}

describe('resolveTenantAuditRetentionFromEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTenantRuntimeProfilesFromEnv.mockResolvedValue({
      auditProfile: {
        id: 'builtin:audit:standard',
        kind: 'audit',
        primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
        archive: null,
        sinks: [],
      },
    });
  });

  it("uses the tenant's PII config when the profile sets no retention", async () => {
    const retention = await resolveTenantAuditRetentionFromEnv(
      env(async (key) =>
        key === 'pii_config:tenant-a'
          ? JSON.stringify({ eventLogRetentionDays: 30, piiLogRetentionDays: 700 })
          : null
      ),
      'tenant-a'
    );
    expect(retention).toEqual({
      event: { days: 30, source: 'pii_config', variesByRoute: false, archived: false },
      pii: { days: 700, source: 'pii_config', variesByRoute: false, archived: false },
    });
  });

  it('uses the built-in defaults when the tenant has no PII config', async () => {
    const retention = await resolveTenantAuditRetentionFromEnv(
      env(async () => null),
      'tenant-a'
    );
    expect(retention).toEqual({
      event: { days: 90, source: 'pii_config', variesByRoute: false, archived: false },
      pii: { days: 365, source: 'pii_config', variesByRoute: false, archived: false },
    });
  });

  it('throws when the PII config or the profile cannot be read, instead of defaulting', async () => {
    await expect(
      resolveTenantAuditRetentionFromEnv(
        env(async () => {
          throw new Error('kv_unavailable');
        }),
        'tenant-a'
      )
    ).rejects.toThrow('kv_unavailable');

    await expect(
      resolveTenantAuditRetentionFromEnv(
        env(async (key) => {
          if (key === 'audit_routing_rules') throw new Error('rules_unavailable');
          return null;
        }),
        'tenant-a'
      )
    ).rejects.toThrow('rules_unavailable');

    // Stored rules that do not parse (an empty string included) are unreadable, not none.
    for (const stored of ['', '{broken', '{}']) {
      await expect(
        resolveTenantAuditRetentionFromEnv(
          env(async (key) => (key === 'audit_routing_rules' ? stored : null)),
          'tenant-a'
        )
      ).rejects.toThrow();
    }

    // A published logging policy whose body cannot be read: unknown, not absent.
    await expect(
      resolveTenantAuditRetentionFromEnv(
        env(async (key) =>
          key === 'logging-policy-snapshots/v1/current/tenant/tenant-a.json' ? '{not json' : null
        ),
        'tenant-a'
      )
    ).rejects.toThrow('logging_policy_snapshot_unreadable');

    // A stored PII config that cannot be parsed is unreadable, not absent.
    for (const stored of ['{broken', '', '[]']) {
      await expect(
        resolveTenantAuditRetentionFromEnv(
          env(async (key) => (key === 'pii_config:tenant-a' ? stored : null)),
          'tenant-a'
        )
      ).rejects.toThrow();
    }

    mockResolveTenantRuntimeProfilesFromEnv.mockRejectedValueOnce(new Error('profile_unavailable'));
    await expect(
      resolveTenantAuditRetentionFromEnv(
        env(async () => null),
        'tenant-a'
      )
    ).rejects.toThrow('profile_unavailable');
  });

  it('reads the profile strictly', async () => {
    await resolveTenantAuditRetentionFromEnv(
      env(async () => null),
      'tenant-a'
    );
    expect(mockResolveTenantRuntimeProfilesFromEnv).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      { strict: true }
    );
  });

  it('applies a routing rule for every write, and marks one for some routes as varying', async () => {
    const rule = (name: string, conditions: Record<string, unknown>, days: number) => ({
      name,
      priority: 1,
      enabled: true,
      conditions,
      targets: { archiveStores: ['r2-archive'] },
      retention: { eventLogRetentionDays: days },
    });
    const rules = [
      rule('tenant-wide', { tenantId: 'tenant-a', logType: 'event' }, 400),
      rule('payments-only', { tenantId: 'tenant-a', eventCategory: 'payment' }, 30),
      rule('other-tenant', { tenantId: 'tenant-b', clientId: 'app' }, 7),
    ];
    const retention = await resolveTenantAuditRetentionFromEnv(
      env(async (key) => (key === 'audit_routing_rules' ? JSON.stringify(rules) : null)),
      'tenant-a'
    );
    expect(retention.event).toEqual({
      days: 400,
      source: 'delivery_plan',
      variesByRoute: true,
      archived: false,
    });
    // No rule sets PII retention.
    expect(retention.pii).toEqual({
      days: 365,
      source: 'pii_config',
      variesByRoute: false,
      archived: false,
    });

    const otherTenant = await resolveTenantAuditRetentionFromEnv(
      env(async (key) => (key === 'audit_routing_rules' ? JSON.stringify([rules[2]]) : null)),
      'tenant-a'
    );
    expect(otherTenant.event).toEqual({
      days: 90,
      source: 'pii_config',
      variesByRoute: false,
      archived: false,
    });

    // A rule for all the tenant's writes is the value, not a variation.
    const tenantWide = await resolveTenantAuditRetentionFromEnv(
      env(async (key) => (key === 'audit_routing_rules' ? JSON.stringify([rules[0]]) : null)),
      'tenant-a'
    );
    expect(tenantWide.event).toEqual({
      days: 400,
      source: 'delivery_plan',
      variesByRoute: false,
      archived: false,
    });

    // A rule for any region applies to writes (they carry none); one for a region never does.
    const anyRegion = await resolveTenantAuditRetentionFromEnv(
      env(async (key) =>
        key === 'audit_routing_rules'
          ? JSON.stringify([
              rule('app-any-region', { clientId: 'app', region: '*' }, 7),
              rule('eu-only', { region: 'eu' }, 3),
            ])
          : null
      ),
      'tenant-a'
    );
    expect(anyRegion.event).toEqual({
      days: 90,
      source: 'pii_config',
      variesByRoute: true,
      archived: false,
    });
  });

  it('says whether the logs are also copied to an archive, which Authrim does not delete', async () => {
    mockResolveTenantRuntimeProfilesFromEnv.mockResolvedValue({
      auditProfile: {
        id: 'builtin:audit:standard',
        kind: 'audit',
        primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
        archive: { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'logs/v1' },
        sinks: [],
      },
    });
    const retention = await resolveTenantAuditRetentionFromEnv(
      env(async () => null),
      'tenant-a'
    );
    expect(retention.event.archived).toBe(true);
    expect(retention.pii.archived).toBe(true);
  });

  it('counts the copy the cleanup makes before deleting as archived, with a published policy', async () => {
    // A published logging policy that sends audit logs to an external sink only.
    const values = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    };
    const objects = new Map<string, string>();
    const bucket = {
      put: vi.fn(async (key: string, value: string) => {
        objects.set(key, value);
      }),
      get: vi.fn(async (key: string) =>
        objects.has(key) ? { text: async () => objects.get(key) ?? '' } : null
      ),
    };
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      version: 1,
      snapshotId: 'snap_sink_only',
      synchronizedAt: 1_700_000_000_000,
      sourceUpdatedAt: 1_700_000_000_000,
      policies: {
        assignments: [
          {
            id: 'lpa_sink',
            tenant_id: null,
            log_type: 'audit',
            plane: 'external_sink',
            destination_id: 'dest_http',
            enabled: 1,
            managed_by: 'platform',
            lane: 'critical',
            version: 1,
          },
        ],
        fallbacks: [],
        destinations: [
          {
            id: 'dest_http',
            scope_type: 'shared',
            scope_id: null,
            destination_kind: 'http_sink',
            provider: 'http',
            name: 'collector',
            display_name: 'Collector',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({ url: 'https://collector.example/logs' }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['audit']),
            allowed_planes: JSON.stringify(['external_sink']),
            region: null,
            critical_allowed: 1,
            default_fallback_eligible: 0,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
        ],
      },
    });
    await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv,
      objectStore: bucket,
      now: 1_700_000_000_000,
    });
    const snapshotEnv = { AUTHRIM_CONFIG: kv, DIAGNOSTIC_LOGS: bucket } as unknown as Env;
    const profile = (archiveBeforeDelete: boolean) => ({
      auditProfile: {
        id: 'builtin:audit:standard',
        kind: 'audit',
        primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
        archive: { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'logs/v1' },
        sinks: [],
        retention: { archiveBeforeDelete },
      },
    });

    mockResolveTenantRuntimeProfilesFromEnv.mockResolvedValueOnce(profile(true));
    expect((await resolveTenantAuditRetentionFromEnv(snapshotEnv, 'tenant-a')).event.archived).toBe(
      true
    );
    mockResolveTenantRuntimeProfilesFromEnv.mockResolvedValueOnce(profile(false));
    expect((await resolveTenantAuditRetentionFromEnv(snapshotEnv, 'tenant-a')).event.archived).toBe(
      false
    );
  });
});
