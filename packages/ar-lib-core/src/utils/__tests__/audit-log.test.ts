import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '../../types/env';

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(),
  create: vi.fn(),
  profile: vi.fn(),
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    module: vi.fn(),
    child: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ ...mocks.logger, module: () => mocks.logger }),
}));
vi.mock('../../services/audit', async (original) => ({
  ...(await original<typeof import('../../services/audit')>()),
  createAuditService: mocks.create,
}));
vi.mock('../../services/runtime-profile-resolver', () => ({
  resolveTenantRuntimeProfilesFromEnv: mocks.profile,
}));
vi.mock('../audit-log-subject', async (original) => ({
  ...(await original<typeof import('../audit-log-subject')>()),
  resolveAnonymizedUserIdFromEnv: vi.fn().mockResolvedValue(null),
}));
import { createAuditLog, createAuditLogFromContext } from '../audit-log';

const event = {
  tenantId: 'tenant',
  userId: 'operator',
  action: 'auth.login.succeeded',
  resource: 'client',
  resourceId: 'app',
  ipAddress: '203.0.113.1',
  userAgent: 'private-agent',
  severity: 'info' as const,
};
function env() {
  return { DB: { prepare: vi.fn() }, AUTHRIM_LOG_ARCHIVE_MODE: 'pipeline' } as unknown as Env;
}
function context(
  environment: Env,
  values: Record<string, unknown> = { adminAuth: { userId: 'operator' }, tenantId: 'tenant' }
) {
  return {
    env: environment,
    get: (key: string) => values[key],
    req: {
      header: (name: string) =>
        ({
          'CF-Connecting-IP': '203.0.113.1',
          'User-Agent': 'private-agent',
          'X-Request-Id': 'request',
        })[name],
    },
  } as unknown as Context<{ Bindings: Env }>;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.logger.module.mockReturnValue(mocks.logger);
  mocks.logger.child.mockReturnValue(mocks.logger);
  mocks.create.mockReturnValue({ logEvent: mocks.logEvent });
  mocks.logEvent.mockResolvedValue(undefined);
  mocks.profile.mockResolvedValue({
    auditProfile: {
      id: 'profile',
      kind: 'audit',
      primary: { type: 'd1', bindingRef: 'DB', dataset: 'audit_log' },
      archive: null,
      sinks: [],
    },
  });
});

describe('one canonical audit event', () => {
  it('does not insert old audit_log even when a profile names that primary', async () => {
    const environment = env();
    await createAuditLog(environment, { ...event, metadata: '{"method":"passkey"}' });
    expect(environment.DB.prepare).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledExactlyOnceWith(
      'tenant',
      expect.objectContaining({
        eventType: event.action,
        result: 'success',
        details: expect.objectContaining({ method: 'passkey' }),
      })
    );
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ env: environment }));
  });
  it('preserves caller event identity and epoch milliseconds across retries', async () => {
    const input = { ...event, id: 'operation-event', createdAt: 1_800_000_000_123 };
    await createAuditLog(env(), input);
    await createAuditLog(env(), input);
    for (const [, value] of mocks.logEvent.mock.calls)
      expect(value).toMatchObject({ id: input.id, createdAt: input.createdAt });
  });
  it('generates distinct immutable IDs when the caller has no replay identity', async () => {
    await createAuditLog(env(), event);
    await createAuditLog(env(), event);
    expect(mocks.logEvent.mock.calls[0][1].id).not.toBe(mocks.logEvent.mock.calls[1][1].id);
  });
  it('allows a fail-open operation to continue but logs only a safe error envelope', async () => {
    mocks.logEvent.mockRejectedValue(new Error('archive_unavailable'));
    await expect(
      createAuditLog(env(), { ...event, metadata: '{"email":"private@example.test"}' })
    ).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Failed to persist canonical audit event',
      {},
      expect.any(Error)
    );
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain('private@example.test');
  });
  it('fails closed for deletion evidence when canonical storage refuses acceptance', async () => {
    mocks.logEvent.mockRejectedValue(new Error('archive_unavailable'));
    await expect(createAuditLog(env(), { ...event, action: 'user.deleted' })).rejects.toThrow(
      'audit_log_write_failed'
    );
  });
  it('honors explicit durable acceptance for any event', async () => {
    mocks.logEvent.mockRejectedValue(new Error('queue_unavailable'));
    await expect(createAuditLog(env(), { ...event, requireDurableFanout: true })).rejects.toThrow(
      'audit_log_write_failed'
    );
  });
  it('logs only safe fields for critical operations', async () => {
    await createAuditLog(env(), {
      ...event,
      severity: 'critical',
      metadata: '{"secret":"never-console"}',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith('CRITICAL AUDIT', {
      tenantId: 'tenant',
      action: event.action,
      resource: event.resource,
    });
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(event.userId);
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain('never-console');
  });
  it.each([{ id: 'bad/id' }, { createdAt: -1 }, { createdAt: Number.NaN }])(
    'rejects invalid immutable identity/time %j',
    async (bad) => {
      await expect(createAuditLog(env(), { ...event, ...bad })).rejects.toThrow(
        /audit_log_(id|created_at)_invalid/u
      );
      expect(mocks.logEvent).not.toHaveBeenCalled();
    }
  );
});

describe('audit context', () => {
  it('passes the selected tenant, metadata, request correlation and stable identity to canonical storage', async () => {
    await createAuditLogFromContext(
      context(env()),
      'settings.updated',
      'settings',
      'profile',
      { setting: 'name' },
      'warning',
      'stable-event',
      1_800_000_000_000,
      true
    );
    expect(mocks.logEvent).toHaveBeenCalledWith(
      'tenant',
      expect.objectContaining({
        id: 'stable-event',
        createdAt: 1_800_000_000_000,
        eventType: 'settings.updated',
        severity: 'warn',
        requireDurableFanout: true,
        details: expect.objectContaining({ setting: 'name', request_id: 'request' }),
      })
    );
  });
  it('refuses fail-closed operations when admin authentication context is absent', async () => {
    await expect(
      createAuditLogFromContext(
        context(env(), { tenantId: 'tenant' }),
        'user.deleted',
        'user',
        'account',
        {}
      )
    ).rejects.toThrow('admin_auth_required');
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
  it('rejects a settings operation when tenant context is absent', async () => {
    await expect(
      createAuditLogFromContext(
        context(env(), { adminAuth: { userId: 'operator' } }),
        'settings.updated',
        'settings',
        'profile',
        {}
      )
    ).rejects.toThrow('audit_log_tenant_id_required');
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
