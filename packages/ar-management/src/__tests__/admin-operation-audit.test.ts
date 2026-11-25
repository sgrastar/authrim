import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogDeliveryError, type Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  writeRow: vi.fn(async (_env: unknown, row: { id: string; result?: string }) => row.id),
  createAuditLog: vi.fn(async () => undefined),
  failsClosed: vi.fn<(env: unknown, tenantId: string, action: string) => Promise<boolean> | null>(
    () => null
  ),
}));

vi.mock('../admin-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../admin-shared')>()),
  writeAdminAuditRowOrThrow: mocks.writeRow,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLog: mocks.createAuditLog,
    // The tenant's audit profile, when a test sets one; the real resolution otherwise.
    isTenantAuditActionFailClosed: (env: Env, tenantId: string, action: string) =>
      mocks.failsClosed(env, tenantId, action) ??
      actual.isTenantAuditActionFailClosed(env, tenantId, action),
  };
});

const { recordAdminOperationAudit, recordAdminOperationAuditFromEnv } =
  await import('../admin-operation-audit');

type Input = Parameters<typeof recordAdminOperationAudit>[1];

const ADMIN = {
  userId: 'admin-1',
  email: 'admin@example.test',
  authMethod: 'session',
  sessionId: 'admin-session-1',
};

async function record(
  input: Input,
  context: { tenantId?: string | null; adminAuth?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: { id?: string | null; error?: string; code?: string } }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    const tenantId = context.tenantId === undefined ? 'tenant-a' : context.tenantId;
    if (tenantId !== null) c.set('tenantId' as never, tenantId as never);
    const adminAuth = context.adminAuth === undefined ? ADMIN : context.adminAuth;
    if (adminAuth !== null) c.set('adminAuth' as never, adminAuth as never);
    await next();
  });
  app.post('/op', async (c) => {
    try {
      return c.json({ id: await recordAdminOperationAudit(c, input) });
    } catch (error) {
      if (error instanceof AuditLogDeliveryError) {
        return c.json({ error: 'audit_unavailable', code: error.message }, 503);
      }
      throw error;
    }
  });
  const response = await app.request(
    '/op',
    {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '192.0.2.7', 'User-Agent': 'console', ...context.headers },
    },
    {}
  );
  return {
    status: response.status,
    body: await response.json<{ id?: string | null; error?: string; code?: string }>(),
  };
}

beforeEach(() => {
  mocks.writeRow.mockReset().mockImplementation(async (_env, row) => row.id);
  mocks.createAuditLog.mockReset().mockResolvedValue(undefined);
  mocks.failsClosed.mockReset().mockReturnValue(null);
});

