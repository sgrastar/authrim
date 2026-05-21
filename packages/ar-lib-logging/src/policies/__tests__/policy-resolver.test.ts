import { describe, expect, it } from 'vitest';
import type { LoggingDestination } from '../../destinations';
import {
  RuntimeLoggingPolicySnapshotMemoryCache,
  buildRuntimeLoggingPolicySnapshotObjectKey,
  buildRuntimeLoggingPolicySnapshotPointerKey,
  createRuntimeLoggingPolicySnapshot,
  loadPublishedRuntimeLoggingPolicySnapshot,
  publishRuntimeLoggingPolicySnapshot,
  resolveLoggingPolicy,
  stablePolicyJson,
  type LoggingFallbackPolicy,
  type LoggingPolicyAssignment,
} from '../index';

function destination(overrides: Partial<LoggingDestination> = {}): LoggingDestination {
  return {
    id: 'dest_platform',
    scopeType: 'shared',
    scopeId: null,
    destinationKind: 'object_storage',
    provider: 'r2',
    name: 'platform-default',
    displayName: 'Platform Default',
    lifecycleStatus: 'active',
    healthStatus: 'healthy',
    providerConfig: { bindingRef: 'AUDIT_ARCHIVE' },
    capabilityPolicy: {
      allowedTenantIds: ['tenant-a'],
      allowedLogTypes: ['audit', 'webhook'],
      allowedPlanes: ['archive'],
      criticalAllowed: true,
      defaultFallbackEligible: true,
    },
    ...overrides,
  };
}

