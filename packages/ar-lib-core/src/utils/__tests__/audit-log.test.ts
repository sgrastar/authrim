import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../types/env';
import type { Context } from 'hono';
import {
  createRuntimeLoggingPolicySnapshot,
  publishRuntimeLoggingPolicySnapshot,
} from '@authrim/ar-lib-logging/policies';

// Mock logger - hoisted before other imports
const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
  module: vi.fn().mockReturnThis(),
  startTimer: vi.fn().mockReturnValue(() => {}),
}));

const mockUnifiedAuditService = vi.hoisted(() => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  logPIIChange: vi.fn().mockResolvedValue(undefined),
  logCombined: vi.fn().mockResolvedValue(undefined),
  purgeUserPII: vi.fn().mockResolvedValue(undefined),
}));

const mockCreateAuditService = vi.hoisted(() => vi.fn(() => mockUnifiedAuditService));
const mockResolveTenantRuntimeProfilesFromEnv = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    auditProfile: {
      id: 'builtin:audit:standard',
      kind: 'audit',
      builtin: true,
      label: 'Standard Audit',
      primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
      archive: null,
      sinks: [],
    },
  })
);

vi.mock('../logger', () => ({
  createLogger: () => mockLogger,
}));

vi.mock('../../services/audit', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/audit')>('../../services/audit');
  return {
    ...actual,
    createAuditService: mockCreateAuditService,
  };
});

vi.mock('../../services/runtime-profile-resolver', () => ({
  resolveTenantRuntimeProfilesFromEnv: mockResolveTenantRuntimeProfilesFromEnv,
}));

import { createAuditLog, createAuditLogFromContext } from '../audit-log';

/**
 * Audit Log Utility Tests
 *
 * Tests for audit log creation including:
 * - Successful log creation
 * - Error handling (non-blocking)
 * - Context extraction helper
 * - Critical severity logging
 */

/**
 * Create a mock D1 database
 */
function createMockDB(options: { shouldFail?: boolean } = {}) {
  const runMock = options.shouldFail
    ? vi.fn().mockRejectedValue(new Error('DB write failed'))
    : vi.fn().mockResolvedValue({ meta: { changes: 1 } });

  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      run: runMock,
    }),
    batch: vi.fn().mockResolvedValue([]),
  };
}

/**
 * Create a mock environment
 */
function createMockEnv(dbOptions: { shouldFail?: boolean } = {}): Env {
  const db = createMockDB(dbOptions) as unknown as D1Database;
  return {
    DB: db,
    DB_PII: db,
    ISSUER_URL: 'https://test.example.com',
  } as Env;
}

/**
 * Create a mock Hono context
 */
function createMockContext(options: {
  adminAuth?: { userId: string };
  tenantId?: string;
  requestId?: string;
  headers?: Record<string, string>;
  env?: Env;
}): Context<{ Bindings: Env }> {
  const headers = {
    'CF-Connecting-IP': '192.168.1.1',
    'User-Agent': 'Mozilla/5.0 Test Browser',
    ...options.headers,
  };

  return {
    env: options.env || createMockEnv(),
    req: {
      header: vi.fn((name: string) => headers[name] || null),
    },
    get: vi.fn((key: string) => {
      if (key === 'adminAuth') {
        return options.adminAuth || { userId: 'test-user' };
      }
      if (key === 'tenantId') {
        return options.tenantId || 'default';
      }
      if (key === 'requestId') {
        return options.requestId;
      }
      return undefined;
    }),
  } as unknown as Context<{ Bindings: Env }>;
}

