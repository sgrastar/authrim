import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, ControlReadReplicationStatusView, Env } from '@authrim/ar-lib-core';

const audit = vi.hoisted(() => vi.fn());

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  };
});

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: audit }));

import { readReplicationRouter } from '../routes/admin-management/read-replication';

const status: ControlReadReplicationStatusView = {
  environmentId: 'test',
  desiredMode: 'disabled',
  aggregateStatus: 'off',
  operationId: null,
  operationStatus: null,
  eligiblePolicyCount: 4,
  convergedPolicyCount: 4,
  failedPolicyCount: 0,
  targetCount: 4,
  convergedTargetCount: 4,
  pendingTargetCount: 0,
  failedTargetCount: 0,
  updatedAt: 100,
};

function createApp(input?: {
  roles?: string[];
  actorType?: AdminAuthContext['actorType'];
  control?: Partial<NonNullable<Env['CONTROL']>>;
}) {
  const getReadReplicationStatus = vi.fn(async () => status);
  const startReadReplicationRollout = vi.fn(async () => ({
    ...status,
    desiredMode: 'enabled' as const,
    aggregateStatus: 'updating' as const,
    operationId: 'operation-1',
    operationStatus: 'applying' as const,
    pendingTargetCount: 4,
    convergedTargetCount: 0,
  }));
  const control = {
    getReadReplicationStatus,
    startReadReplicationRollout,
    ...input?.control,
  } as unknown as NonNullable<Env['CONTROL']>;
  const env = { CONTROL: control, AUTHRIM_ENVIRONMENT_NAME: 'test' } as unknown as Env;
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminAuth?: AdminAuthContext };
  }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      actorType: input?.actorType ?? 'human',
      roles: input?.roles ?? ['system_admin'],
      permissions: [],
    });
    await next();
  });
  app.route('/api/admin/platform/read-replication', readReplicationRouter);
  return { app, env, getReadReplicationStatus, startReadReplicationRollout };
}

describe('read replication admin router', () => {
  beforeEach(() => {
    audit.mockReset();
    audit.mockResolvedValue('audit-1');
  });

  it('returns environment aggregate status only to platform administrators', async () => {
    const allowed = createApp();
    const response = await allowed.app.request(
      '/api/admin/platform/read-replication',
      {},
      allowed.env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ readReplication: status });

    const denied = createApp({ roles: ['tenant_admin'] });
    const deniedResponse = await denied.app.request(
      '/api/admin/platform/read-replication',
      {},
      denied.env
    );
    expect(deniedResponse.status).toBe(403);
    expect(denied.getReadReplicationStatus).not.toHaveBeenCalled();
  });

  it('writes the audit request before invoking the narrow Control RPC', async () => {
    const { app, env, startReadReplicationRollout } = createApp();
    const response = await app.request(
      '/api/admin/platform/read-replication',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'read-replication-1',
        },
        body: JSON.stringify({ enabled: true }),
      },
      env
    );
    expect(response.status).toBe(202);
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'read_replication.rollout.requested',
        before: expect.objectContaining({ desired_mode: 'disabled' }),
        after: expect.objectContaining({ desired_mode: 'enabled' }),
      })
    );
    expect(startReadReplicationRollout).toHaveBeenCalledWith({
      desiredMode: 'enabled',
      idempotencyKey: 'read-replication-1',
      requestedById: 'admin-1',
    });
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(
      startReadReplicationRollout.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('fails closed before Control when audit persistence is unavailable', async () => {
    audit.mockResolvedValueOnce(null);
    const { app, env, startReadReplicationRollout } = createApp();
    const response = await app.request(
      '/api/admin/platform/read-replication',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'read-replication-2',
        },
        body: JSON.stringify({ enabled: false }),
      },
      env
    );
    expect(response.status).toBe(503);
    expect(startReadReplicationRollout).not.toHaveBeenCalled();
  });

  it('rejects non-human actors, extra fields, and missing Control capabilities', async () => {
    const machine = createApp({ actorType: 'machine' });
    const machineResponse = await machine.app.request(
      '/api/admin/platform/read-replication',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'read-replication-3',
        },
        body: JSON.stringify({ enabled: true }),
      },
      machine.env
    );
    expect(machineResponse.status).toBe(403);

    const malformed = createApp();
    const malformedResponse = await malformed.app.request(
      '/api/admin/platform/read-replication',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'read-replication-4',
        },
        body: JSON.stringify({
          enabled: true,
          providerToken: 'forbidden',
        }),
      },
      malformed.env
    );
    expect(malformedResponse.status).toBe(400);
    expect(audit).not.toHaveBeenCalled();

    const unavailable = createApp({
      control: {
        getReadReplicationStatus: undefined,
        startReadReplicationRollout: undefined,
      },
    });
    const unavailableResponse = await unavailable.app.request(
      '/api/admin/platform/read-replication',
      {},
      unavailable.env
    );
    expect(unavailableResponse.status).toBe(503);
  });

  it('maps an active rollout conflict without exposing Control internals', async () => {
    const { app, env } = createApp({
      control: {
        startReadReplicationRollout: vi.fn(async () => {
          throw new Error('read_replication_rollout_in_progress');
        }),
      },
    });
    const response = await app.request(
      '/api/admin/platform/read-replication',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'read-replication-5',
        },
        body: JSON.stringify({ enabled: true }),
      },
      env
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'READ_REPLICATION_ROLLOUT_IN_PROGRESS',
      error_description: 'READ_REPLICATION_ROLLOUT_IN_PROGRESS',
    });
  });

  it('maps an environment without eligible policies to a stable conflict', async () => {
    const { app, env } = createApp({
      control: {
        startReadReplicationRollout: vi.fn(async () => {
          throw new Error('read_replication_no_eligible_policies');
        }),
      },
    });
    const response = await app.request(
      '/api/admin/platform/read-replication',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'read-replication-no-policy',
        },
        body: JSON.stringify({ enabled: true }),
      },
      env
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'READ_REPLICATION_NO_ELIGIBLE_POLICIES',
      error_description: 'READ_REPLICATION_NO_ELIGIBLE_POLICIES',
    });
  });

  it('rejects malformed or secret-bearing Control status instead of proxying it', async () => {
    const wrongEnvironment = createApp({
      control: {
        getReadReplicationStatus: vi.fn(async () => ({
          ...status,
          environmentId: 'other',
        })),
      },
    });
    const wrongEnvironmentResponse = await wrongEnvironment.app.request(
      '/api/admin/platform/read-replication',
      {},
      wrongEnvironment.env
    );
    expect(wrongEnvironmentResponse.status).toBe(503);

    const secretBearing = createApp({
      control: {
        getReadReplicationStatus: vi.fn(async () => ({
          ...status,
          providerToken: 'secret-value',
        })) as NonNullable<Env['CONTROL']>['getReadReplicationStatus'],
      },
    });
    const secretResponse = await secretBearing.app.request(
      '/api/admin/platform/read-replication',
      {},
      secretBearing.env
    );
    expect(secretResponse.status).toBe(503);
    await expect(secretResponse.json()).resolves.toEqual({
      error: 'READ_REPLICATION_STATUS_UNAVAILABLE',
      error_description: 'READ_REPLICATION_STATUS_UNAVAILABLE',
    });
  });
});