describe('resolveLoggingPolicy', () => {
  it('prefers tenant assignment over platform assignment for allowed non-critical logs', () => {
    const assignments: LoggingPolicyAssignment[] = [
      {
        id: 'assign_platform',
        tenantId: null,
        logType: 'webhook',
        plane: 'archive',
        destinationId: 'dest_platform',
        enabled: true,
        managedBy: 'platform',
        lane: 'default',
        version: 1,
      },
      {
        id: 'assign_tenant',
        tenantId: 'tenant-a',
        logType: 'webhook',
        plane: 'archive',
        destinationId: 'dest_tenant',
        enabled: true,
        managedBy: 'tenant',
        lane: 'default',
        version: 1,
      },
    ];

    const resolved = resolveLoggingPolicy({
      tenantId: 'tenant-a',
      logType: 'webhook',
      plane: 'archive',
      assignments,
      fallbackPolicies: [],
      destinations: [
        destination(),
        destination({
          id: 'dest_tenant',
          scopeType: 'tenant',
          capabilityPolicy: {
            allowedTenantIds: ['tenant-a'],
            allowedLogTypes: ['webhook'],
            allowedPlanes: ['archive'],
            criticalAllowed: false,
            defaultFallbackEligible: false,
          },
        }),
      ],
    });

    expect(resolved).toMatchObject({
      destinationId: 'dest_tenant',
      source: 'tenant_assignment',
      lane: 'default',
      warnings: [],
    });
  });

  it('uses platform fallback when the selected destination is unavailable', () => {
    const fallbackPolicies: LoggingFallbackPolicy[] = [
      {
        id: 'fb_platform',
        scopeType: 'platform',
        scopeId: 'global',
        logType: 'audit',
        plane: 'archive',
        fallbackDestinationId: 'dest_platform',
        failureMode: 'platform_default',
        version: 1,
      },
    ];

    const resolved = resolveLoggingPolicy({
      tenantId: 'tenant-a',
      logType: 'audit',
      plane: 'archive',
      assignments: [
        {
          id: 'assign_bad',
          tenantId: 'tenant-a',
          logType: 'audit',
          plane: 'archive',
          destinationId: 'dest_bad',
          enabled: true,
          managedBy: 'tenant',
          lane: 'critical',
          version: 1,
        },
      ],
      fallbackPolicies,
      destinations: [
        destination(),
        destination({
          id: 'dest_bad',
          lifecycleStatus: 'disabled',
        }),
      ],
    });

    expect(resolved).toMatchObject({
      lane: 'critical',
      destinationId: null,
      fallbackDestinationId: 'dest_platform',
      warnings: ['destination_unusable'],
    });
  });

  it('prefers tenant fallback policy over platform fallback when no assignment matches', () => {
    const fallbackPolicies: LoggingFallbackPolicy[] = [
      {
        id: 'fb_platform',
        scopeType: 'platform',
        scopeId: 'global',
        logType: 'webhook',
        plane: 'archive',
        fallbackDestinationId: 'dest_platform',
        failureMode: 'platform_default',
        version: 1,
      },
      {
        id: 'fb_tenant',
        scopeType: 'tenant',
        scopeId: 'tenant-a',
        logType: 'webhook',
        plane: 'archive',
        fallbackDestinationId: 'dest_tenant_fallback',
        failureMode: 'retry_then_dlq',
        version: 1,
      },
    ];

    const resolved = resolveLoggingPolicy({
      tenantId: 'tenant-a',
      logType: 'webhook',
      plane: 'archive',
      assignments: [],
      fallbackPolicies,
      destinations: [
        destination(),
        destination({
          id: 'dest_tenant_fallback',
          scopeType: 'tenant',
          capabilityPolicy: {
            allowedTenantIds: ['tenant-a'],
            allowedLogTypes: ['webhook'],
            allowedPlanes: ['archive'],
            criticalAllowed: false,
            defaultFallbackEligible: true,
          },
        }),
      ],
    });

    expect(resolved).toMatchObject({
      source: 'none',
      destinationId: null,
      fallbackDestinationId: 'dest_tenant_fallback',
      failureMode: 'retry_then_dlq',
      warnings: [],
    });
  });

  it('does not select unusable fallback destinations', () => {
    const fallbackPolicies: LoggingFallbackPolicy[] = [
      {
        id: 'fb_platform',
        scopeType: 'platform',
        scopeId: 'global',
        logType: 'audit',
        plane: 'archive',
        fallbackDestinationId: 'dest_no_critical',
        failureMode: 'platform_default',
        version: 1,
      },
    ];

    const resolved = resolveLoggingPolicy({
      tenantId: 'tenant-a',
      logType: 'audit',
      plane: 'archive',
      assignments: [],
      fallbackPolicies,
      destinations: [
        destination({
          id: 'dest_no_critical',
          capabilityPolicy: {
            allowedTenantIds: ['tenant-a'],
            allowedLogTypes: ['audit'],
            allowedPlanes: ['archive'],
            criticalAllowed: false,
            defaultFallbackEligible: true,
          },
        }),
      ],
    });

    expect(resolved).toMatchObject({
      lane: 'critical',
      destinationId: null,
      fallbackDestinationId: null,
      warnings: ['fallback_destination_unusable'],
    });
  });

  it('creates stable runtime policy snapshots with canonical hashes', async () => {
    const first = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      version: 2,
      synchronizedAt: 1714550400000,
      sourceUpdatedAt: 1714550399000,
      snapshotId: 'snap_test',
      policies: {
        b: 2,
        a: { z: true, y: false },
      },
    });
    const second = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      version: 2,
      synchronizedAt: 1714550400000,
      sourceUpdatedAt: 1714550399000,
      snapshotId: 'snap_test',
      policies: {
        a: { y: false, z: true },
        b: 2,
      },
    });

    expect(stablePolicyJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(first.policyHash).toBe(second.policyHash);
    expect(first).toMatchObject({
      snapshotId: 'snap_test',
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      version: 2,
    });
  });

  it('publishes runtime policy snapshots to object storage and KV pointer', async () => {
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      version: 3,
      synchronizedAt: 1714550400000,
      sourceUpdatedAt: 1714550399000,
      snapshotId: 'snap_test',
      policies: { assignments: [] },
    });
    const kvWrites: Array<{ key: string; value: string }> = [];
    const objectWrites: Array<{ key: string; value: string }> = [];

    const publication = await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      now: 1714550400000,
      kv: {
        put: async (key, value) => {
          kvWrites.push({ key, value });
        },
        get: async () => null,
      },
      objectStore: {
        put: async (key, value) => {
          objectWrites.push({ key, value });
        },
      },
    });

    expect(publication.objectRef).toBe(buildRuntimeLoggingPolicySnapshotObjectKey({ snapshot }));
    expect(publication.pointerKey).toBe(
      buildRuntimeLoggingPolicySnapshotPointerKey({
        scopeType: 'tenant',
        scopeId: 'tenant-a',
      })
    );
    expect(objectWrites).toHaveLength(1);
    expect(JSON.parse(objectWrites[0]!.value)).toMatchObject({
      snapshotId: 'snap_test',
      version: 3,
    });
    expect(kvWrites).toHaveLength(1);
    expect(JSON.parse(kvWrites[0]!.value)).toMatchObject({
      schemaVersion: 1,
      snapshotId: 'snap_test',
      version: 3,
      objectRef: publication.objectRef,
    });
  });

  it('coalesces runtime policy snapshot cache misses', async () => {
    const cache = new RuntimeLoggingPolicySnapshotMemoryCache<{ assignments: unknown[] }>({
      ttlMs: 1000,
    });
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      version: 1,
      synchronizedAt: 1714550400000,
      sourceUpdatedAt: 1714550399000,
      snapshotId: 'snap_cache',
      policies: { assignments: [] },
    });
    let loadCount = 0;
    const loader = async () => {
      loadCount += 1;
      await Promise.resolve();
      return snapshot;
    };

    const [first, second] = await Promise.all([
      cache.getOrLoad({ scopeType: 'tenant', scopeId: 'tenant-a', now: 1000, loader }),
      cache.getOrLoad({ scopeType: 'tenant', scopeId: 'tenant-a', now: 1000, loader }),
    ]);

    expect(first).toBe(snapshot);
    expect(second).toBe(snapshot);
    expect(loadCount).toBe(1);
    expect(
      cache.getCached({
        scopeType: 'tenant',
        scopeId: 'tenant-a',
        now: 1500,
        minVersion: 1,
      })
    ).toBe(snapshot);
    expect(
      cache.getCached({
        scopeType: 'tenant',
        scopeId: 'tenant-a',
        now: 2500,
      })
    ).toBeNull();
  });

  it('loads published snapshots through KV pointer and object store', async () => {
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      version: 4,
      synchronizedAt: 1714550400000,
      sourceUpdatedAt: 1714550399000,
      snapshotId: 'snap_load',
      policies: { assignments: [{ id: 'assign_1' }] },
    });
    const kvValues = new Map<string, string>();
    const objectValues = new Map<string, string>();

    await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv: {
        put: async (key, value) => {
          kvValues.set(key, value);
        },
        get: async (key) => kvValues.get(key) ?? null,
      },
      objectStore: {
        put: async (key, value) => {
          objectValues.set(key, value);
        },
        get: async (key) => {
          const value = objectValues.get(key);
          return value ? { text: async () => value } : null;
        },
      },
      now: 1714550400000,
    });

    const loaded = await loadPublishedRuntimeLoggingPolicySnapshot<{
      assignments: Array<{ id: string }>;
    }>({
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      kv: {
        put: async (key, value) => {
          kvValues.set(key, value);
        },
        get: async (key) => kvValues.get(key) ?? null,
      },
      objectStore: {
        put: async (key, value) => {
          objectValues.set(key, value);
        },
        get: async (key) => {
          const value = objectValues.get(key);
          return value ? { text: async () => value } : null;
        },
      },
    });

    expect(loaded).toMatchObject({
      snapshotId: 'snap_load',
      version: 4,
      policies: {
        assignments: [{ id: 'assign_1' }],
      },
    });
  });

  it('rejects oversized object-store runtime policy snapshots', async () => {
    const pointer = {
      snapshotId: 'snap_large',
      version: 1,
      policyHash: 'hash',
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      objectRef: 'r2://policy-snapshots/large.json',
      createdAt: 1714550400000,
    };

    const loaded = await loadPublishedRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      kv: {
        put: async () => {},
        get: async () => JSON.stringify(pointer),
      },
      objectStore: {
        put: async () => {},
        get: async () => ({
          size: 1024 * 1024 + 1,
          text: async () => '{}',
        }),
      },
    });

    expect(loaded).toBeNull();
  });
});