describe('createAuditLog', () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTenantRuntimeProfilesFromEnv.mockResolvedValue({
      auditProfile: {
        id: 'builtin:audit:standard',
        kind: 'audit',
        builtin: true,
        label: 'Standard Audit',
        primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
        archive: null,
        sinks: [],
      },
    });
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create an audit log entry successfully', async () => {
    await createAuditLog(mockEnv, {
      tenantId: 'default',
      userId: 'user-123',
      action: 'signing_keys.rotate.normal',
      resource: 'signing_keys',
      resourceId: 'key-abc',
      ipAddress: '192.168.1.1',
      userAgent: 'Test Agent',
      metadata: '{"reason": "scheduled rotation"}',
      severity: 'warning',
    });

    expect(mockEnv.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_log')
    );
    expect(mockUnifiedAuditService.logEvent).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({
        eventType: 'signing_keys.rotate.normal',
        eventCategory: 'security',
        result: 'success',
      })
    );
  });

  it('should generate unique ID for each log entry', async () => {
    const bindCalls: unknown[][] = [];
    const mockDB = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          bindCalls.push(args);
          return { run: vi.fn().mockResolvedValue({}) };
        }),
      }),
      batch: vi.fn().mockResolvedValue([]),
    };
    const env = { ...mockEnv, DB: mockDB as unknown as D1Database };

    await createAuditLog(env, {
      tenantId: 'default',
      userId: 'user-1',
      action: 'test.action',
      resource: 'test',
      resourceId: 'id-1',
      ipAddress: '127.0.0.1',
      userAgent: 'Test',
      metadata: '{}',
      severity: 'info',
    });

    await createAuditLog(env, {
      tenantId: 'default',
      userId: 'user-2',
      action: 'test.action',
      resource: 'test',
      resourceId: 'id-2',
      ipAddress: '127.0.0.1',
      userAgent: 'Test',
      metadata: '{}',
      severity: 'info',
    });

    // First argument is the generated legacy audit_log ID.
    const id1 = bindCalls[0][0];
    const id2 = bindCalls[1][0];
    expect(id1).not.toBe(id2);
  });

  it('should continue when unified audit mirror fails', async () => {
    mockUnifiedAuditService.logEvent.mockRejectedValueOnce(new Error('mirror failed'));

    await expect(
      createAuditLog(mockEnv, {
        tenantId: 'default',
        userId: 'user-123',
        action: 'login.success',
        resource: 'test',
        resourceId: 'id-1',
        ipAddress: '127.0.0.1',
        userAgent: 'Test',
        metadata: '{}',
        severity: 'info',
      })
    ).resolves.not.toThrow();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to mirror audit log to unified audit service',
      expect.objectContaining({
        action: 'login.success',
        tenantId: 'default',
      })
    );
  });

  it('should skip legacy D1 audit_log when the resolved audit profile has no D1 primary', async () => {
    mockResolveTenantRuntimeProfilesFromEnv.mockResolvedValue({
      auditProfile: {
        id: 'builtin:audit:archive-only-logpush',
        kind: 'audit',
        builtin: true,
        label: 'Archive Only + Logpush',
        primary: null,
        archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
        sinks: [{ type: 'logpush', destinationRef: 'workers-logpush' }],
      },
    });

    await createAuditLog(mockEnv, {
      tenantId: 'default',
      userId: 'user-123',
      action: 'login.success',
      resource: 'auth',
      resourceId: 'session-1',
      ipAddress: '127.0.0.1',
      userAgent: 'Test',
      metadata: '{}',
      severity: 'info',
    });

    expect(mockEnv.DB.prepare).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_log')
    );
    expect(mockUnifiedAuditService.logEvent).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({
        eventType: 'login.success',
        eventCategory: 'auth',
      })
    );
  });

  it('uses cached runtime logging policy snapshots for audit fanout routing', async () => {
    const tenantId = 'tenant-snapshot-routing';
    const kvValues = new Map<string, string>();
    const objectValues = new Map<string, string>();
    const configKv = {
      get: vi.fn(async (key: string) => kvValues.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kvValues.set(key, value);
      }),
    } as unknown as KVNamespace;
    const snapshotBucket = {
      put: vi.fn(async (key: string, value: string) => {
        objectValues.set(key, value);
      }),
      get: vi.fn(async (key: string) =>
        objectValues.has(key)
          ? {
              text: vi.fn(async () => objectValues.get(key) ?? ''),
            }
          : null
      ),
    } as unknown as R2Bucket;
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: tenantId,
      version: 1,
      snapshotId: 'snap_test_audit_fanout',
      synchronizedAt: 1_700_000_000_000,
      sourceUpdatedAt: 1_700_000_000_000,
      policies: {
        assignments: [
          {
            id: 'lpa_archive',
            tenant_id: null,
            log_type: 'audit',
            plane: 'archive',
            destination_id: 'dest_archive',
            enabled: 1,
            managed_by: 'platform',
            lane: 'critical',
            version: 1,
          },
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
            id: 'dest_archive',
            scope_type: 'shared',
            scope_id: null,
            destination_kind: 'object_storage',
            provider: 'r2',
            name: 'archive',
            display_name: 'Archive',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({
              bindingRef: 'DIAGNOSTIC_LOGS',
              prefix: 'audit-chunks',
            }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['audit']),
            allowed_planes: JSON.stringify(['archive']),
            region: null,
            critical_allowed: 1,
            default_fallback_eligible: 1,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
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
            provider_config: JSON.stringify({
              url: 'https://collector.example/logs',
              headers: { 'X-Authrim-Route': 'snapshot' },
            }),
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
      kv: configKv,
      objectStore: snapshotBucket,
      now: 1_700_000_000_000,
    });
    vi.mocked(configKv.get).mockClear();
    vi.mocked(snapshotBucket.get).mockClear();

    const env = {
      ...mockEnv,
      AUTHRIM_CONFIG: configKv,
      DIAGNOSTIC_LOGS: snapshotBucket,
    };

    await createAuditLog(env, {
      tenantId,
      userId: 'user-123',
      action: 'login.success',
      resource: 'auth',
      resourceId: 'session-1',
      ipAddress: '127.0.0.1',
      userAgent: 'Test',
      metadata: '{}',
      severity: 'info',
    });

    const deps = mockCreateAuditService.mock.calls.at(-1)?.[0] as {
      resolveDeliveryPlan: (input: {
        tenantId: string;
        logType: 'event' | 'pii';
        auditProfile: {
          id: string;
          kind: 'audit';
          label: string;
          primary: { type: 'd1'; bindingRef: string; dataset: string };
          archive: null;
          sinks: [];
        };
      }) => Promise<{
        archives: Array<{
          type: string;
          destinationId?: string;
          bucketRef?: string;
          prefix?: string;
        }>;
        sinks: Array<{
          type: string;
          destinationId?: string;
          url?: string;
          headers?: Record<string, string>;
        }>;
        matchedRuleNames?: string[];
      }>;
    };
    const input = {
      tenantId,
      logType: 'event' as const,
      auditProfile: {
        id: 'builtin:audit:standard',
        kind: 'audit' as const,
        label: 'Standard Audit',
        primary: { type: 'd1' as const, bindingRef: 'DB', dataset: 'event_log' },
        archive: null,
        sinks: [],
      },
    };
    const firstPlan = await deps.resolveDeliveryPlan(input);
    const secondPlan = await deps.resolveDeliveryPlan(input);

    expect(firstPlan.archives[0]).toMatchObject({
      type: 'r2',
      destinationId: 'dest_archive',
      bucketRef: 'DIAGNOSTIC_LOGS',
      prefix: 'audit-chunks',
    });
    expect(firstPlan.sinks[0]).toMatchObject({
      type: 'http',
      destinationId: 'dest_http',
      url: 'https://collector.example/logs',
      headers: { 'X-Authrim-Route': 'snapshot' },
    });
    expect(firstPlan.matchedRuleNames).toEqual(['logging_policy_snapshot']);
    expect(secondPlan).toEqual(firstPlan);
    expect(configKv.get).toHaveBeenCalledTimes(1);
    expect(snapshotBucket.get).toHaveBeenCalledTimes(1);
  });

  it('falls back to the platform runtime logging policy snapshot when tenant snapshot is absent', async () => {
    const tenantId = 'tenant-platform-fallback-routing';
    const kvValues = new Map<string, string>();
    const objectValues = new Map<string, string>();
    const configKv = {
      get: vi.fn(async (key: string) => kvValues.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kvValues.set(key, value);
      }),
    } as unknown as KVNamespace;
    const snapshotBucket = {
      put: vi.fn(async (key: string, value: string) => {
        objectValues.set(key, value);
      }),
      get: vi.fn(async (key: string) =>
        objectValues.has(key)
          ? {
              text: vi.fn(async () => objectValues.get(key) ?? ''),
            }
          : null
      ),
    } as unknown as R2Bucket;
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'platform',
      scopeId: 'global',
      version: 1,
      snapshotId: 'snap_test_platform_audit_fallback',
      synchronizedAt: 1_700_000_000_000,
      sourceUpdatedAt: 1_700_000_000_000,
      policies: {
        assignments: [
          {
            id: 'lpa_platform_archive',
            tenant_id: null,
            log_type: 'audit',
            plane: 'archive',
            destination_id: 'dest_platform_archive',
            enabled: 1,
            managed_by: 'platform',
            lane: 'critical',
            version: 1,
          },
        ],
        fallbacks: [],
        destinations: [
          {
            id: 'dest_platform_archive',
            scope_type: 'platform',
            scope_id: 'global',
            destination_kind: 'object_storage',
            provider: 'r2',
            name: 'platform-archive',
            display_name: 'Platform Archive',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({
              bindingRef: 'DIAGNOSTIC_LOGS',
              prefix: 'platform-audit-chunks',
            }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['audit']),
            allowed_planes: JSON.stringify(['archive']),
            region: null,
            critical_allowed: 1,
            default_fallback_eligible: 1,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
        ],
      },
    });
    await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv: configKv,
      objectStore: snapshotBucket,
      now: 1_700_000_000_000,
    });
    vi.mocked(configKv.get).mockClear();
    vi.mocked(snapshotBucket.get).mockClear();

    const env = {
      ...mockEnv,
      AUTHRIM_CONFIG: configKv,
      DIAGNOSTIC_LOGS: snapshotBucket,
    };

    await createAuditLog(env, {
      tenantId,
      userId: 'user-123',
      action: 'login.success',
      resource: 'auth',
      resourceId: 'session-1',
      ipAddress: '127.0.0.1',
      userAgent: 'Test',
      metadata: '{}',
      severity: 'info',
    });

    const deps = mockCreateAuditService.mock.calls.at(-1)?.[0] as {
      resolveDeliveryPlan: (input: {
        tenantId: string;
        logType: 'event' | 'pii';
        auditProfile: {
          id: string;
          kind: 'audit';
          label: string;
          primary: { type: 'd1'; bindingRef: string; dataset: string };
          archive: null;
          sinks: [];
        };
      }) => Promise<{
        archives: Array<{
          type: string;
          destinationId?: string;
          bucketRef?: string;
          prefix?: string;
        }>;
        sinks: Array<{ type: string; destinationId?: string }>;
        matchedRuleNames?: string[];
      }>;
    };
    const input = {
      tenantId,
      logType: 'event' as const,
      auditProfile: {
        id: 'builtin:audit:standard',
        kind: 'audit' as const,
        label: 'Standard Audit',
        primary: { type: 'd1' as const, bindingRef: 'DB', dataset: 'event_log' },
        archive: null,
        sinks: [],
      },
    };
    const plan = await deps.resolveDeliveryPlan(input);
    const cachedPlan = await deps.resolveDeliveryPlan(input);

    expect(plan.archives[0]).toMatchObject({
      type: 'r2',
      destinationId: 'dest_platform_archive',
      bucketRef: 'DIAGNOSTIC_LOGS',
      prefix: 'platform-audit-chunks',
    });
    expect(plan.sinks).toEqual([]);
    expect(plan.matchedRuleNames).toEqual(['logging_policy_snapshot']);
    expect(cachedPlan).toEqual(plan);
    expect(configKv.get).toHaveBeenCalledTimes(2);
    expect(snapshotBucket.get).toHaveBeenCalledTimes(1);
  });

  it('should log critical operations to console (PII-safe)', async () => {
    await createAuditLog(mockEnv, {
      tenantId: 'default',
      userId: 'admin-user',
      action: 'signing_keys.rotate.emergency',
      resource: 'signing_keys',
      resourceId: 'key-compromised',
      ipAddress: '10.0.0.1',
      userAgent: 'Admin Tool',
      metadata: '{"reason": "key compromise detected"}',
      severity: 'critical',
    });

    // PII Protection: userId and metadata are intentionally omitted from console output
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'CRITICAL AUDIT',
      expect.objectContaining({
        action: 'signing_keys.rotate.emergency',
        resource: 'signing_keys',
        resourceId: 'key-compromised',
      })
    );
    // Verify userId is NOT in the output (PII protection)
    const loggedObject = mockLogger.warn.mock.calls[0][1];
    expect(loggedObject.userId).toBeUndefined();
    expect(loggedObject.metadata).toBeUndefined();
  });

  it('should not log to console for non-critical operations', async () => {
    await createAuditLog(mockEnv, {
      tenantId: 'default',
      userId: 'user-123',
      action: 'signing_keys.status.read',
      resource: 'signing_keys',
      resourceId: 'key-123',
      ipAddress: '192.168.1.1',
      userAgent: 'Browser',
      metadata: '{}',
      severity: 'info',
    });

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  describe('Error Handling (Non-blocking)', () => {
    it('should not throw when fail-open DB write fails', async () => {
      const failingEnv = createMockEnv({ shouldFail: true });

      // Should not throw
      await expect(
        createAuditLog(failingEnv, {
          tenantId: 'default',
          userId: 'user-123',
          action: 'login.success',
          resource: 'test',
          resourceId: 'id-1',
          ipAddress: '127.0.0.1',
          userAgent: 'Test',
          metadata: '{}',
          severity: 'info',
        })
      ).resolves.not.toThrow();

      // Should log the error (PII-safe: only error name, not full error or audit data)
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to create audit log',
        {},
        expect.any(Error)
      );
    });

    it('should NOT log the audit data when DB fails (PII protection)', async () => {
      const failingEnv = createMockEnv({ shouldFail: true });

      const auditData = {
        tenantId: 'default',
        userId: 'user-123',
        action: 'login.success',
        resource: 'critical-resource',
        resourceId: 'id-xyz',
        ipAddress: '192.168.1.100',
        userAgent: 'Test Agent',
        metadata: '{"important": "data"}',
        severity: 'warning' as const,
      };

      await createAuditLog(failingEnv, auditData);

      // PII Protection: Audit data should NOT be logged (may contain PII in metadata)
      // Only the sanitized error message should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to create audit log',
        {},
        expect.any(Error)
      );
      // Verify audit data is NOT logged (old behavior would log the full entry)
      const allCalls = mockLogger.error.mock.calls;
      const hasAuditDataCall = allCalls.some(
        (call) =>
          call[0] === 'Audit log data:' ||
          (call[1] && typeof call[1] === 'object' && (call[1] as { userId?: string }).userId)
      );
      expect(hasAuditDataCall).toBe(false);
    });

    it('should throw when a fail-closed DB write fails', async () => {
      const failingEnv = createMockEnv({ shouldFail: true });

      await expect(
        createAuditLog(failingEnv, {
          tenantId: 'default',
          userId: 'admin-123',
          action: 'signing_keys.rotate.emergency',
          resource: 'signing_keys',
          resourceId: 'key-1',
          ipAddress: '127.0.0.1',
          userAgent: 'Test',
          metadata: '{}',
          severity: 'critical',
        })
      ).rejects.toThrow('audit_log_write_failed');
    });
  });
});

