import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';

const repository = vi.hoisted(() => ({
  getElevationChallenge: vi.fn(),
  beginManagementExecution: vi.fn(),
  lookupManagementExecution: vi.fn(),
  completeManagementExecution: vi.fn(),
}));

vi.mock('@authrim/ar-agent-access/core', async (importActual) => {
  const actual = await importActual<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    AdminAgentAccessRepository: class {
      getElevationChallenge = repository.getElevationChallenge;
      beginManagementExecution = repository.beginManagementExecution;
      lookupManagementExecution = repository.lookupManagementExecution;
      completeManagementExecution = repository.completeManagementExecution;
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importActual) => {
  const actual = await importActual<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})) };
});

import { agentElevatedExecutionMiddleware } from '../agent-elevated-execution';
import { computeAgentElevationArgsHash } from '@authrim/ar-agent-access/core';

const encryptionKey = '07'.repeat(32);

function createApp(handler = vi.fn((c) => c.json({ user_id: 'user-1', status: 'suspended' }))) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminAuth?: AdminAuthContext };
  }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-2',
      authMethod: 'bearer',
      actorType: 'agent',
      actorId: 'client:client-1',
      clientId: 'client-1',
      tenantId: 'tenant-1',
      roles: [],
      permissions: ['admin:users:suspend'],
      hierarchyLevel: 0,
      mfaVerified: false,
      agentGrantId: 'grant-1',
    });
    await next();
  });
  app.post(
    '/api/admin/agent-write/users/:id/suspend',
    agentElevatedExecutionMiddleware('admin.write.users.suspend'),
    handler
  );
  return { app, handler };
}

function request(app: ReturnType<typeof createApp>['app'], headers: Record<string, string> = {}) {
  return app.request(
    '/api/admin/agent-write/users/user-1/suspend',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'agent-elevation:ael-1:1:2',
        ...headers,
      },
      body: JSON.stringify({ reason_code: 'security_incident' }),
    },
    {
      AGENT_ELEVATION_ENCRYPTION_KEY: encryptionKey,
      AGENT_ELEVATION_KEY_VERSION: 'v1',
    } as Env
  );
}

describe('agentElevatedExecutionMiddleware', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    repository.getElevationChallenge.mockResolvedValue({
      id: 'ael-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-2',
      actorSub: 'client:client-1',
      clientId: 'client-1',
      toolName: 'admin.write.users.suspend',
      toolSchemaVersion: '1',
      argsHash: await computeAgentElevationArgsHash({
        purpose: 'authrim-mcp-elevation-v1',
        tenant_id: 'tenant-1',
        grant_id: 'grant-1',
        delegator_id: 'admin-2',
        actor_sub: 'client:client-1',
        client_id: 'client-1',
        tool_name: 'admin.write.users.suspend',
        tool_schema_version: '1',
        args: { user_id: 'user-1', reason_code: 'security_incident' },
      }),
      status: 'executing',
      executionAttempt: 1,
      executionFence: 2,
      executionLeaseExpiresAt: Date.now() + 60_000,
    });
    repository.beginManagementExecution.mockResolvedValue(true);
    repository.completeManagementExecution.mockResolvedValue(true);
  });

  it('persists an encrypted target-side terminal result around the owner mutation', async () => {
    const { app, handler } = createApp();
    const response = await request(app);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(repository.beginManagementExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'agent-elevation:ael-1:1:2',
        operation: 'admin.write.users.suspend',
        executionAttempt: 1,
        executionFence: 2,
      })
    );
    const terminal = repository.completeManagementExecution.mock.calls[0][0];
    expect(terminal).toMatchObject({ status: 'succeeded' });
    expect(terminal.resultEnvelope).not.toContain('user-1');
    expect(JSON.parse(terminal.resultEnvelope)).toMatchObject({ v: 1, kid: 'v1' });
  });

  it('does not execute when the challenge fence does not match the Agent token', async () => {
    repository.getElevationChallenge.mockResolvedValue({
      ...(await repository.getElevationChallenge()),
      grantId: 'other-grant',
    });
    const { app, handler } = createApp();

    await expect(request(app)).resolves.toMatchObject({ status: 409 });
    expect(handler).not.toHaveBeenCalled();
    expect(repository.beginManagementExecution).not.toHaveBeenCalled();
  });

  it('does not execute when the target path or body differs from the approved arguments', async () => {
    const { app, handler } = createApp();
    const response = await app.request(
      '/api/admin/agent-write/users/user-2/suspend',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'agent-elevation:ael-1:1:2',
        },
        body: JSON.stringify({ reason_code: 'security_incident' }),
      },
      {
        AGENT_ELEVATION_ENCRYPTION_KEY: encryptionKey,
        AGENT_ELEVATION_KEY_VERSION: 'v1',
      } as Env
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'AGENT_ELEVATION_ARGUMENT_BINDING_MISMATCH',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(repository.beginManagementExecution).not.toHaveBeenCalled();
  });

  it('marks the HTTP result indeterminate when terminal persistence loses its fence', async () => {
    repository.completeManagementExecution.mockResolvedValue(false);
    const { app, handler } = createApp();
    const response = await request(app);

    expect(handler).toHaveBeenCalledOnce();
    expect(response.status).toBe(503);
    expect(response.headers.get('x-authrim-execution-indeterminate')).toBe('true');
  });

  it('fails before mutation when the dedicated encryption key is unavailable', async () => {
    const { app, handler } = createApp();
    const response = await app.request(
      '/api/admin/agent-write/users/user-1/suspend',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'agent-elevation:ael-1:1:2',
        },
        body: JSON.stringify({ reason_code: 'security_incident' }),
      },
      {} as Env
    );

    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    expect(repository.beginManagementExecution).not.toHaveBeenCalled();
  });
});