describe('recordAdminOperationAudit', () => {
  it('records the operation in the admin audit log with its administrator', async () => {
    const { status, body } = await record({
      action: 'screen.updated',
      resourceType: 'screen',
      resourceId: 'screen-1',
      metadata: { changed_fields: ['title'] },
      severity: 'warning',
    });
    expect(status).toBe(200);
    expect(mocks.writeRow).toHaveBeenCalledTimes(1);
    const row = mocks.writeRow.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(row).toMatchObject({
      id: body.id,
      tenant_id: 'tenant-a',
      admin_user_id: 'admin-1',
      admin_email: 'admin@example.test',
      action: 'screen.updated',
      resource_type: 'screen',
      resource_id: 'screen-1',
      result: 'success',
      severity: 'warn',
      ip_address: '192.0.2.7',
      user_agent: 'console',
      session_id: expect.any(String) as unknown,
      metadata: expect.objectContaining({
        changed_fields: ['title'],
        admin_actor_id: 'admin-1',
      }) as unknown,
    });
    // The admin session is recorded as a digest only.
    expect(row.session_id).not.toBe('admin-session-1');
    // Not an end-user event.
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it('records a failed action as a failure', async () => {
    await record({ action: 'webhook.test_failed', resourceType: 'webhook', resourceId: 'w-1' });
    await record({
      action: 'identity_mapping.set.saved',
      resourceType: 'field_mapping_set',
      resourceId: 's-1',
      metadata: { result: 'failed' },
    });
    expect(mocks.writeRow.mock.calls.map((call) => call[1].result)).toEqual(['failure', 'failure']);
  });

  it("adds the operation to the end user's history without naming the administrator", async () => {
    await record({
      action: 'user.suspended',
      resourceType: 'user',
      resourceId: 'user-9',
      metadata: { reason: 'abuse' },
      endUser: { userId: 'user-9', action: 'user.suspend' },
    });
    expect(mocks.writeRow).toHaveBeenCalledTimes(1);
    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
    const [, entry] = mocks.createAuditLog.mock.calls[0] as unknown as [
      Env,
      Record<string, unknown>,
    ];
    expect(entry).toMatchObject({
      tenantId: 'tenant-a',
      userId: 'user-9',
      action: 'user.suspend',
      resource: 'user',
      resourceId: 'user-9',
    });
    expect(JSON.parse(String(entry.metadata))).toEqual({
      reason: 'abuse',
      userId: 'user-9',
      actor_type: 'admin',
      result: 'success',
    });
    expect(JSON.stringify(entry)).not.toContain('admin-1');
  });

  it('marks the history entry as an admin action even when the metadata says otherwise', async () => {
    await record({
      action: 'user.updated',
      resourceType: 'user',
      resourceId: 'user-9',
      endUser: { userId: 'user-9', metadata: { actor_type: 'user', userId: 'someone-else' } },
    });
    const [, entry] = mocks.createAuditLog.mock.calls[0] as unknown as [Env, { metadata: string }];
    expect(JSON.parse(entry.metadata)).toMatchObject({ actor_type: 'admin', userId: 'user-9' });
  });

  it("keeps every administrator identifier out of the user's history", async () => {
    await record({
      action: 'user.assurance.evidence_revoked',
      resourceType: 'user',
      resourceId: 'user-9',
      metadata: {
        evidence_id: 'ev-1',
        revoked_by: 'admin:admin-1',
        admin_actor_id: 'admin-1',
        admin_delegator_id: 'admin-2',
        actorId: 'admin-1',
      },
      endUser: { userId: 'user-9' },
    });
    await record({
      action: 'user.updated',
      resourceType: 'user',
      resourceId: 'user-9',
      endUser: { userId: 'user-9', metadata: { fields: ['name'], admin_actor_id: 'admin-1' } },
    });
    const sent = mocks.createAuditLog.mock.calls.map(
      (call) => (call as unknown as [Env, { metadata: string }])[1].metadata
    );
    expect(sent.map((metadata) => JSON.parse(metadata) as unknown)).toEqual([
      { evidence_id: 'ev-1', userId: 'user-9', actor_type: 'admin', result: 'success' },
      { fields: ['name'], userId: 'user-9', actor_type: 'admin', result: 'success' },
    ]);
    // The admin record keeps who acted.
    expect(mocks.writeRow.mock.calls[0]?.[1]).toMatchObject({
      metadata: expect.objectContaining({ revoked_by: 'admin:admin-1' }) as unknown,
    });
  });

  it('keeps nested administrator identifiers out of the user history', async () => {
    await record({
      action: 'user.updated',
      resourceType: 'user',
      resourceId: 'user-9',
      metadata: {
        context: { admin_actor_id: 'admin-1', revoked_by: 'admin:admin-1', reason: 'r' },
        steps: [{ performed_by: 'admin-1', step: 1 }],
      },
      endUser: { userId: 'user-9' },
    });
    await record({
      action: 'user.updated',
      resourceType: 'user',
      resourceId: 'user-9',
      endUser: {
        userId: 'user-9',
        metadata: { changes: [{ field: 'name', actorId: 'admin-1' }] },
      },
    });
    const sent = mocks.createAuditLog.mock.calls.map(
      (call) => (call as unknown as [Env, { metadata: string }])[1].metadata
    );
    expect(sent.join()).not.toContain('admin-1');
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({
      context: { reason: 'r' },
      steps: [{ step: 1 }],
    });
    expect(JSON.parse(sent[1] ?? '{}')).toMatchObject({ changes: [{ field: 'name' }] });
  });

  it('records one outcome in both logs', async () => {
    await record({
      action: 'user.updated',
      resourceType: 'user',
      resourceId: 'user-9',
      result: 'failure',
      endUser: { userId: 'user-9' },
    });
    // A failed action renamed for the user's history is still a failure.
    await record({
      action: 'email.delivery_failed',
      resourceType: 'user',
      resourceId: 'user-9',
      endUser: { userId: 'user-9', action: 'email.queued' },
    });
    expect(mocks.writeRow.mock.calls.map((call) => call[1].result)).toEqual(['failure', 'failure']);
    const sent = mocks.createAuditLog.mock.calls.map(
      (call) => JSON.parse((call as unknown as [Env, { metadata: string }])[1].metadata) as unknown
    );
    expect(sent).toEqual([
      expect.objectContaining({ result: 'failure' }),
      expect.objectContaining({ result: 'failure' }),
    ]);
  });

  it('fails a fail-closed action whose record cannot be stored', async () => {
    mocks.writeRow.mockRejectedValue(new Error('log writer down'));
    const { status, body } = await record({
      action: 'role.updated',
      resourceType: 'role',
      resourceId: 'r-1',
    });
    expect(status).toBe(503);
    expect(body.code).toBe('admin_audit_write_failed');
  });

  it('lets a fail-open action go on without its record', async () => {
    mocks.writeRow.mockRejectedValue(new Error('log writer down'));
    const { status, body } = await record({
      action: 'token.introspected',
      resourceType: 'token',
      resourceId: 't-1',
    });
    expect(status).toBe(200);
    expect(body.id).toBeNull();
  });

  it('follows a tenant profile that fails every action closed', async () => {
    mocks.failsClosed.mockResolvedValue(true);
    mocks.writeRow.mockRejectedValue(new Error('log writer down'));
    const { status, body } = await record({
      action: 'token.introspected',
      resourceType: 'token',
      resourceId: 't-1',
    });
    expect(status).toBe(503);
    expect(body.code).toBe('admin_audit_write_failed');
    expect(mocks.failsClosed).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'token.introspected'
    );
  });

  it('never records against a header or default tenant when none was routed', async () => {
    for (const tenantId of [null, '  ']) {
      const { status, body } = await record(
        { action: 'tenant.updated', resourceType: 'tenant', resourceId: 'tenant-b' },
        { tenantId, headers: { 'X-Tenant-Id': 'tenant-b' } }
      );
      expect(status).toBe(503);
      expect(body.code).toBe('admin_audit_tenant_required');
    }
    const open = await record(
      { action: 'token.introspected', resourceType: 'token', resourceId: 't-1' },
      { tenantId: null }
    );
    expect(open).toEqual({ status: 200, body: { id: null } });
    expect(mocks.writeRow).not.toHaveBeenCalled();
  });

  it('never records an operation without its administrator', async () => {
    const { status, body } = await record(
      { action: 'client.updated', resourceType: 'client', resourceId: 'c-1' },
      { adminAuth: null }
    );
    expect(status).toBe(503);
    expect(body.code).toBe('admin_audit_actor_required');
    expect(mocks.writeRow).not.toHaveBeenCalled();
  });

  it("passes on the end-user history's own delivery failure", async () => {
    mocks.createAuditLog.mockRejectedValue(
      new AuditLogDeliveryError('audit_log_write_failed', 'user.suspend', 'tenant-a')
    );
    const { status, body } = await record({
      action: 'user.suspended',
      resourceType: 'user',
      resourceId: 'user-9',
      endUser: { userId: 'user-9', action: 'user.suspend' },
    });
    expect(status).toBe(503);
    expect(body.code).toBe('audit_log_write_failed');
    // The admin record was written first.
    expect(mocks.writeRow).toHaveBeenCalledTimes(1);
  });
  it('records against a tenant the route names', async () => {
    await record(
      {
        action: 'tenant.updated',
        resourceType: 'tenant',
        resourceId: 'tenant-b',
        tenantId: 'tenant-b',
      },
      { tenantId: 'platform' }
    );
    expect(mocks.writeRow.mock.calls[0]?.[1]).toMatchObject({ tenant_id: 'tenant-b' });
  });
});

describe('recordAdminOperationAuditFromEnv', () => {
  it('records the administrator who asked, outside the request', async () => {
    const id = await recordAdminOperationAuditFromEnv({} as Env, {
      tenantId: 'tenant-a',
      actorId: 'admin-1',
      action: 'tenant.cloned',
      resourceType: 'tenant',
      resourceId: 'tenant-a',
      metadata: { operation_id: 'op-1' },
    });
    const row = mocks.writeRow.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    // Only the principal's ID was kept: it is not recorded as an administrator's own record.
    expect(row.admin_user_id).toBeUndefined();
    expect(row).toMatchObject({
      id,
      tenant_id: 'tenant-a',
      action: 'tenant.cloned',
      resource_type: 'tenant',
      resource_id: 'tenant-a',
      result: 'success',
      metadata: expect.objectContaining({
        operation_id: 'op-1',
        admin_actor_id: 'admin-1',
        admin_actor_type: 'unrecorded',
      }) as unknown,
    });
  });

  it('records a scheduler as the system', async () => {
    await recordAdminOperationAuditFromEnv({} as Env, {
      tenantId: 'default',
      actorId: 'system:legacy-settings-import',
      action: 'settings.legacy_import',
      resourceType: 'settings',
      resourceId: 'platform:default:session',
    });
    expect(mocks.writeRow.mock.calls[0]?.[1]).toMatchObject({
      admin_user_id: 'system',
      metadata: expect.objectContaining({
        admin_actor_type: 'system',
        admin_actor_id: 'system:legacy-settings-import',
      }) as unknown,
    });
  });

  it('fails a fail-closed action without its tenant, administrator or record', async () => {
    const input = {
      tenantId: 'tenant-a',
      actorId: 'admin-1',
      action: 'tenant.cloned',
      resourceType: 'tenant',
      resourceId: 'tenant-a',
    };
    await expect(
      recordAdminOperationAuditFromEnv({} as Env, { ...input, tenantId: ' ' })
    ).rejects.toThrow('admin_audit_tenant_required');
    await expect(
      recordAdminOperationAuditFromEnv({} as Env, { ...input, actorId: '' })
    ).rejects.toThrow('admin_audit_actor_required');
    expect(mocks.writeRow).not.toHaveBeenCalled();
    mocks.writeRow.mockRejectedValue(new Error('log writer down'));
    await expect(recordAdminOperationAuditFromEnv({} as Env, input)).rejects.toThrow(
      'admin_audit_write_failed'
    );
    // A fail-open action goes on.
    await expect(
      recordAdminOperationAuditFromEnv({} as Env, { ...input, action: 'token.introspected' })
    ).resolves.toBeNull();
  });
});