describe('createAuditLogFromContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should extract user info from adminAuth context', async () => {
    const mockEnv = createMockEnv();
    const context = createMockContext({
      adminAuth: { userId: 'admin-user-456' },
      env: mockEnv,
    });

    await createAuditLogFromContext(
      context,
      'signing_keys.rotate.normal',
      'signing_keys',
      'key-123',
      { reason: 'test rotation' },
      'warning'
    );

    const bindCall = (mockEnv.DB.prepare as ReturnType<typeof vi.fn>).mock.results[0].value.bind;
    expect(bindCall).toHaveBeenCalledWith(
      expect.any(String), // id
      'default', // tenantId
      'admin-user-456', // userId
      'signing_keys.rotate.normal',
      'signing_keys',
      'key-123',
      '192.168.1.1',
      'Mozilla/5.0 Test Browser',
      '{"reason":"test rotation"}',
      'warning',
      expect.any(Number) // createdAt
    );
  });

  it('should extract IP from CF-Connecting-IP header', async () => {
    const mockEnv = createMockEnv();
    const context = createMockContext({
      adminAuth: { userId: 'user-1' },
      headers: { 'CF-Connecting-IP': '203.0.113.50' },
      env: mockEnv,
    });

    await createAuditLogFromContext(context, 'test.action', 'resource', 'id-1', {}, 'info');

    const bindCall = (mockEnv.DB.prepare as ReturnType<typeof vi.fn>).mock.results[0].value.bind;
    expect(bindCall).toHaveBeenCalledWith(
      expect.any(String), // id
      expect.any(String), // tenantId
      expect.any(String), // userId
      expect.any(String), // action
      expect.any(String), // resource
      expect.any(String), // resourceId
      '203.0.113.50', // IP from CF header
      expect.any(String), // userAgent
      expect.any(String), // metadata
      expect.any(String), // severity
      expect.any(Number) // createdAt
    );
  });

  it('should fallback to X-Forwarded-For when CF header is missing', async () => {
    const mockEnv = createMockEnv();
    const mockContext = {
      env: mockEnv,
      req: {
        header: vi.fn((name: string) => {
          if (name === 'X-Forwarded-For') return '10.0.0.1, 192.168.1.1';
          if (name === 'User-Agent') return 'Test Agent';
          return null;
        }),
      },
      get: vi.fn((key: string) => {
        if (key === 'adminAuth') return { userId: 'user-1' };
        if (key === 'tenantId') return 'default';
        return undefined;
      }),
    } as unknown as Context<{ Bindings: Env }>;

    await createAuditLogFromContext(mockContext, 'login.success', 'resource', 'id-1', {}, 'info');

    const bindCall = (mockEnv.DB.prepare as ReturnType<typeof vi.fn>).mock.results[0].value.bind;
    // Should use first IP from X-Forwarded-For
    expect(bindCall).toHaveBeenCalledWith(
      expect.any(String), // id
      expect.any(String), // tenantId
      expect.any(String), // userId
      expect.any(String), // action
      expect.any(String), // resource
      expect.any(String), // resourceId
      '10.0.0.1', // First IP from X-Forwarded-For
      expect.any(String), // userAgent
      expect.any(String), // metadata
      expect.any(String), // severity
      expect.any(Number) // createdAt
    );
  });

  it('should use "unknown" when no IP headers are present', async () => {
    const mockEnv = createMockEnv();
    const mockContext = {
      env: mockEnv,
      req: {
        header: vi.fn(() => null),
      },
      get: vi.fn((key: string) => {
        if (key === 'adminAuth') return { userId: 'user-1' };
        if (key === 'tenantId') return 'default';
        return undefined;
      }),
    } as unknown as Context<{ Bindings: Env }>;

    await createAuditLogFromContext(mockContext, 'login.success', 'resource', 'id-1', {}, 'info');

    const bindCall = (mockEnv.DB.prepare as ReturnType<typeof vi.fn>).mock.results[0].value.bind;
    expect(bindCall).toHaveBeenCalledWith(
      expect.any(String), // id
      expect.any(String), // tenantId
      expect.any(String), // userId
      expect.any(String), // action
      expect.any(String), // resource
      expect.any(String), // resourceId
      'unknown', // Fallback IP
      'unknown', // Fallback User-Agent
      expect.any(String), // metadata
      expect.any(String), // severity
      expect.any(Number) // createdAt
    );
  });

  it('should stringify metadata object', async () => {
    const mockEnv = createMockEnv();
    const context = createMockContext({
      adminAuth: { userId: 'user-1' },
      env: mockEnv,
    });

    const metadata = {
      oldKid: 'key-old',
      newKid: 'key-new',
      reason: 'Key compromise',
      timestamp: 1234567890,
    };

    await createAuditLogFromContext(
      context,
      'signing_keys.rotate.emergency',
      'signing_keys',
      'key-new',
      metadata,
      'critical'
    );

    const bindCall = (mockEnv.DB.prepare as ReturnType<typeof vi.fn>).mock.results[0].value.bind;
    expect(bindCall).toHaveBeenCalledWith(
      expect.any(String), // id
      expect.any(String), // tenantId
      expect.any(String), // userId
      expect.any(String), // action
      expect.any(String), // resource
      expect.any(String), // resourceId
      expect.any(String), // ipAddress
      expect.any(String), // userAgent
      JSON.stringify(metadata), // Metadata should be stringified
      expect.any(String), // severity
      expect.any(Number) // createdAt
    );
  });

  it('should include request and Admin UI BFF metadata in legacy audit metadata', async () => {
    const mockEnv = createMockEnv();
    const context = createMockContext({
      adminAuth: { userId: 'user-1' },
      requestId: 'ctx-req-1',
      headers: {
        'X-Request-Id': 'bff-req-1',
        'X-Correlation-Id': 'corr-1',
        'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
        'X-Authrim-Forwarded-Host': 'api.authrim.example',
        'X-Forwarded-Proto': 'https',
      },
      env: mockEnv,
    });

    await createAuditLogFromContext(
      context,
      'test.action',
      'resource',
      'id-1',
      { admin_ui_api_mode: 'spoofed', reason: 'test' },
      'info'
    );

    const bindCall = (mockEnv.DB.prepare as ReturnType<typeof vi.fn>).mock.results[0].value.bind;
    const metadataJson = bindCall.mock.calls[0][8] as string;
    expect(JSON.parse(metadataJson)).toEqual({
      reason: 'test',
      request_id: 'ctx-req-1',
      admin_ui_api_mode: 'cross-site-proxy-bff',
      admin_ui_bff_forwarded_host: 'api.authrim.example',
      admin_ui_bff_forwarded_proto: 'https',
      admin_ui_bff_request_id: 'bff-req-1',
      admin_ui_bff_correlation_id: 'corr-1',
    });
  });

  it('should not create log when adminAuth context is missing', async () => {
    const mockEnv = createMockEnv();
    const mockContext = {
      env: mockEnv,
      req: {
        header: vi.fn(() => null),
      },
      get: vi.fn(() => undefined), // No adminAuth
    } as unknown as Context<{ Bindings: Env }>;

    await createAuditLogFromContext(mockContext, 'login.success', 'resource', 'id-1', {}, 'info');

    // Should log error and not call DB
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Cannot create audit log: adminAuth context not found',
      { action: 'login.success', resource: 'resource', resourceId: 'id-1' }
    );
    expect(mockEnv.DB.prepare).not.toHaveBeenCalled();
  });

  it('should default severity to info when not specified', async () => {
    const mockEnv = createMockEnv();
    const context = createMockContext({
      adminAuth: { userId: 'user-1' },
      env: mockEnv,
    });

    await createAuditLogFromContext(
      context,
      'test.action',
      'resource',
      'id-1',
      {}
      // severity not specified
    );

    const bindCall = (mockEnv.DB.prepare as ReturnType<typeof vi.fn>).mock.results[0].value.bind;
    expect(bindCall).toHaveBeenCalledWith(
      expect.any(String), // id
      expect.any(String), // tenantId
      expect.any(String), // userId
      expect.any(String), // action
      expect.any(String), // resource
      expect.any(String), // resourceId
      expect.any(String), // ipAddress
      expect.any(String), // userAgent
      expect.any(String), // metadata
      'info', // Default severity
      expect.any(Number) // createdAt
    );
  });
});
