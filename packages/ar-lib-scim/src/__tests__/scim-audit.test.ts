import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { SCIM_EVENTS } from '@authrim/ar-lib-core/types/events/event-types';

// Mock createAuditLog before importing scim-audit
const mockCreateAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock('@authrim/ar-lib-core', () => ({
  createAuditLog: (...args: unknown[]) => mockCreateAuditLog(...args),
  DEFAULT_TENANT_ID: 'default',
}));

import { createScimAuditLog, logScimAudit, type ScimAuditAction } from '../utils/scim-audit';

/**
 * SCIM Audit Log Utility Tests
 *
 * Tests for SCIM-specific audit log creation including:
 * - Successful log creation with M2M identifier
 * - IP address extraction (CF-Connecting-IP, X-Forwarded-For, X-Real-IP)
 * - User-Agent extraction
 * - TenantId extraction from context
 * - Non-blocking error handling (logScimAudit wrapper)
 */

/**
 * Create a mock Hono context for SCIM operations
 */
function createMockContext(options: {
  tenantId?: string | null;
  headers?: Record<string, string | undefined>;
}): Context<{ Bindings: Env }> {
  const headers = {
    'CF-Connecting-IP': '192.168.1.1',
    'User-Agent': 'Okta SCIM Client/2.0',
    ...options.headers,
  };

  const mockEnv = {
    DB: {} as D1Database,
    ISSUER_URL: 'https://test.example.com',
  } as Env;

  return {
    env: mockEnv,
    req: {
      header: vi.fn((name: string) => headers[name] ?? null),
    },
    get: vi.fn((key: string) => {
      if (key === 'tenantId') {
        return options.tenantId === null ? undefined : (options.tenantId ?? 'tenant-a');
      }
      return undefined;
    }),
  } as unknown as Context<{ Bindings: Env }>;
}

describe('createScimAuditLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps emitted SCIM audit actions aligned with event constants', () => {
    const emittedActions: ScimAuditAction[] = [
      'scim.user.create',
      'scim.user.replace',
      'scim.user.patch',
      'scim.user.delete',
      'scim.group.create',
      'scim.group.replace',
      'scim.group.patch',
      'scim.group.delete',
      'scim.bulk.execute',
      'scim.token.create',
      'scim.token.revoke',
    ];

    expect(new Set(Object.values(SCIM_EVENTS))).toEqual(new Set(emittedActions));
  });

  it('should create an audit log with scim-service as userId (M2M identifier)', async () => {
    const context = createMockContext({});

    await createScimAuditLog(context, 'scim.user.create', 'scim_user', 'user-123', {
      externalId: 'ext-user-123',
    });

    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      context.env,
      expect.objectContaining({
        userId: 'scim-service', // M2M operation identifier
        action: 'scim.user.create',
        resource: 'scim_user',
        resourceId: 'user-123',
        severity: 'info',
      })
    );
  });

  it('should extract tenantId from context when available', async () => {
    const context = createMockContext({ tenantId: 'tenant-abc' });

    await createScimAuditLog(context, 'scim.group.create', 'scim_group', 'group-456', {});

    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      context.env,
      expect.objectContaining({
        tenantId: 'tenant-abc',
      })
    );
  });

  it('should skip audit logging when tenantId is not in context', async () => {
    const context = createMockContext({ tenantId: null });

    await createScimAuditLog(context, 'scim.user.delete', 'scim_user', 'user-789', {});

    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  describe('IP Address Extraction', () => {
    it('should extract IP from CF-Connecting-IP header (Cloudflare)', async () => {
      const context = createMockContext({
        headers: { 'CF-Connecting-IP': '203.0.113.50' },
      });

      await createScimAuditLog(context, 'scim.user.create', 'scim_user', 'user-1', {});

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          ipAddress: '203.0.113.50',
        })
      );
    });

    it('should fallback to X-Forwarded-For when CF header is missing', async () => {
      const context = createMockContext({
        headers: {
          'CF-Connecting-IP': undefined,
          'X-Forwarded-For': '10.0.0.1, 192.168.1.1',
        },
      });

      await createScimAuditLog(context, 'scim.user.create', 'scim_user', 'user-1', {});

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          ipAddress: '10.0.0.1', // First IP from X-Forwarded-For
        })
      );
    });

    it('should fallback to X-Real-IP when CF and X-Forwarded-For are missing', async () => {
      const context = createMockContext({
        headers: {
          'CF-Connecting-IP': undefined,
          'X-Forwarded-For': undefined,
          'X-Real-IP': '172.16.0.100',
        },
      });

      await createScimAuditLog(context, 'scim.user.create', 'scim_user', 'user-1', {});

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          ipAddress: '172.16.0.100',
        })
      );
    });

    it('should use "unknown" when no IP headers are present', async () => {
      const context = createMockContext({
        headers: {
          'CF-Connecting-IP': undefined,
          'X-Forwarded-For': undefined,
          'X-Real-IP': undefined,
        },
      });

      await createScimAuditLog(context, 'scim.user.create', 'scim_user', 'user-1', {});

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          ipAddress: 'unknown',
        })
      );
    });
  });

  describe('User-Agent Extraction', () => {
    it('should extract User-Agent header', async () => {
      const context = createMockContext({
        headers: { 'User-Agent': 'Azure AD SCIM Client/1.0' },
      });

      await createScimAuditLog(context, 'scim.user.create', 'scim_user', 'user-1', {});

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          userAgent: 'Azure AD SCIM Client/1.0',
        })
      );
    });

    it('should use "unknown" when User-Agent is missing', async () => {
      const context = createMockContext({
        headers: { 'User-Agent': undefined },
      });

      await createScimAuditLog(context, 'scim.user.create', 'scim_user', 'user-1', {});

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          userAgent: 'unknown',
        })
      );
    });
  });

  describe('Severity Levels', () => {
    it('should use info severity by default', async () => {
      const context = createMockContext({});

      await createScimAuditLog(context, 'scim.user.create', 'scim_user', 'user-1', {});

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          severity: 'info',
        })
      );
    });

    it('should use warning severity for delete operations', async () => {
      const context = createMockContext({});

      await createScimAuditLog(context, 'scim.user.delete', 'scim_user', 'user-1', {}, 'warning');

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          severity: 'warning',
        })
      );
    });

    it('should support critical severity', async () => {
      const context = createMockContext({});

      await createScimAuditLog(context, 'scim.bulk.execute', 'scim_user', 'bulk-1', {}, 'critical');

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          severity: 'critical',
        })
      );
    });
  });

  describe('Metadata Handling', () => {
    it('should stringify metadata object', async () => {
      const context = createMockContext({});
      const metadata = {
        externalId: 'ext-123',
        displayName: 'Test User',
      };

      await createScimAuditLog(context, 'scim.user.create', 'scim_user', 'user-1', metadata);

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          metadata: JSON.stringify(metadata),
        })
      );
    });

    it('should handle empty metadata', async () => {
      const context = createMockContext({});

      await createScimAuditLog(context, 'scim.user.create', 'scim_user', 'user-1', {});

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          metadata: '{}',
        })
      );
    });
  });

  describe('All SCIM Resource Types', () => {
    it('should log scim_user resource type', async () => {
      const context = createMockContext({});

      await createScimAuditLog(context, 'scim.user.create', 'scim_user', 'user-1', {});

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          resource: 'scim_user',
        })
      );
    });

    it('should log scim_group resource type', async () => {
      const context = createMockContext({});

      await createScimAuditLog(context, 'scim.group.create', 'scim_group', 'group-1', {});

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          resource: 'scim_group',
        })
      );
    });

    it('should log scim_token resource type', async () => {
      const context = createMockContext({});

      await createScimAuditLog(context, 'scim.token.create', 'scim_token', 'token-hash', {});

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        context.env,
        expect.objectContaining({
          resource: 'scim_token',
        })
      );
    });
  });
});

