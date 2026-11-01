import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types/env';

const state = vi.hoisted(() => ({
  createAuditLog: vi.fn<(entry: Record<string, unknown>) => Promise<unknown>>(),
  requireAdapter: vi.fn(),
}));

vi.mock('../repositories/admin/admin-audit-log', () => ({
  AdminAuditLogRepository: class {
    createAuditLog = state.createAuditLog;
  },
}));
vi.mock('./admin-database-adapter', () => ({
  requireAdminDatabaseAdapter: state.requireAdapter,
}));

import {
  scheduleAdminAuthenticationAudit,
  writeAdminAuthenticationAudit,
} from './admin-authentication-audit';

const env = {} as Env;
const expectedDigest = `sha256:${createHash('sha256')
  .update('authrim:admin-session-audit:session-1')
  .digest('hex')
  .slice(0, 32)}`;
const headers: Record<string, string> = {
  'CF-Connecting-IP': '203.0.113.9',
  'User-Agent': 'agent/1',
  'CF-Ray': 'ray-1',
};
const request = { header: (name: string) => headers[name] };

describe('Admin authentication audit', () => {
  beforeEach(() => {
    state.createAuditLog.mockReset().mockResolvedValue({});
    state.requireAdapter.mockReset().mockReturnValue({});
  });

  it('records a sign-in with the session and the request context', async () => {
    await expect(
      writeAdminAuthenticationAudit(env, request, {
        tenantId: 'tenant-a',
        action: 'admin.login',
        method: 'passkey',
        adminUserId: 'admin-1',
        sessionId: 'session-1',
      })
    ).resolves.toBe(true);

    expect(state.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        admin_user_id: 'admin-1',
        action: 'admin.login',
        resource_type: 'admin_session',
        resource_id: expectedDigest,
        session_id: expectedDigest,
        result: 'success',
        severity: 'info',
        ip_address: '203.0.113.9',
        user_agent: 'agent/1',
        request_id: 'ray-1',
        metadata: { method: 'passkey' },
      })
    );
  });

  it('prefers the runtime request ID, then the proxy headers, then CF-Ray', async () => {
    const write = (req: { header(name: string): string | undefined }, requestId?: string) =>
      writeAdminAuthenticationAudit(env, req, {
        tenantId: 'tenant-a',
        action: 'admin.logout',
        requestId,
      });
    await write(request, 'runtime-1');
    await write({ header: (name) => ({ 'X-Request-Id': 'proxy-1', 'CF-Ray': 'ray-1' })[name] });
    await write({ header: (name) => ({ 'CF-Ray': 'ray-1' })[name] });
    await write({ header: () => undefined });

    expect(state.createAuditLog.mock.calls.map(([entry]) => entry.request_id)).toEqual([
      'runtime-1',
      'proxy-1',
      'ray-1',
      undefined,
    ]);
  });

  it('takes the request ID from the context when scheduling', async () => {
    scheduleAdminAuthenticationAudit(
      {
        env,
        req: request,
        get: () => 'context-1',
        executionCtx: { waitUntil: vi.fn() },
      },
      { tenantId: 'tenant-a', action: 'admin.logout' }
    );
    await vi.waitFor(() => expect(state.createAuditLog).toHaveBeenCalledTimes(1));

    expect(state.createAuditLog.mock.calls[0]?.[0].request_id).toBe('context-1');
  });

  it('never writes the raw session ID, and keeps login and logout correlatable', async () => {
    for (const action of ['admin.login', 'admin.logout'] as const) {
      await writeAdminAuthenticationAudit(env, request, {
        tenantId: 'tenant-a',
        action,
        sessionId: 'session-1',
      });
    }

    const entries = state.createAuditLog.mock.calls.map(([entry]) => entry);
    expect(JSON.stringify(entries)).not.toContain('session-1');
    expect(entries.map((entry) => entry.resource_id)).toEqual([expectedDigest, expectedDigest]);
  });

  it('records a failed sign-in as a warning with its reason and no session', async () => {
    await writeAdminAuthenticationAudit(env, request, {
      tenantId: 'tenant-a',
      action: 'admin.login_failed',
      method: 'passkey',
      adminUserId: 'admin-1',
      reason: 'passkey_verification_failed',
    });

    const entry = state.createAuditLog.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      action: 'admin.login_failed',
      result: 'failure',
      severity: 'warn',
      error_code: 'passkey_verification_failed',
    });
    expect(entry.resource_id).toBeUndefined();
    expect(entry.session_id).toBeUndefined();
  });

  it('never rejects when the log store fails', async () => {
    state.createAuditLog.mockRejectedValue(new Error('log store down'));

    await expect(
      writeAdminAuthenticationAudit(env, request, { tenantId: 'tenant-a', action: 'admin.logout' })
    ).resolves.toBe(false);
  });

  it('never rejects when the Admin database is not configured', async () => {
    state.requireAdapter.mockImplementation(() => {
      throw new Error('Admin database is not configured');
    });

    await expect(
      writeAdminAuthenticationAudit(env, request, { tenantId: 'tenant-a', action: 'admin.logout' })
    ).resolves.toBe(false);
    expect(state.createAuditLog).not.toHaveBeenCalled();
  });

  it('hands the write to waitUntil, and still writes without an execution context', async () => {
    const waitUntil = vi.fn();
    scheduleAdminAuthenticationAudit(
      { env, req: request, executionCtx: { waitUntil } },
      { tenantId: 'tenant-a', action: 'admin.logout', sessionId: 'session-1' }
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);

    const noContext = {
      env,
      req: request,
      get executionCtx(): never {
        throw new Error('no execution context');
      },
    };
    scheduleAdminAuthenticationAudit(noContext, { tenantId: 'tenant-a', action: 'admin.logout' });
    await vi.waitFor(() => expect(state.createAuditLog).toHaveBeenCalledTimes(2));
  });
});
