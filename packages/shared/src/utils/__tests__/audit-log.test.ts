import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAuditLog, createAuditLogFromContext } from '../audit-log';
import type { Env } from '../../types/env';
import type { Context } from 'hono';

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
  };
}

/**
 * Create a mock environment
 */
function createMockEnv(dbOptions: { shouldFail?: boolean } = {}): Env {
  return {
    DB: createMockDB(dbOptions) as unknown as D1Database,
    ISSUER_URL: 'https://test.example.com',
  } as Env;
}

/**
 * Create a mock Hono context
 */
function createMockContext(options: {
  adminAuth?: { userId: string };
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
      return undefined;
    }),
  } as unknown as Context<{ Bindings: Env }>;
}

describe('createAuditLog', () => {
  let mockEnv: Env;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
    consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create an audit log entry successfully', async () => {
    await createAuditLog(mockEnv, {
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
    };
    const env = { ...mockEnv, DB: mockDB as unknown as D1Database };

    await createAuditLog(env, {
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
      userId: 'user-2',
      action: 'test.action',
      resource: 'test',
      resourceId: 'id-2',
      ipAddress: '127.0.0.1',
      userAgent: 'Test',
      metadata: '{}',
      severity: 'info',
    });

    // First argument is the ID
    const id1 = bindCalls[0][0];
    const id2 = bindCalls[1][0];
    expect(id1).not.toBe(id2);
  });

  it('should log critical operations to console', async () => {
    await createAuditLog(mockEnv, {
      userId: 'admin-user',
      action: 'signing_keys.rotate.emergency',
      resource: 'signing_keys',
      resourceId: 'key-compromised',
      ipAddress: '10.0.0.1',
      userAgent: 'Admin Tool',
      metadata: '{"reason": "key compromise detected"}',
      severity: 'critical',
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      '[CRITICAL AUDIT]',
      expect.objectContaining({
        action: 'signing_keys.rotate.emergency',
        userId: 'admin-user',
      })
    );
  });

  it('should not log to console for non-critical operations', async () => {
    await createAuditLog(mockEnv, {
      userId: 'user-123',
      action: 'signing_keys.status.read',
      resource: 'signing_keys',
      resourceId: 'key-123',
      ipAddress: '192.168.1.1',
      userAgent: 'Browser',
      metadata: '{}',
      severity: 'info',
    });

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  describe('Error Handling (Non-blocking)', () => {
    it('should not throw when DB write fails', async () => {
      const failingEnv = createMockEnv({ shouldFail: true });

      // Should not throw
      await expect(
        createAuditLog(failingEnv, {
          userId: 'user-123',
          action: 'test.action',
          resource: 'test',
          resourceId: 'id-1',
          ipAddress: '127.0.0.1',
          userAgent: 'Test',
          metadata: '{}',
          severity: 'info',
        })
      ).resolves.not.toThrow();

      // Should log the error
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to create audit log:',
        expect.any(Error)
      );
    });

    it('should log the audit data when DB fails', async () => {
      const failingEnv = createMockEnv({ shouldFail: true });

      const auditData = {
        userId: 'user-123',
        action: 'important.action',
        resource: 'critical-resource',
        resourceId: 'id-xyz',
        ipAddress: '192.168.1.100',
        userAgent: 'Test Agent',
        metadata: '{"important": "data"}',
        severity: 'warning' as const,
      };

      await createAuditLog(failingEnv, auditData);

      expect(consoleErrorSpy).toHaveBeenCalledWith('Audit log data:', auditData);
    });
  });
});

describe('createAuditLogFromContext', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
        return undefined;
      }),
    } as unknown as Context<{ Bindings: Env }>;

    await createAuditLogFromContext(mockContext, 'test.action', 'resource', 'id-1', {}, 'info');

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
        return undefined;
      }),
    } as unknown as Context<{ Bindings: Env }>;

    await createAuditLogFromContext(mockContext, 'test.action', 'resource', 'id-1', {}, 'info');

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

  it('should not create log when adminAuth context is missing', async () => {
    const mockEnv = createMockEnv();
    const mockContext = {
      env: mockEnv,
      req: {
        header: vi.fn(() => null),
      },
      get: vi.fn(() => undefined), // No adminAuth
    } as unknown as Context<{ Bindings: Env }>;

    await createAuditLogFromContext(mockContext, 'test.action', 'resource', 'id-1', {}, 'info');

    // Should log error and not call DB
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Cannot create audit log: adminAuth context not found'
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
