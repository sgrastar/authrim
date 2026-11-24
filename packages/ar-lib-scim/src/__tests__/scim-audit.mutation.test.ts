/**
 * SCIM audit log - mutation-hardening tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';

const mockCreateAuditLog = vi.fn().mockResolvedValue(undefined);
const mockWaitUntil = vi.fn();
vi.mock('@authrim/ar-lib-core', () => ({
  createAuditLog: (...args: unknown[]): Promise<void> =>
    mockCreateAuditLog(...args) as Promise<void>,
  getWaitUntilFromContext: (c: { waitUntilForTest?: boolean }) =>
    c.waitUntilForTest ? mockWaitUntil : undefined,
}));

import { createScimAuditLog } from '../utils/scim-audit';

function makeContext(options: {
  tenantId?: string;
  headers?: Record<string, string>;
  withGet?: boolean;
  waitUntil?: boolean;
}): Context<{ Bindings: Env }> {
  const headers = options.headers ?? {};
  const context: Record<string, unknown> = {
    env: { ISSUER_URL: 'https://test.example.com' },
    req: { header: (name: string) => headers[name] },
    waitUntilForTest: options.waitUntil === true,
  };
  if (options.withGet !== false) {
    context.get = (key: string) => (key === 'tenantId' ? options.tenantId : undefined);
  }
  return context as unknown as Context<{ Bindings: Env }>;
}

function auditEntry(): Record<string, unknown> {
  return mockCreateAuditLog.mock.calls[0][1] as Record<string, unknown>;
}

describe('createScimAuditLog tenant handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('trims whitespace around the tenant id', async () => {
    const c = makeContext({ tenantId: '  tenant-a \n' });
    await createScimAuditLog(c, 'scim.user.create', 'scim_user', 'u1', {});
    expect(auditEntry().tenantId).toBe('tenant-a');
  });

  it('skips logging when the tenant id is only whitespace', async () => {
    const c = makeContext({ tenantId: '   ' });
    await createScimAuditLog(c, 'scim.user.create', 'scim_user', 'u1', {});
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it('skips logging without throwing when the context has no get()', async () => {
    const c = makeContext({ withGet: false });
    await expect(
      createScimAuditLog(c, 'scim.user.create', 'scim_user', 'u1', {})
    ).resolves.toBeUndefined();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});

describe('createScimAuditLog request details', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses only the first, trimmed address of X-Forwarded-For', async () => {
    const c = makeContext({
      tenantId: 't',
      headers: { 'X-Forwarded-For': '  203.0.113.9 , 198.51.100.1, 10.0.0.1' },
    });
    await createScimAuditLog(c, 'scim.user.create', 'scim_user', 'u1', {});
    expect(auditEntry().ipAddress).toBe('203.0.113.9');
  });

  it('prefers CF-Connecting-IP over X-Forwarded-For', async () => {
    const c = makeContext({
      tenantId: 't',
      headers: { 'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': '203.0.113.9' },
    });
    await createScimAuditLog(c, 'scim.user.create', 'scim_user', 'u1', {});
    expect(auditEntry().ipAddress).toBe('192.0.2.1');
  });

  it('falls back to X-Real-IP when X-Forwarded-For is blank', async () => {
    const c = makeContext({
      tenantId: 't',
      headers: { 'X-Forwarded-For': '  ', 'X-Real-IP': '198.51.100.7' },
    });
    await createScimAuditLog(c, 'scim.user.create', 'scim_user', 'u1', {});
    expect(auditEntry().ipAddress).toBe('198.51.100.7');
  });

  it('passes the request waitUntil to the audit writer', async () => {
    const c = makeContext({ tenantId: 't', waitUntil: true });
    await createScimAuditLog(c, 'scim.user.create', 'scim_user', 'u1', {});
    expect(mockCreateAuditLog.mock.calls[0][2]).toEqual({ waitUntil: mockWaitUntil });
  });

  it('serialises the metadata and carries the full entry', async () => {
    const c = makeContext({ tenantId: 't', headers: { 'User-Agent': 'agent/1' } });
    await createScimAuditLog(c, 'scim.group.patch', 'scim_group', 'g1', { a: 1 }, 'warning');
    expect(auditEntry()).toEqual({
      tenantId: 't',
      userId: 'scim-service',
      action: 'scim.group.patch',
      resource: 'scim_group',
      resourceId: 'g1',
      ipAddress: 'unknown',
      userAgent: 'agent/1',
      metadata: '{"a":1}',
      severity: 'warning',
    });
  });
});