describe('logScimAudit (non-blocking wrapper)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call createScimAuditLog with correct parameters', async () => {
    const context = createMockContext({});

    logScimAudit(context, 'scim.user.create', 'scim_user', 'user-123', {
      externalId: 'ext-123',
    });

    // Allow promise to resolve
    await vi.waitFor(() => {
      expect(mockCreateAuditLog).toHaveBeenCalled();
    });

    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      context.env,
      expect.objectContaining({
        userId: 'scim-service',
        action: 'scim.user.create',
        resource: 'scim_user',
        resourceId: 'user-123',
      })
    );
  });

  it('should not throw when createAuditLog fails (fire-and-forget)', async () => {
    mockCreateAuditLog.mockRejectedValueOnce(new Error('DB write failed'));
    const context = createMockContext({});

    // This should not throw
    expect(() => {
      logScimAudit(context, 'scim.user.create', 'scim_user', 'user-123', {});
    }).not.toThrow();

    // Allow promise to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify it was called (even though it failed)
    expect(mockCreateAuditLog).toHaveBeenCalled();
  });

  it('should be truly non-blocking (returns void without waiting for the audit log)', () => {
    mockCreateAuditLog.mockImplementationOnce(() => new Promise(() => {}));
    const context = createMockContext({});

    const result = logScimAudit(context, 'scim.user.create', 'scim_user', 'user-123', {});

    expect(result).toBeUndefined();
    expect(mockCreateAuditLog).toHaveBeenCalledOnce();
  });

  it('should support warning severity for delete operations', async () => {
    const context = createMockContext({});

    logScimAudit(context, 'scim.user.delete', 'scim_user', 'user-123', {}, 'warning');

    await vi.waitFor(() => {
      expect(mockCreateAuditLog).toHaveBeenCalled();
    });

    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      context.env,
      expect.objectContaining({
        severity: 'warning',
      })
    );
  });
});
